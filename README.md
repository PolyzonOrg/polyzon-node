# Polyzon Node.js SDK

The official Node.js / TypeScript client for the [Polyzon public API](https://api.polyzon.org): search
3D models across Thingiverse, Printables, MakerWorld, Cults3D and 20 more sites, and fetch model cards.
It has zero runtime dependencies, full TypeScript types, keep-alive connection pooling, automatic
retries, proxy support and typed errors.

[Русская версия](README.ru.md)

## Requirements

- Node.js 20.19 or newer (tested on 20.19, 22, 24 and 26).
- An API token from [polyzon.org/account](https://polyzon.org/account/) (section «API»).

## Installation

```sh
npm install polyzon
```

## Quick start

```js
import Polyzon from 'polyzon';

const client = new Polyzon(); // reads POLYZON_API_KEY

const page = await client.search({ q: 'дракон', size: 10, free: true });
for (const item of page.items) {
  console.log(`[${item.source}] ${item.title} — ${item.url}`);
}
```

More in [`examples/`](examples): quick start, pagination, concurrent batch, proxy.

## Authentication

Every request is authorised with your personal token (`pzk_…`). Pass it explicitly or set the
`POLYZON_API_KEY` environment variable:

```js
const client = new Polyzon({ apiKey: process.env.POLYZON_API_KEY });
```

The constructor validates the token (1–512 visible ASCII characters) and never prints it:
`console.log(client)` shows `pzk_Q7xR…`.

## Usage

All methods are `async` and accept an optional last argument with
[per-request options](#timeouts-and-cancellation).

### Search

```js
const page = await client.search({
  q: 'органайзер для инструментов', // required, Russian or English, up to 200 characters
  page: 1, // 1..100
  size: 20, // 1..50, page × size ≤ 2400
  sort: 'popular', // relevant | popular | newest | likes | makes | downloads
  free: true, // only free models
  sources: ['printables', 'thingiverse'],
  formats: ['stl', '3mf'],
  license: ['cc0', 'cc-by'],
  lang: 'en', // ru (default) | en — machine-translated titles and tags
});

page.total; // 1873
page.totalRelation; // 'eq' (exact) or 'gte' (lower bound)
page.hasMore; // is there a next page within the 2400-result window
page.partial; // part of the catalog did not answer
page.correctedQuery; // the typo-fixed query the server searched for, or null
page.items[0]; // { source, id, title, url, thumbnail, creator, license, price, formats, tags, stats, publishedAt }
```

Unset parameters are not sent. The known values are exported as `SOURCES`, `LICENSES`, `SORTS`, `LANGS`,
`PRICE_TYPES` and `TOTAL_RELATIONS`; any other string is accepted too, because new sources appear.

### Pagination

`searchAll` walks the pages lazily and yields items:

```js
for await (const item of client.searchAll({ q: 'shelf bracket', size: 50 })) {
  console.log(item.title);
  if (enough()) break;
}
```

It starts at `params.page` (default 1) and stops when `hasMore` is false, a page is empty, or at page
100 (the server's limit). **Every page costs one request of the daily quota**, so use `size: 50` and
`break` as soon as you have enough.

### Model card

```js
const model = await client.getModel('thingiverse', 'tv-1234567', { lang: 'en' });
model.description;
model.images; // URLs on the source's CDN
model.license; // { id: 'cc-by-nc', raw: 'Creative Commons - Attribution - Non-Commercial' } or null
model.copies; // the same model on other sites: [{ source, id }]
```

`source` and `id` are the ones from search items. They are validated before any request (`source`
matches `^[a-z0-9]{1,32}$`, `id` matches `^[A-Za-z0-9._-]{1,255}$` and is not `.` or `..`); an invalid
value throws `TypeError`.

### Many models at once

```js
const results = await client.getModels(page.items, { concurrency: 4, lang: 'en' });
for (const result of results) {
  if (result.error) console.error(result.source, result.id, result.error.message);
  else console.log(result.model.title);
}
```

`getModels` runs at most `concurrency` requests at a time (default 4) and returns one result per
reference **in input order**. It never rejects because of one model: each result holds either `model`
or `error`. After an `AuthenticationError`, `PermissionDeniedError` or `QuotaExceededError` the
references not yet started get that same error without a request. Each model costs one request of the
daily quota.

### Account and limits

```js
const me = await client.me(); // { account: { id, displayName, createdAt }, token: { id, name, prefix, createdAt } }
const limits = await client.limits(); // { perMinute: { limit, used, remaining, resetAt }, daily: { … } }
```

Neither costs daily quota (they still count toward the per-minute limit).

## Response metadata

Every result has a non-enumerable `meta` property: it is not part of `JSON.stringify`, spreading,
`util.inspect` or deep-equality checks, so results stay plain data.

```js
const page = await client.search({ q: 'ваза' });
page.meta.requestId; // X-Request-ID — quote it when contacting support
page.meta.rateLimit; // { limit: 200, remaining: 163, resetAt: 1791590400 } — the daily quota, or null
```

## Errors

Every failed request throws a subclass of `PolyzonError`:

| Error                   | When                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `APIConnectionError`    | network failure: DNS, TCP, TLS, proxy, connection reset                                                               |
| `APITimeoutError`       | an attempt took longer than `timeout` (subclass of `APIConnectionError`)                                              |
| `InvalidResponseError`  | a 2xx answer whose body is not a JSON object or exceeds 8 MiB                                                         |
| `BadRequestError`       | 400: `bad_request` (see `error.param`) or `page_too_deep`                                                             |
| `AuthenticationError`   | 401: `unauthorized` (no token) or `invalid_token` (wrong or revoked)                                                  |
| `PermissionDeniedError` | 403 `account_action_required`: accept the current terms at [polyzon.org/account](https://polyzon.org/account/)        |
| `NotFoundError`         | 404 `not_found`                                                                                                       |
| `GoneError`             | 410 `gone`: the model was removed at the right holder's request — **delete your copy too**                            |
| `RateLimitError`        | 429 `rate_limited`: more than 20 requests a minute (retried automatically)                                            |
| `QuotaExceededError`    | 429 `quota_exceeded`: the daily quota is spent until 00:00 UTC (subclass of `RateLimitError`, never retried)          |
| `InternalServerError`   | 5xx: `unavailable`, `internal`, edge errors                                                                           |
| `APIError`              | any other HTTP error, including an unexpected 3xx (redirects are never followed); base class of the HTTP errors above |

`APIError` carries `status`, `code` (stable machine-readable reason, or `null`), `title`, `detail` (usually in
Russian), `param`, `requestId`, `retryAfter` (seconds or `null`), `headers` and `body`. Its message reads
`401 invalid_token: Токен не найден или отозван. (request id …)`.

```js
import { GoneError, NotFoundError, QuotaExceededError } from 'polyzon';

try {
  await client.getModel('printables', 'pr-123456');
} catch (error) {
  if (error instanceof GoneError) await db.delete('printables', 'pr-123456');
  else if (error instanceof NotFoundError) console.warn('no such model');
  else if (error instanceof QuotaExceededError)
    console.warn(`quota is spent, retry in ${error.retryAfter} s`);
  else throw error;
}
```

Invalid arguments throw the standard `TypeError` / `RangeError` before any request. An aborted request
rejects with the `AbortSignal`'s reason.

## Retries

Failed requests are retried up to `maxRetries` times (default 2) on connection errors, timeouts, HTTP
500, 502, 503, 504 and 429 `rate_limited`. The delay is the server's `Retry-After` when present (at most
60 seconds — if the server asks for longer, the error is thrown at once), otherwise exponential backoff
`min(8 s, 0.5 s × 2^attempt)` with jitter. `quota_exceeded` and other 4xx errors are never retried.

```js
const client = new Polyzon({ maxRetries: 5 }); // or 0 to disable
await client.search({ q: 'x' }, { maxRetries: 0 }); // per request
```

## Timeouts and cancellation

`timeout` limits each attempt (connect + response), in milliseconds; default 30 000. A timed-out attempt
destroys its socket and throws `APITimeoutError` (after the retries).

```js
const client = new Polyzon({ timeout: 10_000 });
await client.me({ timeout: 2_000, signal: AbortSignal.timeout(5_000) });
```

Every method takes `{ signal, timeout, maxRetries }` as its last argument. Aborting the signal stops the
request and any retry wait at once.

## Proxies

```js
const client = new Polyzon({ proxy: 'http://user:password@proxy.example.com:3128' });
```

- `http://` and `https://` proxies are supported; credentials in the URL (percent-encoded) become
  `Proxy-Authorization: Basic`. They are never logged or put into error messages.
- HTTPS requests go through an HTTP `CONNECT` tunnel with end-to-end TLS to `api.polyzon.org`: the
  proxy never sees your token. Connections through the tunnel are pooled and kept alive.
- Without the `proxy` option the client honours `HTTPS_PROXY` / `https_proxy` (falling back to
  `HTTP_PROXY` / `http_proxy`) and `NO_PROXY` / `no_proxy` (comma-separated hosts or domain suffixes,
  optional `:port`, or `*`; CIDR ranges are not supported). Loopback hosts are never proxied.
  `proxy: false` ignores the environment.
- SOCKS: pass an agent, e.g. `new Polyzon({ agent: new SocksProxyAgent('socks5://127.0.0.1:1080') })`
  from [`socks-proxy-agent`](https://www.npmjs.com/package/socks-proxy-agent).

## Custom agent and CA

```js
import { readFileSync } from 'node:fs';

// A TLS-inspecting corporate proxy: trust its root certificate (TLS stays verified).
const client = new Polyzon({ ca: readFileSync('corporate-root-ca.pem') });

// Full control (mTLS, SOCKS, tests): your own http(s).Agent replaces the SDK's pool.
const custom = new Polyzon({ agent: new https.Agent({ keepAlive: true, cert, key }) });
```

TLS verification cannot be turned off. `agent` cannot be combined with `proxy`, `ca` or `maxConnections`.

## Concurrency

A client is immutable and safe for concurrent use: create one and share it. Requests use a keep-alive
pool of `maxConnections` sockets (default 10); extra concurrent requests wait for a free socket.

```js
const client = new Polyzon({ maxConnections: 20 });
const [a, b] = await Promise.all([client.search({ q: 'ваза' }), client.search({ q: 'vase' })]);

// Same pool, different settings — e.g. one client per end-user token:
const forUser = client.withOptions({ apiKey: userToken, maxRetries: 0 });
```

`withOptions` accepts `apiKey`, `timeout`, `maxRetries`, `userAgent` and `logger`. `client.close()`
destroys the pooled sockets (shared by derived clients); it is optional, since idle sockets do not keep
the process alive.

Node.js is asynchronous by nature: every method returns a promise, and `searchAll` is an async iterable.

## Logging

```js
const client = new Polyzon({ logger: console });
```

The logger gets `debug` lines (method, path with query, status, attempt, duration) and `warn` lines for
retries (reason and delay). It never gets headers or the token. Any object with `debug(message)` and
`warn(message)` works (pino, winston, …).

## Rate limits and quota

- 20 requests per minute per account, all methods.
- 200 requests per UTC day per account for `search` and `getModel` (`me` and `limits` are free).
  Every `searchAll` page and every `getModels` item counts.
- The server charges the quota **before** validating parameters, so even a `400` costs a request.
- Quotas are per account, not per token: several tokens do not multiply them.

Check them with `client.limits()` or `result.meta.rateLimit` (daily window after the request).
`QuotaExceededError.retryAfter` tells when the day resets.

## CommonJS

The package is ESM-only. On Node.js 20.19+ `require()` loads ES modules, so CommonJS code works too:

```js
const { Polyzon } = require('polyzon');
```

## User-Agent

Requests send `User-Agent: polyzon-node/1.0.0 (node 24.20.0; linux/x64)`. Add your app with
`new Polyzon({ userAgent: 'my-bot/2.1' })`.

## Versioning

This package follows [Semantic Versioning](https://semver.org). Breaking changes of the public API (the
exports of `polyzon` and their TypeScript types) only come with a new major version. See
[CHANGELOG.md](CHANGELOG.md).

## Security

**Never ship your token to browsers or mobile apps — keep it server-side.** Anyone holding it can spend
your quota. The client only talks HTTPS (plain `http://` is accepted for `localhost` only), never follows
redirects, always verifies TLS and caps response bodies at 8 MiB. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Links

- API documentation and sandbox: https://api.polyzon.org
- Tokens: https://polyzon.org/account/
- Issues: https://github.com/PolyzonOrg/polyzon-node/issues

> If you use the free Polyzon API, it would be great if you mentioned Polyzon (for example, with a link to [polyzon.org](https://polyzon.org)) on the pages of your project where the API is used.

## License

[MIT](LICENSE)
