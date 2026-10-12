/**
 * Errors thrown by the SDK. Everything the SDK throws for a failed request is a
 * {@link PolyzonError}; invalid arguments throw the standard `TypeError` / `RangeError`,
 * and an aborted request rejects with the `AbortSignal`'s reason.
 */

/** Sets a non-enumerable `name` on the prototype, so instances print as `NotFoundError: …`. */
function named(target: abstract new (...args: never[]) => Error, name: string): void {
  Object.defineProperty(target.prototype, 'name', {
    value: name,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** Base class of every error the SDK throws for a failed request. */
export class PolyzonError extends Error {
  static {
    named(this, 'PolyzonError');
  }
}

/** The request did not get an HTTP answer: DNS, TCP, TLS or proxy failure, connection reset. */
export class APIConnectionError extends PolyzonError {
  static {
    named(this, 'APIConnectionError');
  }

  /**
   * @param message What failed.
   * @param options `cause` — the underlying Node.js error, if any.
   */
  constructor(message = 'Connection error.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The request attempt did not finish within the timeout. */
export class APITimeoutError extends APIConnectionError {
  static {
    named(this, 'APITimeoutError');
  }

  /** @param message What timed out. */
  constructor(message = 'Request timed out.') {
    super(message);
  }
}

/** The server answered 2xx, but the body is not a JSON object or exceeds the 8 MiB cap. */
export class InvalidResponseError extends PolyzonError {
  static {
    named(this, 'InvalidResponseError');
  }

  /** HTTP status of the response. */
  readonly status: number;
  /** `X-Request-ID` of the response, or `null`. */
  readonly requestId: string | null;

  /**
   * @param message What is wrong with the response.
   * @param status HTTP status of the response.
   * @param requestId `X-Request-ID` of the response, or `null`.
   * @param options `cause` — the underlying parse error, if any.
   */
  constructor(message: string, status: number, requestId: string | null, options?: { cause?: unknown }) {
    super(requestId ? `${message} (request id ${requestId})` : message, options);
    this.status = status;
    this.requestId = requestId;
  }
}

/** Removes control characters and caps the length of server text placed into messages. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

/**
 * `Retry-After` header → seconds: delay-seconds or an HTTP date. `null` when absent or
 * unparsable.
 */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // Every HTTP-date format starts with the day name ("Sun, 06 Nov 1994 08:49:37 GMT").
  const date = /^[a-z]{3}/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * The server answered with an HTTP error. Subclasses tell the cases apart; `code` is the
 * stable machine-readable reason from the `application/problem+json` body.
 */
export class APIError extends PolyzonError {
  static {
    named(this, 'APIError');
  }

  /** HTTP status. */
  readonly status: number;
  /** Stable error code, e.g. `invalid_token`; `null` when the body is not a problem document. */
  readonly code: string | null;
  /** Short title of the problem, e.g. `Too Many Requests`; `null` when absent. */
  readonly title: string | null;
  /** Human-readable explanation (usually Russian); `HTTP <status>` when absent. */
  readonly detail: string;
  /** The query parameter at fault (`bad_request`), or `null`. */
  readonly param: string | null;
  /** `X-Request-ID` of the response — quote it when contacting support. `null` when absent. */
  readonly requestId: string | null;
  /** Seconds to wait from the `Retry-After` header, or `null` when absent. */
  readonly retryAfter: number | null;
  /** Response headers, lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON object of the body, or `null` when it is not JSON (e.g. an HTML error page). */
  readonly body: Readonly<Record<string, unknown>> | null;

  /**
   * @param status HTTP status.
   * @param body Parsed JSON body (problem document), or `null`.
   * @param headers Response headers with lower-case names.
   */
  constructor(
    status: number,
    body: Readonly<Record<string, unknown>> | null,
    headers: Readonly<Record<string, string>> = {},
  ) {
    const field = (name: string): string | null =>
      typeof body?.[name] === 'string' && body[name] !== '' ? body[name] : null;
    const code = field('code');
    const detail = field('detail') ?? `HTTP ${status}`;
    const requestId = headers['x-request-id'] ?? null;
    super(
      `${status}${code ? ` ${clean(code)}` : ''}: ${clean(detail)}` +
        (requestId ? ` (request id ${clean(requestId)})` : ''),
    );
    this.status = status;
    this.code = code;
    this.title = field('title');
    this.detail = detail;
    this.param = field('param');
    this.requestId = requestId;
    this.retryAfter = parseRetryAfter(headers['retry-after']);
    this.headers = headers;
    this.body = body;
  }
}

/** 400: invalid parameter (`bad_request`, see `param`) or page too deep (`page_too_deep`). */
export class BadRequestError extends APIError {
  static {
    named(this, 'BadRequestError');
  }
}

/** 401: no token (`unauthorized`) or the token is wrong or revoked (`invalid_token`). */
export class AuthenticationError extends APIError {
  static {
    named(this, 'AuthenticationError');
  }
}

/**
 * 403 `account_action_required`: the token owner must accept the current terms at
 * https://polyzon.org/account/.
 */
export class PermissionDeniedError extends APIError {
  static {
    named(this, 'PermissionDeniedError');
  }
}

/** 404 `not_found`: no such model (or method). */
export class NotFoundError extends APIError {
  static {
    named(this, 'NotFoundError');
  }
}

/**
 * 410 `gone`: the model was removed at the right holder's request. If you stored it,
 * delete it too.
 */
export class GoneError extends APIError {
  static {
    named(this, 'GoneError');
  }
}

/** 429: too many requests. `rate_limited` (per-minute window) is retried automatically. */
export class RateLimitError extends APIError {
  static {
    named(this, 'RateLimitError');
  }
}

/** 429 `quota_exceeded`: the daily quota is spent; it resets at 00:00 UTC. Never retried. */
export class QuotaExceededError extends RateLimitError {
  static {
    named(this, 'QuotaExceededError');
  }
}

/** 5xx: the server or the catalog failed (`unavailable`, `internal`, …). Retried automatically. */
export class InternalServerError extends APIError {
  static {
    named(this, 'InternalServerError');
  }
}

/** The {@link APIError} subclass for an HTTP error answer. */
export function apiErrorFor(
  status: number,
  body: Readonly<Record<string, unknown>> | null,
  headers: Readonly<Record<string, string>>,
): APIError {
  switch (status) {
    case 400:
      return new BadRequestError(status, body, headers);
    case 401:
      return new AuthenticationError(status, body, headers);
    case 403:
      return new PermissionDeniedError(status, body, headers);
    case 404:
      return new NotFoundError(status, body, headers);
    case 410:
      return new GoneError(status, body, headers);
    case 429:
      return body?.code === 'quota_exceeded'
        ? new QuotaExceededError(status, body, headers)
        : new RateLimitError(status, body, headers);
    default:
      return status >= 500
        ? new InternalServerError(status, body, headers)
        : new APIError(status, body, headers);
  }
}
