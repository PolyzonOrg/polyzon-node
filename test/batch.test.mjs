import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  AuthenticationError,
  GoneError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
} from '../dist/index.js';
import { clientFor, instantRetries, json, MODEL, problem, startServer } from './helpers.mjs';

let server;
let inFlight = 0;
let maxInFlight = 0;
/** `(id) => [status, code] | null` — null answers the model after a short random delay. */
let failFor;
/** Extra time each answer is held, so parallel requests overlap. */
let holdMs = 0;
before(async () => {
  instantRetries();
  server = await startServer(async (req, res) => {
    const [, , , source, id] = req.url.split('?')[0].split('/');
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Earlier ids answer later, so completion order differs from input order.
    const n = Number(id.split('-')[1] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, holdMs + 5 + ((40 - n) % 13) * 3));
    inFlight--;
    const failure = failFor(id);
    if (failure) problem(res, failure[0], failure[1], 'x');
    else json(res, 200, { ...MODEL, source, id });
  });
});
afterEach(() => {
  server.requests.length = 0;
  maxInFlight = 0;
  holdMs = 0;
});
after(() => server.close());

const refs = (count) => Array.from({ length: count }, (_, n) => ({ source: 'thingiverse', id: `tv-${n}` }));

describe('getModels', () => {
  test('results come in input order with metadata', async () => {
    failFor = () => null;
    const results = await clientFor(server).getModels(refs(12), { concurrency: 4, lang: 'en' });
    assert.deepEqual(
      results.map((r) => r.model.id),
      refs(12).map((r) => r.id),
    );
    for (const result of results) {
      assert.equal(result.error, undefined);
      assert.equal(result.source, 'thingiverse');
      assert.equal(result.model.id, result.id);
      assert.equal(typeof result.model.meta, 'object');
    }
    assert.ok(server.requests.every((r) => r.url.endsWith('?lang=en')));
  });

  for (const concurrency of [1, 3, 8]) {
    test(`never more than ${concurrency} in flight`, async () => {
      failFor = () => null;
      holdMs = 300;
      const count = concurrency * 2 + 1;
      await clientFor(server, { maxConnections: 20 }).getModels(refs(count), { concurrency });
      assert.equal(server.requests.length, count);
      assert.ok(maxInFlight <= concurrency, `max in flight ${maxInFlight}`);
      assert.equal(maxInFlight, concurrency, 'the limit is actually used');
    });
  }

  test('default concurrency is 4', async () => {
    failFor = () => null;
    await clientFor(server).getModels(refs(10));
    assert.equal(maxInFlight, 4);
  });

  test('per-item failures are results, not rejections', async () => {
    failFor = (id) => ({ 'tv-1': [404, 'not_found'], 'tv-3': [410, 'gone'] })[id] ?? null;
    const results = await clientFor(server).getModels([
      ...refs(4),
      { source: 'Bad Source', id: 'x' },
      { source: 'nasa', id: '..' },
    ]);
    assert.equal(results.length, 6);
    assert.ok(results[0].model);
    assert.ok(results[1].error instanceof NotFoundError);
    assert.equal(results[1].model, undefined);
    assert.ok(results[2].model);
    assert.ok(results[3].error instanceof GoneError);
    assert.ok(results[4].error instanceof TypeError);
    assert.deepEqual([results[4].source, results[4].id], ['Bad Source', 'x']);
    assert.ok(results[5].error instanceof TypeError);
    assert.equal(server.requests.length, 4, 'invalid refs send nothing');
  });

  for (const [status, code, cls] of [
    [401, 'invalid_token', AuthenticationError],
    [403, 'account_action_required', PermissionDeniedError],
    [429, 'quota_exceeded', QuotaExceededError],
  ]) {
    test(`short-circuits after ${cls.name}`, async () => {
      failFor = (id) => (id === 'tv-0' ? [status, code] : null);
      const results = await clientFor(server).getModels(refs(10), { concurrency: 1 });
      assert.equal(server.requests.length, 1);
      assert.ok(results.every((r) => r.error === results[0].error));
      assert.ok(results[0].error instanceof cls);
      assert.deepEqual(
        results.map((r) => r.id),
        refs(10).map((r) => r.id),
      );
    });
  }

  test('short-circuit with parallel workers: started refs finish, the rest get the error', async () => {
    failFor = (id) => (id === 'tv-2' ? [401, 'invalid_token'] : null);
    const results = await clientFor(server).getModels(refs(30), { concurrency: 3 });
    assert.ok(server.requests.length < 30);
    assert.ok(results[2].error instanceof AuthenticationError);
    assert.ok(results.at(-1).error === results[2].error);
    assert.ok(results[0].model && results[1].model);
  });

  test('accepts any iterable of refs, e.g. search items from a generator', async () => {
    failFor = () => null;
    function* gen() {
      yield { ...MODEL, id: 'tv-5' };
      yield { source: 'printables', id: 'pr-1' };
    }
    const results = await clientFor(server).getModels(gen());
    assert.deepEqual(
      results.map((r) => `${r.model.source}/${r.model.id}`),
      ['thingiverse/tv-5', 'printables/pr-1'],
    );
  });

  test('empty input → empty output', async () => {
    assert.deepEqual(await clientFor(server).getModels([]), []);
  });

  test('validates concurrency and refs', async () => {
    const client = clientFor(server);
    await assert.rejects(client.getModels(refs(1), { concurrency: 0 }), RangeError);
    await assert.rejects(client.getModels(refs(1), { concurrency: -2 }), RangeError);
    await assert.rejects(client.getModels(refs(1), { concurrency: 1.5 }), TypeError);
    await assert.rejects(client.getModels(refs(1), { concurrency: '2' }), TypeError);
    await assert.rejects(client.getModels([null]), TypeError);
    await assert.rejects(client.getModels(['tv-1']), TypeError);
    assert.equal(server.requests.length, 0);
  });

  test('aborting rejects the whole call with the reason', async () => {
    failFor = () => null;
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = clientFor(server).getModels(refs(20), { concurrency: 2 }, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 15);
    await assert.rejects(pending, (error) => error === reason);
    assert.ok(server.requests.length < 20);
  });
});
