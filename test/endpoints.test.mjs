import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { inspect } from 'node:util';
import { InvalidResponseError } from '../dist/index.js';
import {
  clientFor,
  instantRetries,
  ITEM,
  json,
  LIMITS,
  ME,
  MODEL,
  RATE_HEADERS,
  SEARCH,
  startServer,
} from './helpers.mjs';

let server;
/** What the next request answers: `(req, res) => void`. */
let reply;
before(async () => {
  instantRetries();
  server = await startServer((req, res) => reply(req, res));
});
afterEach(() => {
  server.requests.length = 0;
});
after(() => server.close());

const answer = (body, headers = RATE_HEADERS, status = 200) => {
  reply = (req, res) => json(res, status, body, headers);
};
const lastQuery = () => new URL(server.requests.at(-1).url, 'http://x').searchParams;

describe('search', () => {
  test('parses the documented example and its metadata', async () => {
    answer(SEARCH);
    const page = await clientFor(server).search({ q: 'дракон' });
    assert.deepEqual(page, SEARCH);
    assert.deepEqual(page.meta, {
      requestId: 'req-123',
      rateLimit: { limit: 200, remaining: 163, resetAt: 1791590400 },
    });
    assert.equal(server.requests.at(-1).method, 'GET');
    assert.equal(new URL(server.requests.at(-1).url, 'http://x').pathname, '/v1/search');
  });

  test('meta stays out of JSON, keys, spreading and inspect', async () => {
    answer(SEARCH);
    const page = await clientFor(server).search({ q: 'x' });
    assert.deepEqual(JSON.parse(JSON.stringify(page)), SEARCH);
    assert.ok(!Object.keys(page).includes('meta'));
    assert.equal({ ...page }.meta, undefined);
    assert.ok(!inspect(page).includes('req-123'));
  });

  test('only q is sent when nothing else is set', async () => {
    answer(SEARCH);
    await clientFor(server).search({ q: 'дракон', free: false, sources: [], formats: '', sort: undefined });
    const url = server.requests.at(-1).url;
    assert.equal(url, '/v1/search?q=%D0%B4%D1%80%D0%B0%D0%BA%D0%BE%D0%BD');
  });

  test('encodes every parameter; lists are joined with commas', async () => {
    answer(SEARCH);
    await clientFor(server).search({
      q: 'дракон & co=1+2 #3 / 100%',
      page: 2,
      size: 10,
      sort: 'popular',
      free: true,
      sources: ['thingiverse', 'printables'],
      formats: ['stl', '3mf'],
      license: ['cc0', 'cc-by'],
      lang: 'en',
    });
    const query = lastQuery();
    assert.deepEqual(
      [...query.keys()],
      ['q', 'page', 'size', 'sort', 'free', 'sources', 'formats', 'license', 'lang'],
    );
    assert.equal(query.get('q'), 'дракон & co=1+2 #3 / 100%');
    assert.equal(query.get('page'), '2');
    assert.equal(query.get('size'), '10');
    assert.equal(query.get('sort'), 'popular');
    assert.equal(query.get('free'), '1');
    assert.equal(query.get('sources'), 'thingiverse,printables');
    assert.equal(query.get('formats'), 'stl,3mf');
    assert.equal(query.get('license'), 'cc0,cc-by');
    assert.equal(query.get('lang'), 'en');
    assert.ok(!server.requests.at(-1).url.includes('#'));
  });

  test('a list may also be passed as a ready string; unknown enum values pass through', async () => {
    answer(SEARCH);
    await clientFor(server).search({ q: 'x', sources: 'newsite', sort: 'trending', lang: 'de' });
    const query = lastQuery();
    assert.equal(query.get('sources'), 'newsite');
    assert.equal(query.get('sort'), 'trending');
    assert.equal(query.get('lang'), 'de');
  });

  for (const [name, params, error] of [
    ['missing q', {}, TypeError],
    ['empty q', { q: '' }, TypeError],
    ['blank q', { q: '   ' }, TypeError],
    ['non-string q', { q: 5 }, TypeError],
    ['page 0', { q: 'x', page: 0 }, RangeError],
    ['fractional page', { q: 'x', page: 1.5 }, TypeError],
    ['string size', { q: 'x', size: '10' }, TypeError],
    ['null params', null, TypeError],
  ]) {
    test(`rejects ${name} before any request`, async () => {
      await assert.rejects(clientFor(server).search(params), error);
      assert.equal(server.requests.length, 0);
    });
  }
});

describe('getModel', () => {
  test('parses the documented example; path segments and lang', async () => {
    answer(MODEL);
    const model = await clientFor(server).getModel('thingiverse', 'tv-1234567', { lang: 'en' });
    assert.deepEqual(model, MODEL);
    assert.equal(model.meta.requestId, 'req-123');
    assert.equal(server.requests.at(-1).url, '/v1/models/thingiverse/tv-1234567?lang=en');
  });

  test('no lang → no query string', async () => {
    answer(MODEL);
    await clientFor(server).getModel('3dtoday', 'a.b_c-D');
    assert.equal(server.requests.at(-1).url, '/v1/models/3dtoday/a.b_c-D');
  });

  test('ids with three dots are plain segments', async () => {
    answer(MODEL);
    await clientFor(server).getModel('nasa', '...');
    assert.equal(server.requests.at(-1).url, '/v1/models/nasa/...');
  });

  const invalid = [
    ['upper-case source', 'Thingiverse', 'x'],
    ['source with a space', 'thing verse', 'x'],
    ['source with a slash', 'a/b', 'x'],
    ['empty source', '', 'x'],
    ['33-char source', 'a'.repeat(33), 'x'],
    ['non-string source', 7, 'x'],
    ['id "."', 'nasa', '.'],
    ['id ".."', 'nasa', '..'],
    ['id with a slash', 'nasa', 'a/b'],
    ['id with percent', 'nasa', 'a%2Fb'],
    ['id with a query', 'nasa', 'a?b=1'],
    ['empty id', 'nasa', ''],
    ['256-char id', 'nasa', 'a'.repeat(256)],
    ['non-string id', 'nasa', 12],
  ];
  for (const [name, source, id] of invalid) {
    test(`rejects ${name} before any request`, async () => {
      await assert.rejects(clientFor(server).getModel(source, id), TypeError);
      assert.equal(server.requests.length, 0);
    });
  }

  test('rejects an empty or non-string lang', async () => {
    await assert.rejects(clientFor(server).getModel('nasa', 'x', { lang: '' }), TypeError);
    await assert.rejects(clientFor(server).getModel('nasa', 'x', { lang: 1 }), TypeError);
    assert.equal(server.requests.length, 0);
  });

  test('255-char id is fine', async () => {
    answer(MODEL);
    await clientFor(server).getModel('nasa', 'a'.repeat(255));
    assert.equal(server.requests.length, 1);
  });
});

describe('me and limits', () => {
  test('me parses the documented example', async () => {
    answer(ME, { 'x-request-id': 'r1' });
    const me = await clientFor(server).me();
    assert.deepEqual(me, ME);
    assert.deepEqual(me.meta, { requestId: 'r1', rateLimit: null });
    assert.equal(server.requests.at(-1).url, '/v1/me');
  });

  test('limits parses the documented example', async () => {
    answer(LIMITS);
    const limits = await clientFor(server).limits();
    assert.deepEqual(limits, LIMITS);
    assert.equal(server.requests.at(-1).url, '/v1/limits');
  });
});

describe('metadata', () => {
  test('absent headers → nulls', async () => {
    answer(LIMITS, {});
    assert.deepEqual((await clientFor(server).limits()).meta, { requestId: null, rateLimit: null });
  });

  test('partial or malformed rate-limit headers → rateLimit null', async () => {
    answer(LIMITS, { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '5' });
    assert.equal((await clientFor(server).limits()).meta.rateLimit, null);
    answer(LIMITS, { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': 'many', 'x-ratelimit-reset': '1' });
    assert.equal((await clientFor(server).limits()).meta.rateLimit, null);
  });
});

describe('lenient parsing', () => {
  test('floats are truncated to integers', async () => {
    answer({ ...SEARCH, total: 12.0, page: 1.9, size: 20.2, items: [{ ...ITEM, stats: { likes: 3.7 } }] });
    const page = await clientFor(server).search({ q: 'x' });
    assert.equal(page.total, 12);
    assert.equal(page.page, 1);
    assert.equal(page.size, 20);
    assert.deepEqual(page.items[0].stats, { likes: 3, comments: null, makes: null, collects: null });
  });

  test('wrong types become null / [] / "" / 0 / false; unknown fields are dropped', async () => {
    answer({
      query: 5,
      correctedQuery: 'драконы',
      didYouMean: ['x'],
      total: '1873',
      totalRelation: 'approx',
      hasMore: 'yes',
      partial: 1,
      secret: 'internal',
      items: [
        null,
        7,
        'item',
        [],
        {
          source: 'printables',
          id: 'pr-1',
          title: null,
          thumbnail: 3,
          price: 'free',
          formats: ['stl', 3, null],
          tags: 'a,b',
          stats: [1, 2],
          publishedAt: 0,
          safety: 'x',
        },
      ],
    });
    const page = await clientFor(server).search({ q: 'x' });
    assert.deepEqual(page, {
      query: '',
      correctedQuery: 'драконы',
      didYouMean: null,
      total: 0,
      totalRelation: 'approx',
      page: 0,
      size: 0,
      hasMore: false,
      partial: false,
      items: [
        {
          source: 'printables',
          id: 'pr-1',
          title: '',
          url: '',
          thumbnail: null,
          creator: null,
          license: null,
          price: null,
          formats: ['stl'],
          tags: [],
          stats: { likes: null, comments: null, makes: null, collects: null },
          publishedAt: null,
        },
      ],
    });
  });

  test('model: broken nested objects and unknown price types', async () => {
    answer({
      source: 'nasa',
      id: 'n-1',
      title: 'Луна',
      url: 'https://nasa.gov/x',
      license: { raw: 7 },
      price: { type: 'subscription', value: 'cheap', display: null },
      stats: { downloads: 1e3, views: Infinity },
      images: [1, 'https://img'],
      copies: [{ source: 'x' }, 'bad', null, { source: 'thingiverse', id: 'tv-1', extra: true }],
    });
    const model = await clientFor(server).getModel('nasa', 'n-1');
    assert.deepEqual(model.license, { id: '', raw: null });
    assert.deepEqual(model.price, { type: 'subscription', value: null, currency: null, display: '' });
    assert.deepEqual(model.stats, {
      likes: null,
      comments: null,
      makes: null,
      collects: null,
      downloads: 1000,
      views: null,
    });
    assert.deepEqual(model.images, ['https://img']);
    assert.deepEqual(model.copies, [
      { source: 'x', id: '' },
      { source: 'thingiverse', id: 'tv-1' },
    ]);
    assert.equal(model.description, null);
    assert.equal(model.updatedAt, null);
  });

  test('me and limits with missing objects', async () => {
    answer({ account: 'x' });
    assert.deepEqual(await clientFor(server).me(), {
      account: { id: '', displayName: null, createdAt: '' },
      token: { id: '', name: '', prefix: '', createdAt: '' },
    });
    answer({ daily: { limit: 200.0, used: '3' } });
    assert.deepEqual(await clientFor(server).limits(), {
      perMinute: { limit: 0, used: 0, remaining: 0, resetAt: 0 },
      daily: { limit: 200, used: 0, remaining: 0, resetAt: 0 },
    });
  });

  test('a __proto__ key in the body does not pollute anything', async () => {
    answer('{"__proto__":{"polluted":true},"perMinute":{"limit":1}}');
    const limits = await clientFor(server).limits();
    assert.equal(limits.perMinute.limit, 1);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(limits), Object.prototype);
  });
});

describe('invalid 2xx bodies → InvalidResponseError, not retried', () => {
  for (const [name, body] of [
    ['HTML', '<html>oops</html>'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"ok"'],
    ['null', 'null'],
    ['an empty body', ''],
    ['truncated JSON', '{"items":['],
  ]) {
    test(name, async () => {
      answer(body, { 'x-request-id': 'bad-1' });
      await assert.rejects(clientFor(server).limits(), (error) => {
        assert.ok(error instanceof InvalidResponseError);
        assert.equal(error.name, 'InvalidResponseError');
        assert.equal(error.status, 200);
        assert.equal(error.requestId, 'bad-1');
        assert.match(error.message, /\(request id bad-1\)$/);
        assert.ok(!error.message.includes('<html'));
        return true;
      });
      assert.equal(server.requests.length, 1);
    });
  }
});
