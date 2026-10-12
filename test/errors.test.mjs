import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { inspect } from 'node:util';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  GoneError,
  InternalServerError,
  InvalidResponseError,
  NotFoundError,
  PermissionDeniedError,
  PolyzonError,
  QuotaExceededError,
  RateLimitError,
} from '../dist/index.js';
import { parseRetryAfter } from '../dist/errors.js';
import { clientFor, instantRetries, json, problem, startServer, TOKEN } from './helpers.mjs';

let server;
let reply;
before(async () => {
  instantRetries();
  server = await startServer((req, res) => reply(req, res));
});
afterEach(() => {
  server.requests.length = 0;
});
after(() => server.close());

const noRetry = () => clientFor(server, { maxRetries: 0 });

describe('class hierarchy', () => {
  const chain = [
    [APIConnectionError, [PolyzonError, Error]],
    [APITimeoutError, [APIConnectionError, PolyzonError]],
    [InvalidResponseError, [PolyzonError]],
    [APIError, [PolyzonError]],
    [BadRequestError, [APIError, PolyzonError]],
    [AuthenticationError, [APIError]],
    [PermissionDeniedError, [APIError]],
    [NotFoundError, [APIError]],
    [GoneError, [APIError]],
    [RateLimitError, [APIError]],
    [QuotaExceededError, [RateLimitError, APIError, PolyzonError]],
    [InternalServerError, [APIError]],
  ];
  for (const [cls, parents] of chain) {
    test(`${cls.name}: name and instanceof`, () => {
      const error =
        cls.prototype instanceof APIError || cls === APIError
          ? new cls(400, null, {})
          : cls === InvalidResponseError
            ? new cls('x', 200, null)
            : new cls();
      assert.equal(error.name, cls.name);
      assert.ok(error instanceof cls);
      for (const parent of parents) assert.ok(error instanceof parent);
      assert.ok(!Object.keys(error).includes('name'), 'name is not an own enumerable field');
      assert.ok(String(error).startsWith(`${cls.name}: `));
    });
  }

  test('connection errors carry their cause', () => {
    const cause = new Error('ECONNRESET');
    assert.equal(new APIConnectionError('x', { cause }).cause, cause);
    assert.equal(new APITimeoutError().message, 'Request timed out.');
    assert.equal(new APIConnectionError().message, 'Connection error.');
  });
});

describe('status → error class', () => {
  const cases = [
    [400, 'bad_request', BadRequestError],
    [400, 'page_too_deep', BadRequestError],
    [401, 'unauthorized', AuthenticationError],
    [401, 'invalid_token', AuthenticationError],
    [403, 'account_action_required', PermissionDeniedError],
    [404, 'not_found', NotFoundError],
    [410, 'gone', GoneError],
    [429, 'rate_limited', RateLimitError],
    [429, 'quota_exceeded', QuotaExceededError],
    [500, 'internal', InternalServerError],
    [503, 'unavailable', InternalServerError],
    [599, 'whatever', InternalServerError],
    [418, 'teapot', APIError],
    [422, 'unprocessable', APIError],
  ];
  for (const [status, code, cls] of cases) {
    test(`${status} ${code} → ${cls.name}`, async () => {
      reply = (req, res) => problem(res, status, code, 'Подробности.');
      await assert.rejects(noRetry().me(), (error) => {
        assert.equal(error.constructor, cls);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.detail, 'Подробности.');
        return true;
      });
      assert.equal(server.requests.length, 1);
    });
  }
});

describe('problem details', () => {
  test('all fields, headers and the message format', async () => {
    reply = (req, res) =>
      problem(
        res,
        400,
        'bad_request',
        'size must be between 1 and 50',
        { 'x-request-id': 'abc-1' },
        { param: 'size' },
      );
    await assert.rejects(noRetry().search({ q: 'x', size: 99 }), (error) => {
      assert.ok(error instanceof BadRequestError);
      assert.equal(error.message, '400 bad_request: size must be between 1 and 50 (request id abc-1)');
      assert.equal(error.title, 'Bad Request');
      assert.equal(error.param, 'size');
      assert.equal(error.requestId, 'abc-1');
      assert.equal(error.retryAfter, null);
      assert.equal(error.headers['content-type'], 'application/problem+json; charset=utf-8');
      assert.deepEqual(error.body, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'bad_request',
        detail: 'size must be between 1 and 50',
        param: 'size',
      });
      return true;
    });
  });

  test('401 with Russian detail; the token never appears', async () => {
    reply = (req, res) =>
      problem(res, 401, 'invalid_token', 'Токен не найден или отозван.', { 'www-authenticate': 'Bearer' });
    await assert.rejects(noRetry().me(), (error) => {
      assert.equal(error.message, '401 invalid_token: Токен не найден или отозван. (request id req-err)');
      assert.equal(error.headers['www-authenticate'], 'Bearer');
      assert.ok(!inspect(error, { depth: 10 }).includes(TOKEN));
      assert.ok(!JSON.stringify(error).includes(TOKEN));
      return true;
    });
  });

  test('429 quota_exceeded exposes Retry-After and the daily window', async () => {
    reply = (req, res) =>
      problem(res, 429, 'quota_exceeded', 'Суточная квота 200 запросов исчерпана; сброс в 00:00 UTC.', {
        'retry-after': '3600',
        'x-ratelimit-limit': '200',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1791590400',
      });
    await assert.rejects(noRetry().search({ q: 'x' }), (error) => {
      assert.ok(error instanceof QuotaExceededError);
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfter, 3600);
      assert.equal(error.headers['x-ratelimit-remaining'], '0');
      return true;
    });
  });

  test('non-problem bodies (HTML 502 from the edge) map by status without the HTML', async () => {
    reply = (req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html><body><h1>502 Bad Gateway</h1><script>x</script></body></html>');
    };
    await assert.rejects(noRetry().me(), (error) => {
      assert.ok(error instanceof InternalServerError);
      assert.equal(error.code, null);
      assert.equal(error.title, null);
      assert.equal(error.detail, 'HTTP 502');
      assert.equal(error.body, null);
      assert.equal(error.requestId, null);
      assert.equal(error.message, '502: HTTP 502');
      return true;
    });
  });

  test('JSON that is not a problem document: code null, detail HTTP <status>', async () => {
    reply = (req, res) => json(res, 404, { error: 'nope', code: 5 });
    await assert.rejects(noRetry().me(), (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, null);
      assert.equal(error.detail, 'HTTP 404');
      assert.deepEqual(error.body, { error: 'nope', code: 5 });
      return true;
    });
  });

  test('control characters in server text are flattened in the message', async () => {
    reply = (req, res) => problem(res, 400, 'bad\nrequest', `line1\r\nline2\u001b[31m${'x'.repeat(600)}`);
    await assert.rejects(noRetry().me(), (error) => {
      assert.ok(!/[\r\n]/.test(error.message) && !error.message.includes('\u001b'));
      assert.ok(error.message.length < 600);
      assert.ok(error.detail.includes('\n'), 'the field keeps the original text');
      return true;
    });
  });
});

describe('redirects are never followed', () => {
  test('302 surfaces as APIError and the other origin gets nothing', async () => {
    const other = await startServer((req, res) => json(res, 200, {}));
    try {
      reply = (req, res) => {
        res.writeHead(302, { location: `${other.url}/v1/me` });
        res.end();
      };
      await assert.rejects(noRetry().me(), (error) => {
        assert.equal(error.constructor, APIError);
        assert.equal(error.status, 302);
        assert.equal(error.headers.location, `${other.url}/v1/me`);
        return true;
      });
      assert.equal(server.requests.length, 1);
      assert.equal(other.requests.length, 0);
    } finally {
      await other.close();
    }
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  test('seconds', () => {
    assert.equal(parseRetryAfter('5', now), 5);
    assert.equal(parseRetryAfter(' 60 ', now), 60);
    assert.equal(parseRetryAfter('1.5', now), 1.5);
    assert.equal(parseRetryAfter('0', now), 0);
  });
  test('HTTP date', () => {
    assert.equal(parseRetryAfter('Sun, 11 Oct 2026 12:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Sun, 11 Oct 2026 11:00:00 GMT', now), 0);
  });
  test('absent or garbage', () => {
    assert.equal(parseRetryAfter(undefined, now), null);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(parseRetryAfter('-5', now), null);
  });
});

describe('8 MiB body cap', () => {
  const MiB = 1024 * 1024;

  test('a 2xx body over 8 MiB → InvalidResponseError', async () => {
    reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(8 * MiB + 1, 0x20));
    };
    await assert.rejects(noRetry().me(), (error) => {
      assert.ok(error instanceof InvalidResponseError);
      assert.match(error.message, /8 MiB/);
      return true;
    });
  });

  test('an endless body is cut off at the cap instead of being buffered', async () => {
    let sent = 0;
    reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(256 * 1024, 0x20);
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) sent += chunk.length;
        if (!res.destroyed) res.once('drain', pump);
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
    };
    await assert.rejects(clientFor(server, { maxRetries: 0, timeout: 20_000 }).me(), InvalidResponseError);
    assert.ok(sent < 64 * MiB, `server pushed ${sent} bytes`);
  });

  test('a Content-Length over the cap fails before reading the body', async () => {
    reply = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(9 * MiB) });
      res.write('{');
    };
    await assert.rejects(clientFor(server, { maxRetries: 0, timeout: 20_000 }).me(), InvalidResponseError);
  });

  test('an oversized error body still maps by status, with body null', async () => {
    reply = (req, res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(Buffer.alloc(8 * MiB + 10, 0x20));
    };
    await assert.rejects(noRetry().me(), (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.body, null);
      assert.equal(error.detail, 'HTTP 404');
      return true;
    });
  });
});
