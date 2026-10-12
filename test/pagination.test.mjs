import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { BadRequestError } from '../dist/index.js';
import { clientFor, instantRetries, ITEM, json, problem, SEARCH, startServer } from './helpers.mjs';

let server;
/** `(page, size) => body` of the next search answers. */
let pages;
before(async () => {
  instantRetries();
  server = await startServer((req, res) => {
    const query = new URL(req.url, 'http://x').searchParams;
    const body = pages(Number(query.get('page') ?? 1), Number(query.get('size') ?? 20));
    if (body === 'error') problem(res, 400, 'page_too_deep', 'page × size must not exceed 2400');
    else json(res, 200, body);
  });
});
afterEach(() => {
  server.requests.length = 0;
});
after(() => server.close());

const item = (page, n) => ({ ...ITEM, id: `tv-${page}-${n}` });
const pageOf = (page, count, hasMore) => ({
  ...SEARCH,
  page,
  items: Array.from({ length: count }, (_, n) => item(page, n)),
  hasMore,
});
const requestedPages = () => server.requests.map((r) => new URL(r.url, 'http://x').searchParams.get('page'));
const collect = async (iterable) => {
  const out = [];
  for await (const entry of iterable) out.push(entry);
  return out;
};

describe('searchAll', () => {
  test('walks pages until hasMore is false, items in order', async () => {
    pages = (page) => pageOf(page, 2, page < 3);
    const ids = (await collect(clientFor(server).searchAll({ q: 'дракон', size: 2 }))).map((i) => i.id);
    assert.deepEqual(ids, ['tv-1-0', 'tv-1-1', 'tv-2-0', 'tv-2-1', 'tv-3-0', 'tv-3-1']);
    assert.deepEqual(requestedPages(), ['1', '2', '3']);
    for (const request of server.requests) {
      const query = new URL(request.url, 'http://x').searchParams;
      assert.equal(query.get('q'), 'дракон');
      assert.equal(query.get('size'), '2');
    }
  });

  test('starts at params.page', async () => {
    pages = (page) => pageOf(page, 1, page < 6);
    await collect(clientFor(server).searchAll({ q: 'x', page: 5 }));
    assert.deepEqual(requestedPages(), ['5', '6']);
  });

  test('stops at an empty page even if hasMore says otherwise', async () => {
    pages = (page) => pageOf(page, page === 1 ? 1 : 0, true);
    assert.equal((await collect(clientFor(server).searchAll({ q: 'x' }))).length, 1);
    assert.deepEqual(requestedPages(), ['1', '2']);
  });

  test('stops at page 100, the server limit (page 101 would be a 400)', async () => {
    pages = (page) => (page > 100 ? 'error' : pageOf(page, 1, true));
    assert.equal((await collect(clientFor(server).searchAll({ q: 'x', page: 99 }))).length, 2);
    assert.deepEqual(requestedPages(), ['99', '100']);
  });

  test('is lazy: no request before iteration, one page per need', async () => {
    pages = (page) => pageOf(page, 2, true);
    const iterable = clientFor(server).searchAll({ q: 'x' });
    assert.equal(server.requests.length, 0);
    for await (const entry of iterable) {
      assert.equal(entry.id, 'tv-1-0');
      break;
    }
    assert.equal(server.requests.length, 1);
  });

  test('invalid params throw at once', () => {
    assert.throws(() => clientFor(server).searchAll({ q: '' }), TypeError);
    assert.throws(() => clientFor(server).searchAll({ q: 'x', page: 0 }), RangeError);
    assert.equal(server.requests.length, 0);
  });

  test('request errors surface while iterating, after the items already yielded', async () => {
    pages = (page) => (page === 2 ? 'error' : pageOf(page, 1, true));
    const seen = [];
    await assert.rejects(async () => {
      for await (const entry of clientFor(server).searchAll({ q: 'x' })) seen.push(entry.id);
    }, BadRequestError);
    assert.deepEqual(seen, ['tv-1-0']);
  });
});
