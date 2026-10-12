import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { inspect } from 'node:util';
import DefaultExport, * as sdk from '../dist/index.js';
import { clientFor, json, LIMITS, ME, startServer, TOKEN, withEnv } from './helpers.mjs';

const { Polyzon } = sdk;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('exports', () => {
  test('default and named export are the client class', () => {
    assert.equal(DefaultExport, Polyzon);
    assert.equal(typeof Polyzon, 'function');
  });

  test('VERSION matches package.json', () => {
    assert.equal(sdk.VERSION, pkg.version);
  });

  test('constants list the known values', () => {
    assert.equal(sdk.SOURCES.length, 22);
    assert.ok(sdk.SOURCES.includes('3dexport'));
    assert.equal(sdk.LICENSES.length, 15);
    assert.deepEqual(sdk.SORTS, ['relevant', 'popular', 'newest', 'likes', 'makes', 'downloads']);
    assert.deepEqual(sdk.LANGS, ['ru', 'en']);
    assert.deepEqual(sdk.PRICE_TYPES, ['free', 'paid', 'open']);
    assert.deepEqual(sdk.TOTAL_RELATIONS, ['eq', 'gte']);
  });

  test('internals are not exported', () => {
    assert.equal('hooks' in sdk, false);
    assert.equal('apiErrorFor' in sdk, false);
    assert.equal('TunnelAgent' in sdk, false);
  });
});

describe('apiKey', () => {
  test('missing → TypeError that points to POLYZON_API_KEY', async () => {
    await withEnv({ POLYZON_API_KEY: undefined }, () => {
      assert.throws(() => new Polyzon(), { name: 'TypeError', message: /POLYZON_API_KEY/ });
      assert.throws(() => new Polyzon({ apiKey: '' }), TypeError);
    });
  });

  test('read from POLYZON_API_KEY', async () => {
    await withEnv({ POLYZON_API_KEY: TOKEN }, () => {
      assert.match(inspect(new Polyzon()), /pzk_Q7xR…/);
    });
  });

  test('explicit option wins over the env', async () => {
    await withEnv({ POLYZON_API_KEY: 'env_token_value' }, () => {
      assert.match(inspect(new Polyzon({ apiKey: TOKEN })), /pzk_Q7xR…/);
    });
  });

  const bad = [
    ['space', `${TOKEN} x`],
    ['CR LF', `${TOKEN}\r\nX-Evil: 1`],
    ['NUL', `${TOKEN}\0`],
    ['tab', `${TOKEN}\t`],
    ['non-ASCII', `${TOKEN}ж`],
    ['too long', `pzk_${'A'.repeat(509)}`],
  ];
  for (const [name, key] of bad) {
    test(`rejects ${name} without echoing the key`, () => {
      assert.throws(
        () => new Polyzon({ apiKey: key }),
        (error) =>
          error instanceof TypeError && !error.message.includes(TOKEN) && !error.message.includes('AAAA'),
      );
    });
  }

  test('rejects a non-string', () => {
    assert.throws(() => new Polyzon({ apiKey: 42 }), TypeError);
  });

  test('does not enforce the pzk_ format', () => {
    assert.doesNotThrow(() => new Polyzon({ apiKey: 'x' }));
    assert.doesNotThrow(() => new Polyzon({ apiKey: 'A'.repeat(512) }));
  });
});

describe('baseURL', () => {
  const make = (baseURL) => new Polyzon({ apiKey: TOKEN, baseURL, proxy: false });

  test('defaults to https://api.polyzon.org', async () => {
    await withEnv({ POLYZON_BASE_URL: undefined }, () => {
      assert.equal(new Polyzon({ apiKey: TOKEN }).baseURL, 'https://api.polyzon.org');
    });
  });

  test('read from POLYZON_BASE_URL', async () => {
    await withEnv({ POLYZON_BASE_URL: 'https://staging.polyzon.test/' }, () => {
      assert.equal(new Polyzon({ apiKey: TOKEN }).baseURL, 'https://staging.polyzon.test');
    });
  });

  test('strips trailing slashes and keeps a path prefix', () => {
    assert.equal(make('https://api.polyzon.org/').baseURL, 'https://api.polyzon.org');
    assert.equal(make('https://gw.example.com/polyzon//').baseURL, 'https://gw.example.com/polyzon');
  });

  test('allows http only for loopback', () => {
    assert.equal(make('http://localhost:8080').baseURL, 'http://localhost:8080');
    assert.equal(make('http://127.0.0.1:1').baseURL, 'http://127.0.0.1:1');
    assert.equal(make('http://[::1]:9/').baseURL, 'http://[::1]:9');
    assert.throws(() => make('http://api.polyzon.org'), TypeError);
    assert.throws(() => make('http://127.0.0.2'), TypeError);
    assert.throws(() => make('http://localhost.evil.com'), TypeError);
  });

  const invalid = {
    'not a URL': 'api.polyzon.org',
    'ftp scheme': 'ftp://api.polyzon.org',
    credentials: 'https://user:s3cret@api.polyzon.org',
    query: 'https://api.polyzon.org/?x=1',
    'empty query': 'https://api.polyzon.org/?',
    fragment: 'https://api.polyzon.org/#x',
    'non-string': 42,
  };
  for (const [name, value] of Object.entries(invalid)) {
    test(`rejects ${name}`, () => {
      assert.throws(
        () => make(value),
        (error) => error instanceof TypeError && !error.message.includes('s3cret'),
      );
    });
  }
});

describe('numeric options', () => {
  const make = (options) => new Polyzon({ apiKey: TOKEN, proxy: false, ...options });

  test('defaults', () => {
    const client = make({});
    assert.equal(client.timeout, 30_000);
    assert.equal(client.maxRetries, 2);
  });

  for (const [name, value, error] of [
    ['timeout', 0, RangeError],
    ['timeout', -5, RangeError],
    ['timeout', 1.5, TypeError],
    ['timeout', Number.NaN, TypeError],
    ['timeout', Infinity, TypeError],
    ['timeout', 2 ** 31, RangeError],
    ['timeout', '100', TypeError],
    ['maxRetries', -1, RangeError],
    ['maxRetries', 0.5, TypeError],
    ['maxConnections', 0, RangeError],
    ['maxConnections', 2.5, TypeError],
  ]) {
    test(`${name}: ${String(value)} → ${error.name}`, () => {
      assert.throws(() => make({ [name]: value }), error);
    });
  }

  test('maxRetries 0 is allowed', () => {
    assert.equal(make({ maxRetries: 0 }).maxRetries, 0);
  });
});

describe('agent option', () => {
  test('cannot be combined with proxy, ca or maxConnections', () => {
    const agent = new http.Agent();
    for (const extra of [{ proxy: false }, { proxy: 'http://p:1' }, { ca: 'x' }, { maxConnections: 2 }]) {
      assert.throws(() => new Polyzon({ apiKey: TOKEN, agent, ...extra }), TypeError);
    }
  });

  test('an agent that throws while connecting → APIConnectionError', async () => {
    class BrokenAgent extends http.Agent {
      createConnection() {
        throw new Error('no route to host');
      }
    }
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: 'http://127.0.0.1:1',
      agent: new BrokenAgent(),
      maxRetries: 0,
    });
    await assert.rejects(client.limits(), (error) => {
      assert.ok(error instanceof sdk.APIConnectionError);
      assert.match(error.message, /no route to host/);
      return true;
    });
  });

  test('requests go through the given agent; close() leaves it alone', async () => {
    const server = await startServer((req, res) => json(res, 200, LIMITS));
    class CountingAgent extends http.Agent {
      created = 0;
      createConnection(...args) {
        this.created++;
        return super.createConnection(...args);
      }
    }
    const agent = new CountingAgent({ keepAlive: true });
    try {
      const client = new Polyzon({ apiKey: TOKEN, baseURL: server.url, agent });
      await client.limits();
      assert.equal(agent.created, 1);
      client.close();
      await client.limits();
      assert.equal(agent.created, 1, 'the idle socket survived close()');
    } finally {
      agent.destroy();
      await server.close();
    }
  });
});

describe('requests', () => {
  let server;
  before(async () => {
    server = await startServer((req, res) => json(res, 200, req.url === '/v1/me' ? ME : LIMITS));
  });
  after(() => server.close());

  test('sends exactly Authorization, Accept and User-Agent (plus Host/Connection)', async () => {
    await clientFor(server).me();
    const { headers } = server.requests.at(-1);
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers.accept, 'application/json');
    assert.match(
      headers['user-agent'],
      new RegExp(
        `^polyzon-node/${pkg.version.replaceAll('.', '\\.')} \\(node \\d+\\.\\d+\\.\\d+; \\w+/\\w+\\)$`,
      ),
    );
    assert.deepEqual(Object.keys(headers).sort(), [
      'accept',
      'authorization',
      'connection',
      'host',
      'user-agent',
    ]);
    assert.equal(headers['accept-encoding'], undefined);
  });

  test('userAgent suffix is appended and validated', async () => {
    await clientFor(server, { userAgent: 'my-bot/2.1 (+https://example.com)' }).me();
    assert.match(
      server.requests.at(-1).headers['user-agent'],
      /\) my-bot\/2\.1 \(\+https:\/\/example\.com\)$/,
    );
    assert.throws(() => clientFor(server, { userAgent: 'x\r\nX-Evil: 1' }), TypeError);
    assert.throws(() => clientFor(server, { userAgent: '' }), TypeError);
    assert.throws(() => clientFor(server, { userAgent: 'é' }), TypeError);
  });

  test('connections are kept alive and reused', async () => {
    const client = clientFor(server);
    await client.me();
    await client.limits();
    const [a, b] = server.requests.slice(-2);
    assert.equal(a.port, b.port);
    client.close();
  });

  test('withOptions shares the pool and overrides options', async () => {
    const base = clientFor(server, { userAgent: 'base/1' });
    await base.me();
    const derived = base.withOptions({ apiKey: 'other_token', maxRetries: 0, timeout: 1234 });
    assert.equal(derived.baseURL, base.baseURL);
    assert.equal(derived.maxRetries, 0);
    assert.equal(derived.timeout, 1234);
    await derived.me();
    const [a, b] = server.requests.slice(-2);
    assert.equal(a.port, b.port, 'same pooled socket');
    assert.equal(b.headers.authorization, 'Bearer other_token');
    assert.match(b.headers['user-agent'], / base\/1$/);
    assert.throws(() => base.withOptions({ timeout: 0 }), RangeError);
    assert.throws(() => base.withOptions({ apiKey: 'a b' }), TypeError);
    base.close();
  });

  test('close() destroys pooled sockets; the client still works afterwards', async () => {
    const client = clientFor(server);
    await client.me();
    const socket = [...server.sockets].find((s) => s.remotePort === server.requests.at(-1).port);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    client.close();
    await closed;
    await client.me();
    client.close();
  });
});

describe('token masking', () => {
  const client = new Polyzon({ apiKey: TOKEN, proxy: false });

  test('util.inspect / console.log show only the first 8 characters', () => {
    const text = inspect(client, { showHidden: true, depth: 5 });
    assert.match(text, /pzk_Q7xR…/);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes('Q7xR2'));
  });

  test('JSON.stringify, String, Object.keys and spreading do not leak it', () => {
    const json = JSON.stringify(client);
    assert.deepEqual(JSON.parse(json), {
      baseURL: 'https://api.polyzon.org',
      apiKey: 'pzk_Q7xR…',
      timeout: 30000,
      maxRetries: 2,
    });
    assert.ok(!String(client).includes(TOKEN));
    assert.ok(!JSON.stringify({ ...client }).includes('Q7xR2'));
    for (const key of Reflect.ownKeys(client)) assert.ok(!String(client[key]).includes(TOKEN));
  });

  test('short keys are masked too', () => {
    assert.match(inspect(new Polyzon({ apiKey: 'abcd', proxy: false })), /apiKey: 'ab…'/);
  });
});
