# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-11

### Added

- `Polyzon` client for the Polyzon public API: `search`, `searchAll` (lazy async pagination), `getModel`,
  `getModels` (bounded-concurrency batch with per-item results), `me`, `limits`.
- Response metadata (`meta.requestId`, `meta.rateLimit`) on every result.
- Typed error hierarchy: `PolyzonError`, `APIConnectionError`, `APITimeoutError`, `InvalidResponseError`,
  `APIError`, `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`,
  `GoneError`, `RateLimitError`, `QuotaExceededError`, `InternalServerError`.
- Automatic retries with capped `Retry-After` and jittered exponential backoff; per-attempt timeouts;
  `AbortSignal` cancellation.
- Keep-alive connection pooling, `withOptions` sharing the pool, `close()`.
- HTTP(S) proxies with CONNECT tunnelling and proxy authentication, `HTTPS_PROXY` / `HTTP_PROXY` /
  `NO_PROXY` support, custom `agent` and `ca` options.
- Constants of known sources, licenses, sort orders and languages.

[Unreleased]: https://github.com/PolyzonOrg/polyzon-node/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/PolyzonOrg/polyzon-node/releases/tag/v1.0.0
