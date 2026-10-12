import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
} from '../dist/index.js';
import { hooks } from '../dist/client.js';
import { clientFor, instantRetries, json, LIMITS, problem, startServer, TOKEN } from './helpers.mjs';

const realSleep = hooks.sleep;
const realRandom = hooks.random;
let server;
let reply;
let delays;
before(async () => {
  server = await startServer((req, res, n) => reply(req, res, n));
});
beforeEach(() => {
  delays = instantRetries();
  hooks.random = () => 1;
});
afterEach(() => {
  server.requests.length = 0;
  hooks.sleep = realSleep;
  hooks.random = realRandom;
});
after(() => server.close());

/** Fails the first `failures` requests with `fail`, then answers LIMITS. */
const flaky = (failures, fail) => {
  reply = (req, res, n) => (n < failures ? fail(req, res) : json(res, 200, LIMITS));
};

describe('retried', () => {
  for (const status of [500, 502, 503, 504]) {
    test(`HTTP ${status}`, async () => {
      flaky(2, (req, res) =>
        problem(res, status, 'unavailable', 'Временно недоступно.', { 'retry-after': '' }),
      );
      assert.deepEqual(await clientFor(server).limits(), LIMITS);
      assert.equal(server.requests.length, 3);
    });
  }

  test('503 waits the Retry-After the server sends (5 s)', async () => {
    flaky(2, (req, res) => problem(res, 503, 'unavailable', 'Сервис временно недоступен.'));
    await clientFor(server).limits();
    assert.deepEqual(delays, [5000, 5000]);
  });

  test('429 rate_limited waits Retry-After', async () => {
    flaky(1, (req, res) =>
      problem(res, 429, 'rate_limited', 'Не больше 20 запросов в минуту.', { 'retry-after': '3' }),
    );
    await clientFor(server).limits();
    assert.deepEqual(delays, [3000]);
  });

  test('Retry-After of exactly 60 s is still honoured', async () => {
    flaky(1, (req, res) => problem(res, 429, 'rate_limited', 'x', { 'retry-after': '60' }));
    await clientFor(server).limits();
    assert.deepEqual(delays, [60_000]);
  });

  test('connection resets', async () => {
    flaky(2, (req) => req.socket.destroy());
    assert.deepEqual(await clientFor(server).limits(), LIMITS);
    assert.equal(server.requests.length, 3);
  });

  test('an attempt that times out', async () => {
    flaky(1, () => undefined);
    assert.deepEqual(await clientFor(server, { timeout: 1000 }).limits(), LIMITS);
    assert.equal(server.requests.length, 2);
  });
});

describe('backoff', () => {
  test('exponential with full jitter, capped at 8 s', async () => {
    flaky(Infinity, (req, res) => problem(res, 500, 'internal', 'x'));
    hooks.random = () => 1;
    await assert.rejects(clientFor(server, { maxRetries: 6 }).limits(), InternalServerError);
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000]);
  });

  test('the jitter multiplier is 0.5..1.0', async () => {
    flaky(Infinity, (req, res) => problem(res, 500, 'internal', 'x'));
    hooks.random = () => 0;
    await assert.rejects(clientFor(server, { maxRetries: 3 }).limits(), InternalServerError);
    assert.deepEqual(delays, [250, 500, 1000]);
  });
});

describe('not retried', () => {
  const cases = [
    [
      '429 quota_exceeded',
      QuotaExceededError,
      (req, res) => problem(res, 429, 'quota_exceeded', 'x', { 'retry-after': '30' }),
    ],
    [
      '429 with Retry-After over 60 s',
      RateLimitError,
      (req, res) => problem(res, 429, 'rate_limited', 'x', { 'retry-after': '61' }),
    ],
    [
      '503 with Retry-After over 60 s',
      InternalServerError,
      (req, res) => problem(res, 503, 'unavailable', 'x', { 'retry-after': '120' }),
    ],
    ['501', InternalServerError, (req, res) => problem(res, 501, 'not_implemented', 'x')],
    ['400', BadRequestError, (req, res) => problem(res, 400, 'bad_request', 'x')],
    ['401', AuthenticationError, (req, res) => problem(res, 401, 'invalid_token', 'x')],
    ['404', NotFoundError, (req, res) => problem(res, 404, 'not_found', 'x')],
  ];
  for (const [name, cls, fail] of cases) {
    test(name, async () => {
      flaky(Infinity, fail);
      await assert.rejects(clientFor(server).limits(), cls);
      assert.equal(server.requests.length, 1);
      assert.deepEqual(delays, []);
    });
  }

  test('maxRetries 0 on the client', async () => {
    flaky(Infinity, (req, res) => problem(res, 503, 'unavailable', 'x'));
    await assert.rejects(clientFor(server, { maxRetries: 0 }).limits(), InternalServerError);
    assert.equal(server.requests.length, 1);
  });

  test('maxRetries per request overrides the client', async () => {
    flaky(Infinity, (req, res) => problem(res, 503, 'unavailable', 'x'));
    await assert.rejects(clientFor(server).limits({ maxRetries: 0 }), InternalServerError);
    assert.equal(server.requests.length, 1);
    await assert.rejects(clientFor(server, { maxRetries: 0 }).limits({ maxRetries: 1 }), InternalServerError);
    assert.equal(server.requests.length, 3);
    await assert.rejects(clientFor(server).limits({ maxRetries: -1 }), RangeError);
  });

  test('gives up after maxRetries connection failures', async () => {
    flaky(Infinity, (req) => req.socket.destroy());
    await assert.rejects(clientFor(server, { maxRetries: 1 }).limits(), (error) => {
      assert.ok(error instanceof APIConnectionError);
      assert.ok(!(error instanceof APITimeoutError));
      assert.match(error.message, /^Connection error: /);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(server.requests.length, 2);
  });
});

describe('timeouts', () => {
  test('APITimeoutError after the per-attempt timeout; the socket is destroyed', async () => {
    let serverSocket;
    flaky(Infinity, (req) => {
      serverSocket = req.socket;
    });
    const started = Date.now();
    await assert.rejects(clientFor(server, { timeout: 1000, maxRetries: 0 }).limits(), (error) => {
      assert.ok(error instanceof APITimeoutError);
      assert.ok(error instanceof APIConnectionError);
      assert.equal(error.message, 'Request timed out after 1000 ms.');
      return true;
    });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(server.requests.length, 1);
    if (!serverSocket.destroyed) await new Promise((resolve) => serverSocket.once('close', resolve));
  });

  test('per-request timeout overrides the client', async () => {
    flaky(Infinity, () => undefined);
    await assert.rejects(clientFor(server, { maxRetries: 0 }).limits({ timeout: 80 }), APITimeoutError);
    await assert.rejects(clientFor(server).limits({ timeout: 0 }), RangeError);
  });

  test('a body that stalls mid-way also times out', async () => {
    flaky(Infinity, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"perMinute":');
    });
    await assert.rejects(clientFor(server, { timeout: 150, maxRetries: 0 }).limits(), APITimeoutError);
  });

  test('a connection dropped mid-body is a connection error', async () => {
    flaky(Infinity, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"perMinute":');
      setTimeout(() => req.socket.destroy(), 20);
    });
    await assert.rejects(clientFor(server, { maxRetries: 0 }).limits(), (error) => {
      return error instanceof APIConnectionError && !(error instanceof APITimeoutError);
    });
  });

  test('a refused connection is a connection error', async () => {
    const client = clientFor({ url: 'http://127.0.0.1:1' }, { maxRetries: 0 });
    await assert.rejects(client.limits(), APIConnectionError);
  });
});

describe('abort', () => {
  test('an already aborted signal rejects with its reason, no request', async () => {
    flaky(0, () => undefined);
    const reason = new Error('stop');
    await assert.rejects(
      clientFor(server).limits({ signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(server.requests.length, 0);
  });

  test('abort during a request rejects with an AbortError and drops the socket', async () => {
    flaky(Infinity, () => undefined);
    const controller = new AbortController();
    const pending = clientFor(server).limits({ signal: controller.signal });
    while (server.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(server.requests.length, 1, 'not retried');
  });

  test('abort during the retry wait stops at once', async () => {
    hooks.sleep = realSleep;
    flaky(Infinity, (req, res) => problem(res, 503, 'unavailable', 'x', { 'retry-after': '30' }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = clientFor(server).limits({ signal: controller.signal });
    while (server.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(Date.now() - started < 5000);
    assert.equal(server.requests.length, 1);
  });

  test('the real sleep waits', async () => {
    const started = Date.now();
    await realSleep(30);
    assert.ok(Date.now() - started >= 25);
    await assert.rejects(realSleep(10, AbortSignal.abort()), { name: 'AbortError' });
  });
});

describe('logging', () => {
  test('debug per attempt and warn per retry; never headers or the token', async () => {
    const lines = [];
    const logger = {
      debug: (message) => lines.push(['debug', message]),
      warn: (message) => lines.push(['warn', message]),
    };
    flaky(1, (req, res) => problem(res, 503, 'unavailable', 'Сервис временно недоступен.'));
    await clientFor(server, { logger }).search({ q: 'дракон' });
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map(([level]) => level),
      ['debug', 'warn', 'debug'],
    );
    assert.match(lines[0][1], /^polyzon: GET \/v1\/search\?q=%D0%B4.* -> 503 in \d+ ms \(attempt 1\)$/);
    assert.match(lines[1][1], /503 unavailable.*retry 1 of 2 in 5000 ms$/);
    assert.match(lines[2][1], /-> 200 .*\(attempt 2\)$/);
    for (const [, message] of lines) {
      assert.ok(!message.includes(TOKEN));
      assert.ok(!/authorization|bearer/i.test(message));
    }
  });
});
