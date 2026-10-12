// Shared test helpers: local mock API servers, a proxy, fixtures. Tests import the BUILT
// package (dist/), so they check exactly what ships.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Polyzon } from '../dist/index.js';
import { hooks } from '../dist/client.js';

/** A realistic token: `pzk_` + 43 characters. */
export const TOKEN = `pzk_Q7xR2mVb${'A'.repeat(35)}`;

/** Examples from the server's OpenAPI document (api/src/lib/openapi.ts). */
export const ITEM = {
  source: 'thingiverse',
  id: 'tv-1234567',
  title: 'Дракон с подвижными сочленениями (пример)',
  url: 'https://www.thingiverse.com/thing:1234567',
  thumbnail: 'https://cdn.thingiverse.com/assets/dragon.jpg',
  creator: 'example_maker',
  license: 'cc-by-nc',
  price: { type: 'free', value: 0, currency: null, display: 'Бесплатно' },
  formats: ['stl'],
  tags: ['дракон', 'игрушка'],
  stats: { likes: 51234, comments: 870, makes: 3120, collects: 61000 },
  publishedAt: '2021-01-17T10:21:00Z',
};

export const SEARCH = {
  query: 'дракон',
  correctedQuery: null,
  didYouMean: null,
  total: 1873,
  totalRelation: 'eq',
  page: 1,
  size: 20,
  hasMore: true,
  partial: false,
  items: [ITEM],
};

export const MODEL = {
  ...ITEM,
  description: 'Дракон печатается целиком, без поддержек…',
  images: ['https://cdn.thingiverse.com/assets/dragon.jpg'],
  creatorUrl: 'https://www.thingiverse.com/example_maker',
  license: { id: 'cc-by-nc', raw: 'Creative Commons - Attribution - Non-Commercial' },
  category: 'Toys & Games',
  stats: { likes: 51234, comments: 870, makes: 3120, collects: 61000, downloads: 410000, views: 990000 },
  updatedAt: '2021-02-02T08:00:00Z',
  copies: [{ source: 'printables', id: 'pr-123456' }],
};

export const ME = {
  account: { id: '0f8c2a4e-…', displayName: 'Алексей', createdAt: '2026-03-14T10:00:00.000Z' },
  token: {
    id: '7d0e2f8a-…',
    name: 'Телеграм-бот',
    prefix: 'pzk_Q7xR2mVb',
    createdAt: '2026-10-09T08:15:00.000Z',
  },
};

export const LIMITS = {
  perMinute: { limit: 20, used: 1, remaining: 19, resetAt: 1791579180 },
  daily: { limit: 200, used: 37, remaining: 163, resetAt: 1791590400 },
};

/** Headers the API sends on a successful quota-charged answer. */
export const RATE_HEADERS = {
  'x-ratelimit-limit': '200',
  'x-ratelimit-remaining': '163',
  'x-ratelimit-reset': '1791590400',
  'x-request-id': 'req-123',
};

/** Writes a JSON answer. */
export function json(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

/** Writes an `application/problem+json` answer like the real API. */
export function problem(res, status, code, detail, headers = {}, extra = {}) {
  const titles = {
    400: 'Bad Request',
    401: 'Unauthorized',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  };
  res.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'x-request-id': 'req-err',
    ...(status === 503 ? { 'retry-after': '5' } : {}),
    ...headers,
  });
  res.end(
    JSON.stringify({ type: 'about:blank', title: titles[status] ?? 'Error', status, code, detail, ...extra }),
  );
}

function track(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/**
 * Starts a mock API on 127.0.0.1. `handler(req, res, n)` gets the 0-based request number.
 * Returns `{ url, port, requests, sockets, close }`; `requests` records method, url, headers.
 */
export async function startServer(handler, tlsOptions) {
  const requests = [];
  const server = tlsOptions ? https.createServer(tlsOptions) : http.createServer();
  server.on('request', (req, res) => {
    const n = requests.length;
    requests.push({ method: req.method, url: req.url, headers: req.headers, port: req.socket.remotePort });
    Promise.resolve(handler(req, res, n)).catch((error) => {
      res.destroy(error);
    });
  });
  const sockets = track(server);
  const port = await listen(server);
  return {
    url: `${tlsOptions ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Starts a forward proxy on 127.0.0.1: absolute-form GETs are forwarded, CONNECT opens a
 * tunnel to 127.0.0.1:<requested port> whatever host was asked for. With `auth`, requests
 * without that exact `Proxy-Authorization` get 407.
 */
export async function startProxy({ auth, tlsOptions } = {}) {
  const connects = [];
  const requests = [];
  const server = tlsOptions ? https.createServer(tlsOptions) : http.createServer();
  const upstreamAgent = new http.Agent({ keepAlive: false });
  server.on('request', (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (auth && req.headers['proxy-authorization'] !== auth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic' }).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(req.url, { method: req.method, headers, agent: upstreamAgent }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    upstream.end();
  });
  server.on('connect', (req, socket, head) => {
    connects.push({ url: req.url, headers: req.headers });
    socket.on('error', () => undefined);
    if (auth && req.headers['proxy-authorization'] !== auth) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = Number(req.url.split(':').pop());
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const sockets = track(server);
  const port = await listen(server);
  return {
    url: `${tlsOptions ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    connects,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A throwaway self-signed certificate for `api.polyzon.test`, `localhost` and 127.0.0.1,
 * made with the openssl CLI. `null` when openssl is not installed.
 */
export function makeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'polyzon-cert-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=api.polyzon.test',
        '-addext',
        'subjectAltName=DNS:api.polyzon.test,DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'pipe' },
    );
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A client for a mock server: test token, no env proxies. */
export function clientFor(server, options = {}) {
  return new Polyzon({ apiKey: TOKEN, baseURL: server.url, proxy: false, ...options });
}

/**
 * Makes retries instant: records each requested delay instead of sleeping (an aborted
 * signal still rejects). Returns the array of delays in milliseconds.
 */
export function instantRetries() {
  const delays = [];
  hooks.sleep = (ms, signal) => {
    delays.push(ms);
    return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  };
  return delays;
}

/** Runs `fn` with environment variables set (`undefined` deletes), then restores them. */
export async function withEnv(vars, fn) {
  const saved = {};
  for (const name of Object.keys(vars)) saved[name] = process.env[name];
  // Deletions first: on Windows HTTPS_PROXY and https_proxy are the same variable.
  for (const [name, value] of Object.entries(vars)) if (value === undefined) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) if (value !== undefined) process.env[name] = value;
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Every proxy-related variable unset. */
export const NO_PROXY_ENV = {
  HTTPS_PROXY: undefined,
  https_proxy: undefined,
  HTTP_PROXY: undefined,
  http_proxy: undefined,
  NO_PROXY: undefined,
  no_proxy: undefined,
};
