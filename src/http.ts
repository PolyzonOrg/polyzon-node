/**
 * One HTTP GET attempt over `node:http` / `node:https`: routing (direct, CONNECT tunnel or
 * absolute-form through a proxy), the per-attempt timeout, abort, and the body size cap.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { APIConnectionError, APITimeoutError } from './errors.js';
import { parseProxy, proxyFromEnv, TunnelAgent, type ProxyConfig } from './proxy.js';

/** Response bodies above this many bytes are rejected without buffering the rest. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** How requests reach the API: the pooled agent plus how a request is addressed. */
export interface Route {
  /** The connection pool. */
  readonly agent: http.Agent;
  /** Whether the SDK created the agent (and so may destroy it). */
  readonly owned: boolean;
  /** Starts a GET request; the caller ends it. */
  open(url: URL, headers: http.OutgoingHttpHeaders): http.ClientRequest;
}

/** Transport options of the client. */
export interface RouteOptions {
  proxy: string | URL | false | undefined;
  agent: http.Agent | undefined;
  ca: https.AgentOptions['ca'];
  maxConnections: number;
  timeout: number;
}

const direct = (agent: http.Agent, owned: boolean): Route => ({
  agent,
  owned,
  open: (url, headers) => (url.protocol === 'https:' ? https : http).request(url, { agent, headers }),
});

/**
 * Plain-http target through a proxy: absolute-form requests (`GET http://host/path`) to the
 * proxy over a pooled connection.
 */
function absoluteForm(proxy: ProxyConfig, options: RouteOptions): Route {
  const secure = proxy.url.protocol === 'https:';
  const pool = { keepAlive: true, maxSockets: options.maxConnections };
  const agent = secure ? new https.Agent({ ...pool, ca: options.ca }) : new http.Agent(pool);
  return {
    agent,
    owned: true,
    open: (url, headers) =>
      (secure ? https : http).request({
        host: proxy.url.hostname.replace(/^\[|\]$/g, ''),
        port: proxy.url.port || (secure ? 443 : 80),
        path: url.href,
        agent,
        headers: {
          ...headers,
          host: url.host,
          ...(proxy.authorization ? { 'proxy-authorization': proxy.authorization } : {}),
        },
      }),
  };
}

/**
 * Builds the route to `base`: the caller's `agent` as is; else an explicit `proxy`; else
 * the proxy environment (unless `proxy: false`); else a direct keep-alive pool.
 */
export function createRoute(base: URL, options: RouteOptions): Route {
  if (options.agent) return direct(options.agent, false);
  const proxy =
    options.proxy === false
      ? null
      : options.proxy === undefined
        ? proxyFromEnv(base)
        : parseProxy(options.proxy);
  const pool = { keepAlive: true, maxSockets: options.maxConnections };
  if (base.protocol === 'http:') {
    return proxy ? absoluteForm(proxy, options) : direct(new http.Agent(pool), true);
  }
  const agent = proxy
    ? new TunnelAgent(proxy, { ...pool, ca: options.ca, connectTimeout: options.timeout })
    : new https.Agent({ ...pool, ca: options.ca });
  return direct(agent, true);
}

/** A complete HTTP answer. `body` is `null` when it exceeded {@link MAX_BODY_BYTES}. */
export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | null;
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Sends one GET and reads the whole answer. Rejects with {@link APIConnectionError} or
 * {@link APITimeoutError} (the socket is destroyed), or with `signal.reason` on abort.
 * Redirects are not followed: a 3xx comes back like any other answer.
 */
export function send(
  route: Route,
  url: URL,
  headers: http.OutgoingHttpHeaders,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let request: http.ClientRequest | undefined;
    let settled = false;
    const finish = (error: unknown, response?: RawResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (response) {
        resolve(response);
      } else {
        request?.destroy();
        reject(error);
      }
    };
    const onAbort = (): void => {
      finish(signal?.reason);
    };
    const timer = setTimeout(() => {
      finish(new APITimeoutError(`Request timed out after ${timeout} ms.`));
    }, timeout);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      request = route.open(url, headers);
    } catch (error) {
      finish(new APIConnectionError(`Connection error: ${(error as Error).message}`, { cause: error }));
      return;
    }
    request.on('error', (error) => {
      finish(new APIConnectionError(`Connection error: ${error.message}`, { cause: error }));
    });
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      const responseHeaders = flatten(response.headers);
      const tooLarge = (): void => {
        // Answer now and drop the connection: the rest of the body is never read.
        finish(null, { status, headers: responseHeaders, body: null });
        request.destroy();
      };
      if (Number(response.headers['content-length']) > MAX_BODY_BYTES) {
        tooLarge();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) tooLarge();
        else chunks.push(chunk);
      });
      response.on('end', () => {
        finish(null, { status, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
      response.on('error', (error) => {
        finish(new APIConnectionError(`Connection error: ${error.message}`, { cause: error }));
      });
      response.on('close', () => {
        finish(new APIConnectionError('Connection error: the connection closed mid-response.'));
      });
    });
    request.end();
  });
}
