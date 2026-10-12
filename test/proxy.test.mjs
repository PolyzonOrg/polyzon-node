import assert from 'node:assert/strict';
import * as net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { APIConnectionError, Polyzon } from '../dist/index.js';
import { isLoopback, matchesNoProxy, parseProxy, proxyFromEnv } from '../dist/proxy.js';
import {
  json,
  LIMITS,
  makeCertificate,
  ME,
  NO_PROXY_ENV,
  startProxy,
  startServer,
  TOKEN,
  withEnv,
} from './helpers.mjs';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('NO_PROXY matching', () => {
  const target = (url) => new URL(url);
  const cases = [
    ['https://api.polyzon.org', '*', true],
    ['https://api.polyzon.org', 'polyzon.org', true],
    ['https://api.polyzon.org', '.polyzon.org', true],
    ['https://api.polyzon.org', '*.polyzon.org', true],
    ['https://api.polyzon.org', 'api.polyzon.org', true],
    ['https://api.polyzon.org', 'API.Polyzon.ORG.', true],
    ['https://polyzon.org', '.polyzon.org', true],
    ['https://api.polyzon.org', 'zon.org', false],
    ['https://api.polyzon.org', 'other.com, polyzon.org', true],
    ['https://api.polyzon.org', 'other.com polyzon.org', true],
    ['https://api.polyzon.org', 'other.com,,  ,', false],
    ['https://api.polyzon.org', 'polyzon.org:443', true],
    ['https://api.polyzon.org', 'polyzon.org:8443', false],
    ['https://api.polyzon.org:8443', 'polyzon.org:8443', true],
    ['https://10.0.0.1', '10.0.0.1', true],
    ['https://10.0.0.1', '10.0.0.2', false],
    ['https://[2001:db8::1]', '2001:db8::1', true],
    ['https://[2001:db8::1]:8443', '[2001:db8::1]:8443', true],
    ['https://[2001:db8::1]:8443', '[2001:db8::1]:443', false],
    ['https://api.polyzon.org', '', false],
  ];
  for (const [url, noProxy, expected] of cases) {
    test(`${url} vs "${noProxy}" → ${expected}`, () => {
      assert.equal(matchesNoProxy(target(url), noProxy), expected);
    });
  }
});

describe('loopback detection', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
    test(`${host} is loopback`, () => assert.equal(isLoopback(host), true));
  }
  for (const host of ['api.polyzon.org', '10.0.0.1', '128.0.0.1', 'localhost.evil.com', '[::2]']) {
    test(`${host} is not loopback`, () => assert.equal(isLoopback(host), false));
  }
});

describe('proxy URL parsing', () => {
  test('credentials are percent-decoded into Basic auth and dropped from the URL', () => {
    const proxy = parseProxy('http://us%40er:p%3Ass%20w@proxy.corp:3128/ignored?x');
    assert.equal(proxy.url.href, 'http://proxy.corp:3128/');
    assert.equal(proxy.authorization, basic('us@er', 'p:ss w'));
  });

  test('no credentials → no authorization; a scheme-less value means http://', () => {
    const proxy = parseProxy('proxy.corp:3128');
    assert.equal(proxy.url.href, 'http://proxy.corp:3128/');
    assert.equal(proxy.authorization, null);
    assert.equal(parseProxy(new URL('https://p.example')).url.protocol, 'https:');
  });

  test('user without password', () => {
    assert.equal(parseProxy('http://bob@p:1').authorization, basic('bob', ''));
  });

  for (const [name, value] of [
    ['socks5', 'socks5://u:secret@p:1080'],
    ['garbage', 'http://'],
    ['bad percent-encoding', 'http://u:%E0%A4%A@p:1'],
  ]) {
    test(`rejects ${name} without echoing credentials`, () => {
      assert.throws(
        () => parseProxy(value),
        (error) =>
          error instanceof TypeError && !error.message.includes('secret') && !error.message.includes('%E0'),
      );
    });
  }
});

describe('proxy environment', () => {
  const api = new URL('https://api.polyzon.org');
  const href = (env, target = api) => proxyFromEnv(target, env)?.url.href ?? null;

  test('nothing set → no proxy', () => assert.equal(href({}), null));
  test('https_proxy wins over HTTPS_PROXY', () => {
    assert.equal(href({ https_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:1' }), 'http://a:1/');
    assert.equal(href({ HTTPS_PROXY: 'http://b:1' }), 'http://b:1/');
  });
  test('HTTPS targets fall back to http_proxy / HTTP_PROXY', () => {
    assert.equal(href({ http_proxy: 'http://c:1' }), 'http://c:1/');
    assert.equal(href({ HTTP_PROXY: 'http://d:1', http_proxy: '' }), 'http://d:1/');
  });
  test('http targets ignore HTTPS_PROXY', () => {
    const plain = new URL('http://api.polyzon.test');
    assert.equal(href({ HTTPS_PROXY: 'http://b:1' }, plain), null);
    assert.equal(href({ HTTP_PROXY: 'http://d:1' }, plain), 'http://d:1/');
  });
  test('blank values are ignored', () => assert.equal(href({ HTTPS_PROXY: '  ' }), null));
  test('NO_PROXY / no_proxy exempt targets', () => {
    assert.equal(href({ HTTPS_PROXY: 'http://b:1', NO_PROXY: 'polyzon.org' }), null);
    assert.equal(href({ HTTPS_PROXY: 'http://b:1', no_proxy: '*' }), null);
    assert.equal(href({ HTTPS_PROXY: 'http://b:1', NO_PROXY: 'example.com' }), 'http://b:1/');
  });
  test('loopback is never proxied by the environment', () => {
    for (const url of ['https://localhost:8443', 'http://127.0.0.1:1', 'http://[::1]:1']) {
      assert.equal(href({ HTTPS_PROXY: 'http://b:1', HTTP_PROXY: 'http://b:1' }, new URL(url)), null);
    }
  });
  test('an invalid env proxy names the variable, not its value', () => {
    assert.throws(
      () => proxyFromEnv(api, { HTTPS_PROXY: 'socks5://u:secret@p:1' }),
      (error) =>
        error instanceof TypeError && /HTTPS_PROXY/.test(error.message) && !/secret/.test(error.message),
    );
  });
});

describe('explicit http proxy, http loopback target (absolute-form)', () => {
  let target;
  let proxy;
  before(async () => {
    target = await startServer((req, res) => json(res, 200, LIMITS));
    proxy = await startProxy({ auth: basic('user', 'p@ss:w0rd') });
  });
  after(async () => {
    await proxy.close();
    await target.close();
  });

  const proxied = (auth) => new URL(proxy.url).host.replace(/^/, `http://${auth}@`);

  test('the proxy receives GET http://host/path with Proxy-Authorization', async () => {
    const client = new Polyzon({ apiKey: TOKEN, baseURL: target.url, proxy: proxied('user:p%40ss%3Aw0rd') });
    assert.deepEqual(await client.limits(), LIMITS);
    const seen = proxy.requests.at(-1);
    assert.equal(seen.url, `${target.url}/v1/limits`);
    assert.equal(seen.headers.host, new URL(target.url).host);
    assert.equal(seen.headers['proxy-authorization'], basic('user', 'p@ss:w0rd'));
    assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(target.requests.at(-1).url, '/v1/limits');
    client.close();
  });

  test('wrong credentials → 407 surfaces as an APIError; the password is not in it', async () => {
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: target.url,
      proxy: proxied('user:wrong-secret'),
      maxRetries: 0,
    });
    await assert.rejects(client.limits(), (error) => {
      assert.equal(error.status, 407);
      assert.ok(!error.message.includes('wrong-secret'));
      return true;
    });
    client.close();
  });

  test('loopback targets ignore env proxies', async () => {
    await withEnv({ ...NO_PROXY_ENV, HTTP_PROXY: proxy.url }, async () => {
      const before = proxy.requests.length;
      const client = new Polyzon({ apiKey: TOKEN, baseURL: target.url });
      await client.limits();
      assert.equal(proxy.requests.length, before);
      client.close();
    });
  });
});

const certificate = makeCertificate();
const skip = certificate
  ? false
  : 'openssl CLI not found: cannot make a test certificate for the CONNECT tests';

describe('CONNECT tunnel to an HTTPS target', { skip }, () => {
  const tls = certificate ?? {};
  let target;
  let proxy;
  let tlsProxy;
  before(async () => {
    target = await startServer((req, res) => json(res, 200, req.url === '/v1/me' ? ME : LIMITS), tls);
    proxy = await startProxy({ auth: basic('tunnel', 's3cret!') });
    tlsProxy = await startProxy({ tlsOptions: tls });
  });
  after(async () => {
    await Promise.all([proxy.close(), tlsProxy.close(), target.close()]);
  });

  // A non-loopback name: the test proxy tunnels every CONNECT to 127.0.0.1:<port>.
  const baseURL = () => `https://api.polyzon.test:${target.port}`;
  const proxyURL = () => `http://tunnel:s3cret%21@127.0.0.1:${proxy.port}`;

  test('end-to-end TLS through the tunnel; keep-alive reuses it', async () => {
    const connects = proxy.connects.length;
    const client = new Polyzon({ apiKey: TOKEN, baseURL: baseURL(), proxy: proxyURL(), ca: tls.cert });
    assert.deepEqual(await client.me(), ME);
    assert.deepEqual(await client.limits(), LIMITS);
    assert.equal(proxy.connects.length, connects + 1, 'one tunnel for both requests');
    const connect = proxy.connects.at(-1);
    assert.equal(connect.url, `api.polyzon.test:${target.port}`);
    assert.equal(connect.headers['proxy-authorization'], basic('tunnel', 's3cret!'));
    assert.equal(connect.headers.authorization, undefined, 'the proxy never sees the token');
    assert.equal(target.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
    client.close();
  });

  test('HTTPS_PROXY from the environment is used', async () => {
    await withEnv({ ...NO_PROXY_ENV, HTTPS_PROXY: proxyURL() }, async () => {
      const connects = proxy.connects.length;
      const client = new Polyzon({ apiKey: TOKEN, baseURL: baseURL(), ca: tls.cert });
      assert.deepEqual(await client.limits(), LIMITS);
      assert.equal(proxy.connects.length, connects + 1);
      client.close();
    });
  });

  test('NO_PROXY and proxy: false bypass the environment proxy', async () => {
    await withEnv({ ...NO_PROXY_ENV, HTTPS_PROXY: proxyURL(), NO_PROXY: 'polyzon.test' }, async () => {
      const connects = proxy.connects.length;
      // Direct: api.polyzon.test does not resolve, so this fails — without touching the proxy.
      const viaNoProxy = new Polyzon({
        apiKey: TOKEN,
        baseURL: baseURL(),
        ca: tls.cert,
        maxRetries: 0,
        timeout: 3000,
      });
      await assert.rejects(viaNoProxy.limits(), APIConnectionError);
      delete process.env.NO_PROXY;
      const disabled = new Polyzon({
        apiKey: TOKEN,
        baseURL: baseURL(),
        ca: tls.cert,
        maxRetries: 0,
        timeout: 3000,
        proxy: false,
      });
      await assert.rejects(disabled.limits(), APIConnectionError);
      assert.equal(proxy.connects.length, connects);
    });
  });

  test('TLS is verified: without the CA the tunnel fails', async () => {
    const client = new Polyzon({ apiKey: TOKEN, baseURL: baseURL(), proxy: proxyURL(), maxRetries: 0 });
    await assert.rejects(client.limits(), (error) => {
      assert.ok(error instanceof APIConnectionError);
      assert.match(error.message, /certificate/i);
      return true;
    });
    client.close();
  });

  test('TLS is verified: a name the certificate does not cover fails', async () => {
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: `https://wrong.polyzon.test:${target.port}`,
      proxy: proxyURL(),
      ca: tls.cert,
      maxRetries: 0,
    });
    await assert.rejects(client.limits(), (error) => {
      assert.ok(error instanceof APIConnectionError);
      assert.match(error.message, /altnames|hostname|certificate/i);
      return true;
    });
    client.close();
  });

  test('407 from the proxy → APIConnectionError without the password', async () => {
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: baseURL(),
      proxy: `http://tunnel:wrong-secret@127.0.0.1:${proxy.port}`,
      ca: tls.cert,
      maxRetries: 0,
    });
    await assert.rejects(client.limits(), (error) => {
      assert.ok(error instanceof APIConnectionError);
      assert.match(error.message, /407/);
      assert.ok(!error.message.includes('wrong-secret'));
      assert.ok(!String(error.cause?.message).includes('wrong-secret'));
      return true;
    });
    client.close();
  });

  test('an unreachable proxy → APIConnectionError', async () => {
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: baseURL(),
      proxy: 'http://user:hidden@127.0.0.1:1',
      maxRetries: 0,
    });
    await assert.rejects(client.limits(), (error) => {
      assert.ok(error instanceof APIConnectionError);
      assert.ok(!error.message.includes('hidden'));
      return true;
    });
    client.close();
  });

  test('a proxy that never answers CONNECT is cut off', async () => {
    const sockets = [];
    const silent = net.createServer((socket) => sockets.push(socket));
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: baseURL(),
      proxy: `http://127.0.0.1:${silent.address().port}`,
      timeout: 200,
      maxRetries: 0,
    });
    try {
      // The request may wait longer; the tunnel gives up after the client timeout.
      await assert.rejects(client.limits({ timeout: 10_000 }), (error) => {
        assert.ok(error instanceof APIConnectionError);
        assert.match(error.message, /did not answer CONNECT within 200 ms/);
        return true;
      });
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  test('an https:// proxy (TLS to the proxy, then TLS inside)', async () => {
    const client = new Polyzon({
      apiKey: TOKEN,
      baseURL: baseURL(),
      proxy: `https://localhost:${tlsProxy.port}`,
      ca: tls.cert,
    });
    assert.deepEqual(await client.limits(), LIMITS);
    assert.equal(tlsProxy.connects.at(-1).url, `api.polyzon.test:${target.port}`);
    client.close();
  });
});
