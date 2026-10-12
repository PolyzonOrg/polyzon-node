import type * as http from 'node:http';
import type * as https from 'node:https';
import { inspect } from 'node:util';
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  InvalidResponseError,
  PermissionDeniedError,
  QuotaExceededError,
  apiErrorFor,
  type PolyzonError,
} from './errors.js';
import { createRoute, send, type RawResponse, type Route } from './http.js';
import { object, parseLimits, parseMe, parseModel, parseSearchPage, type Json } from './parse.js';
import type {
  Lang,
  Limits,
  Me,
  Model,
  ModelParams,
  ModelRef,
  ResponseMeta,
  SearchItem,
  SearchPage,
  SearchParams,
  Source,
  WithMeta,
} from './types.js';
import { VERSION } from './version.js';

/** Default API origin. */
const DEFAULT_BASE_URL = 'https://api.polyzon.org';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_CONCURRENCY = 4;
/** Longest `Retry-After` the client waits for; a longer one is raised at once. */
const MAX_RETRY_AFTER_SECONDS = 60;
/** The server serves at most this many pages. */
const MAX_PAGE = 100;
const MAX_TIMER = 2_147_483_647;

const SOURCE_RE = /^[a-z0-9]{1,32}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,255}$/;
const TOKEN_RE = /^[\x21-\x7E]{1,512}$/;
const USER_AGENT_RE = /^[\x20-\x7E]{1,256}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Receives debug lines (each attempt) and warnings (retries). `console` fits. */
export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

/** Options of {@link Polyzon}. */
export interface ClientOptions {
  /** API token (`pzk_…`). Default: the `POLYZON_API_KEY` environment variable. */
  apiKey?: string | undefined;
  /**
   * API origin. Default: `POLYZON_BASE_URL`, else `https://api.polyzon.org`. Must be
   * `https://`; `http://` only for `localhost`, `127.0.0.1` and `[::1]`.
   */
  baseURL?: string | undefined;
  /** Time limit of one attempt (connect + answer), milliseconds. Default 30 000. */
  timeout?: number | undefined;
  /** Retries of a failed request (connection errors, 5xx, `rate_limited`). Default 2. */
  maxRetries?: number | undefined;
  /**
   * Proxy URL `http://[user:pass@]host:port` or `https://…`. `undefined` — use the
   * `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` environment variables; `false` — no proxy.
   * HTTPS targets are reached through a CONNECT tunnel: the proxy never sees the token.
   */
  proxy?: string | URL | false | undefined;
  /**
   * Your own `http.Agent` / `https.Agent` (e.g. `socks-proxy-agent`, mTLS). It replaces
   * the SDK's pool, so it cannot be combined with `proxy`, `ca` or `maxConnections`.
   */
  agent?: http.Agent | undefined;
  /** Extra trusted CA certificates (PEM), e.g. of a TLS-inspecting corporate proxy. */
  ca?: https.AgentOptions['ca'] | undefined;
  /** Size of the keep-alive connection pool. Default 10. */
  maxConnections?: number | undefined;
  /** Appended to the default `User-Agent`, e.g. `my-bot/2.1`. */
  userAgent?: string | undefined;
  /** Gets debug lines and retry warnings. Never gets headers or the token. */
  logger?: Logger | undefined;
}

/** Options of {@link Polyzon.withOptions}: everything that does not shape the connection pool. */
export type DerivedClientOptions = Pick<
  ClientOptions,
  'apiKey' | 'timeout' | 'maxRetries' | 'userAgent' | 'logger'
>;

/** Per-call options. */
export interface RequestOptions {
  /** Aborts the call (including retry waits); it rejects with `signal.reason`. */
  signal?: AbortSignal | undefined;
  /** Overrides the client's per-attempt timeout, milliseconds. */
  timeout?: number | undefined;
  /** Overrides the client's `maxRetries`. */
  maxRetries?: number | undefined;
}

/** Parameters of {@link Polyzon.getModels}. */
export interface GetModelsParams {
  /** Requests in flight at most. Default 4. */
  concurrency?: number | undefined;
  /** Language of titles, descriptions and tags. */
  lang?: Lang | undefined;
}

/** Outcome of one reference in {@link Polyzon.getModels}: the model or the error. */
export type ModelResult =
  | {
      readonly source: Source;
      readonly id: string;
      readonly model: WithMeta<Model>;
      readonly error?: undefined;
    }
  | { readonly source: Source; readonly id: string; readonly model?: undefined; readonly error: Error };

/** Sleeps `ms`, rejecting with `signal.reason` on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Test seam: the retry sleep and the jitter source. Not part of the public API.
 * @internal
 */
export const hooks = { sleep, random: Math.random };

function positiveInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  if (value < 1 || value > max) throw new RangeError(`${name} must be between 1 and ${max}`);
  return value;
}

function retries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError('maxRetries must be an integer');
  }
  if (value < 0) throw new RangeError('maxRetries must not be negative');
  return value;
}

function checkApiKey(value: unknown): string {
  if (value === undefined || value === '') {
    throw new TypeError(
      'Missing API key: pass { apiKey } or set POLYZON_API_KEY. Get a token at https://polyzon.org/account/',
    );
  }
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    // Never echo the value: it is a secret.
    throw new TypeError('apiKey must be 1..512 visible ASCII characters (no spaces or line breaks)');
  }
  return value;
}

function checkBaseURL(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('baseURL must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('baseURL must be an absolute URL');
  }
  if (url.username || url.password) throw new TypeError('baseURL must not contain credentials');
  if (/[?#]/.test(url.href)) throw new TypeError('baseURL must not contain a query or fragment');
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new TypeError('baseURL must use https:// (http:// is allowed only for localhost)');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function checkUserAgent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !USER_AGENT_RE.test(value)) {
    throw new TypeError('userAgent must be 1..256 printable ASCII characters');
  }
  return value;
}

/** Joins a list parameter: `['a', 'b']` → `a,b`; `null` when empty. */
function list(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  const joined = typeof value === 'string' ? value : value.join(',');
  return joined === '' ? null : joined;
}

function pageNumber(value: unknown, name: string): string | null {
  return value === undefined ? null : String(positiveInteger(value, name));
}

/** Query string of `GET /v1/search`; validates `params`. Unset parameters are omitted. */
function searchQuery(params: SearchParams): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards JavaScript callers
  if (typeof params !== 'object' || params === null) throw new TypeError('search params must be an object');
  if (typeof params.q !== 'string' || params.q.trim() === '') {
    throw new TypeError('q must be a non-empty string');
  }
  const query = new URLSearchParams({ q: params.q });
  const optional: [string, string | null][] = [
    ['page', pageNumber(params.page, 'page')],
    ['size', pageNumber(params.size, 'size')],
    ['sort', params.sort ?? null],
    ['free', params.free === true ? '1' : null],
    ['sources', list(params.sources)],
    ['formats', list(params.formats)],
    ['license', list(params.license)],
    ['lang', params.lang ?? null],
  ];
  for (const [name, value] of optional) if (value !== null && value !== '') query.set(name, value);
  return query.toString();
}

function langQuery(lang: unknown): string {
  if (lang === undefined) return '';
  if (typeof lang !== 'string' || lang === '') throw new TypeError('lang must be a non-empty string');
  return `?${new URLSearchParams({ lang }).toString()}`;
}

function modelPath(source: unknown, id: unknown): string {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    throw new TypeError('source must match /^[a-z0-9]{1,32}$/');
  }
  // `.` and `..` would be normalised away by URL handling: a path traversal.
  if (typeof id !== 'string' || !ID_RE.test(id) || id === '.' || id === '..') {
    throw new TypeError('id must match /^[A-Za-z0-9._-]{1,255}$/ and not be "." or ".."');
  }
  return `/v1/models/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
}

function mask(key: string): string {
  return `${key.slice(0, Math.min(8, Math.floor(key.length / 2)))}…`;
}

function withMeta<T extends object>(value: T, meta: ResponseMeta): WithMeta<T> {
  Object.defineProperty(value, 'meta', { value: meta, enumerable: false });
  return value as WithMeta<T>;
}

function metaOf(response: RawResponse): ResponseMeta {
  const header = (name: string): number | null => {
    const value = response.headers[name]?.trim();
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  const limit = header('x-ratelimit-limit');
  const remaining = header('x-ratelimit-remaining');
  const resetAt = header('x-ratelimit-reset');
  return {
    requestId: response.headers['x-request-id'] ?? null,
    rateLimit:
      limit !== null && remaining !== null && resetAt !== null ? { limit, remaining, resetAt } : null,
  };
}

function parseJson(body: Buffer | null): Json | null {
  if (!body) return null;
  try {
    return object(JSON.parse(body.toString('utf8')));
  } catch {
    return null;
  }
}

/** Delay before the next attempt in milliseconds, or `null` when `error` is final. */
function retryDelay(error: PolyzonError, attempt: number): number | null {
  if (error instanceof APIError) {
    const retryable =
      [500, 502, 503, 504].includes(error.status) || (error.status === 429 && error.code === 'rate_limited');
    if (!retryable) return null;
    if (error.retryAfter !== null) {
      return error.retryAfter > MAX_RETRY_AFTER_SECONDS ? null : error.retryAfter * 1000;
    }
  }
  return Math.min(8000, 500 * 2 ** attempt) * (0.5 + hooks.random() * 0.5);
}

/** Errors after which the remaining refs of `getModels` would fail the same way. */
const isFatal = (error: unknown): boolean =>
  error instanceof AuthenticationError ||
  error instanceof PermissionDeniedError ||
  error instanceof QuotaExceededError;

/**
 * Client of the Polyzon public API (https://api.polyzon.org).
 *
 * Immutable and safe for concurrent use: share one instance across your app. Requests use a
 * keep-alive connection pool; call {@link Polyzon.close} on shutdown to drop idle sockets.
 *
 * @example
 * ```ts
 * import Polyzon from 'polyzon';
 * const client = new Polyzon(); // reads POLYZON_API_KEY
 * const page = await client.search({ q: 'дракон', size: 10 });
 * ```
 */
export class Polyzon {
  /** API origin requests go to, without a trailing slash. */
  readonly baseURL: string;
  /** Per-attempt timeout, milliseconds. */
  readonly timeout: number;
  /** Retries of a failed request. */
  readonly maxRetries: number;
  readonly #apiKey: string;
  readonly #route: Route;
  readonly #userAgent: string | undefined;
  readonly #logger: Logger | undefined;
  readonly #headers: Readonly<Record<string, string>>;

  /**
   * @param options Client options; every one is optional.
   * @throws TypeError | RangeError on an invalid option (the token is never echoed).
   */
  constructor(options?: ClientOptions);
  /** @internal Shares `route` (the connection pool) with the client that derived this one. */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- this overload is stripped from the typings
  constructor(options: ClientOptions, route: Route);
  constructor(options: ClientOptions = {}, route?: Route) {
    const env = process.env;
    this.#apiKey = checkApiKey(options.apiKey ?? env.POLYZON_API_KEY);
    this.baseURL = checkBaseURL(options.baseURL ?? (env.POLYZON_BASE_URL || DEFAULT_BASE_URL));
    this.timeout = positiveInteger(options.timeout ?? DEFAULT_TIMEOUT, 'timeout', MAX_TIMER);
    this.maxRetries = retries(options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.#userAgent = checkUserAgent(options.userAgent);
    this.#logger = options.logger;
    if (route) {
      this.#route = route;
    } else {
      if (options.agent && (options.proxy !== undefined || options.ca || options.maxConnections)) {
        throw new TypeError('agent cannot be combined with proxy, ca or maxConnections');
      }
      this.#route = createRoute(new URL(this.baseURL), {
        proxy: options.proxy,
        agent: options.agent,
        ca: options.ca,
        maxConnections: positiveInteger(
          options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          'maxConnections',
          1000,
        ),
        timeout: this.timeout,
      });
    }
    const runtime = `node ${process.versions.node}; ${process.platform}/${process.arch}`;
    this.#headers = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: 'application/json',
      'user-agent': `polyzon-node/${VERSION} (${runtime})${this.#userAgent ? ` ${this.#userAgent}` : ''}`,
    };
  }

  /**
   * A client with some options changed that shares this client's connection pool (and so
   * its proxy, CA and pool size). Closing either client closes the shared pool.
   *
   * @param options Options to override; the rest are inherited.
   */
  withOptions(options: DerivedClientOptions): Polyzon {
    return new Polyzon(
      {
        apiKey: this.#apiKey,
        baseURL: this.baseURL,
        timeout: this.timeout,
        maxRetries: this.maxRetries,
        userAgent: this.#userAgent,
        logger: this.#logger,
        ...options,
      },
      this.#route,
    );
  }

  /**
   * Searches the catalog: one page of results. Costs one request of the daily quota (even
   * when the server rejects the parameters).
   *
   * @param params Query and filters; `q` is required.
   * @param options Per-call options.
   * @throws TypeError on invalid params (before any request); {@link PolyzonError} subclasses.
   */
  async search(params: SearchParams, options?: RequestOptions): Promise<WithMeta<SearchPage>> {
    const { body, meta } = await this.#get(`/v1/search?${searchQuery(params)}`, options);
    return withMeta(parseSearchPage(body), meta);
  }

  /**
   * Walks search results page by page, starting at `params.page` (default 1), until
   * `hasMore` is false, a page is empty, or page 100 (the server's limit). Pages are
   * fetched lazily as you iterate; each page costs one request of the daily quota.
   *
   * @param params Query and filters; `size` up to 50 means fewer requests.
   * @param options Per-call options, applied to every page.
   * @throws TypeError at once on invalid params; request errors are thrown while iterating.
   */
  searchAll(params: SearchParams, options?: RequestOptions): AsyncIterable<SearchItem> {
    searchQuery(params);
    return this.#walk(params, options);
  }

  async *#walk(params: SearchParams, options: RequestOptions | undefined): AsyncGenerator<SearchItem> {
    for (let page = params.page ?? 1; ; page++) {
      const result = await this.search({ ...params, page }, options);
      yield* result.items;
      if (!result.hasMore || result.items.length === 0 || page >= MAX_PAGE) return;
    }
  }

  /**
   * One model card. Costs one request of the daily quota.
   *
   * @param source Source id, e.g. `thingiverse` (as in search items).
   * @param id Model id, e.g. `tv-1234567` (as in search items).
   * @param params `lang` of the title, description and tags.
   * @param options Per-call options.
   * @throws TypeError on an invalid source / id (before any request); {@link NotFoundError},
   *   {@link GoneError} (removed at the right holder's request — delete your copy) and the
   *   other {@link PolyzonError} subclasses.
   */
  async getModel(
    source: Source,
    id: string,
    params: ModelParams = {},
    options?: RequestOptions,
  ): Promise<WithMeta<Model>> {
    const { body, meta } = await this.#get(modelPath(source, id) + langQuery(params.lang), options);
    return withMeta(parseModel(body), meta);
  }

  /**
   * Fetches many models with bounded parallelism. Never rejects for a failed model: each
   * result holds the model or the error, in the order of `refs`. After an
   * {@link AuthenticationError}, {@link PermissionDeniedError} or {@link QuotaExceededError}
   * the refs not yet started get the same error without a request. Each model costs one
   * request of the daily quota.
   *
   * @param refs Models to fetch, e.g. search items.
   * @param params `concurrency` (default 4) and `lang`.
   * @param options Per-call options for every request; aborting rejects the whole call.
   * @throws TypeError | RangeError on an invalid `refs` or `concurrency`.
   */
  async getModels(
    refs: Iterable<ModelRef>,
    params: GetModelsParams = {},
    options?: RequestOptions,
  ): Promise<ModelResult[]> {
    const items = Array.from(refs, (ref) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards JavaScript callers
      if (typeof ref !== 'object' || ref === null) throw new TypeError('each ref must be { source, id }');
      return { source: ref.source, id: ref.id };
    });
    const concurrency = positiveInteger(params.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
    const lang = params.lang;
    const results: ModelResult[] = new Array<ModelResult>(items.length);
    let next = 0;
    let fatal: Error | null = null;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next++;
        const { source, id } = items[index] as ModelRef;
        if (fatal) {
          results[index] = { source, id, error: fatal };
          continue;
        }
        try {
          results[index] = { source, id, model: await this.getModel(source, id, { lang }, options) };
        } catch (error) {
          if (options?.signal?.aborted) throw options.signal.reason;
          if (isFatal(error)) fatal ??= error as Error;
          results[index] = { source, id, error: error as Error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  /**
   * The account and the token of this client. Does not cost daily quota.
   *
   * @param options Per-call options.
   */
  async me(options?: RequestOptions): Promise<WithMeta<Me>> {
    const { body, meta } = await this.#get('/v1/me', options);
    return withMeta(parseMe(body), meta);
  }

  /**
   * Remaining quota: the per-minute window and the UTC day. Does not cost daily quota.
   *
   * @param options Per-call options.
   */
  async limits(options?: RequestOptions): Promise<WithMeta<Limits>> {
    const { body, meta } = await this.#get('/v1/limits', options);
    return withMeta(parseLimits(body), meta);
  }

  /**
   * Destroys the pooled sockets. Idle sockets do not keep the process alive, so this is
   * optional; a later request opens new connections. A custom `agent` is left alone.
   */
  close(): void {
    if (this.#route.owned) this.#route.agent.destroy();
  }

  /** Masked view for `console.log` / `util.inspect`: the token shows as `pzk_Q7xR…`. */
  [inspect.custom](): string {
    return `Polyzon { baseURL: '${this.baseURL}', apiKey: '${mask(this.#apiKey)}' }`;
  }

  /** Masked view for `JSON.stringify`. */
  toJSON(): { baseURL: string; apiKey: string; timeout: number; maxRetries: number } {
    return {
      baseURL: this.baseURL,
      apiKey: mask(this.#apiKey),
      timeout: this.timeout,
      maxRetries: this.maxRetries,
    };
  }

  /** GET with retries; resolves with the JSON object body and its metadata. */
  async #get(path: string, options: RequestOptions = {}): Promise<{ body: Json; meta: ResponseMeta }> {
    const timeout = positiveInteger(options.timeout ?? this.timeout, 'timeout', MAX_TIMER);
    const maxRetries = retries(options.maxRetries ?? this.maxRetries);
    const { signal } = options;
    const url = new URL(this.baseURL + path);
    for (let attempt = 0; ; attempt++) {
      let failure: PolyzonError;
      const started = Date.now();
      try {
        const response = await send(this.#route, url, this.#headers, timeout, signal);
        this.#logger?.debug(
          `polyzon: GET ${path} -> ${response.status} in ${Date.now() - started} ms (attempt ${attempt + 1})`,
        );
        if (response.status >= 200 && response.status < 300) return this.#success(response);
        failure = apiErrorFor(response.status, parseJson(response.body), response.headers);
      } catch (error) {
        if (!(error instanceof APIConnectionError)) throw error;
        failure = error;
      }
      const delay = retryDelay(failure, attempt);
      if (attempt >= maxRetries || delay === null) throw failure;
      this.#logger?.warn(
        `polyzon: GET ${path} failed (${failure.message}); retry ${attempt + 1} of ${maxRetries} in ${Math.round(delay)} ms`,
      );
      await hooks.sleep(delay, signal);
    }
  }

  #success(response: RawResponse): { body: Json; meta: ResponseMeta } {
    const meta = metaOf(response);
    if (!response.body) {
      throw new InvalidResponseError('Response body exceeds 8 MiB', response.status, meta.requestId);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch (error) {
      throw new InvalidResponseError('Response body is not valid JSON', response.status, meta.requestId, {
        cause: error,
      });
    }
    const body = object(parsed);
    if (!body) {
      throw new InvalidResponseError('Response body is not a JSON object', response.status, meta.requestId);
    }
    return { body, meta };
  }
}
