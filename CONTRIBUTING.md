# Contributing

Thanks for helping! Bug reports and pull requests are welcome at
https://github.com/PolyzonOrg/polyzon-node.

## Development

Requires Node.js 20.19+ (the lint and coverage scripts need Node.js 22+). The test suite generates a
throwaway TLS certificate with the `openssl` CLI; without it the proxy tunnel tests are skipped.

```sh
npm ci
npm run lint          # tsc --noEmit (strict) + eslint
npm run format:check  # prettier
npm test              # builds dist/ and runs the tests against it
npm run coverage      # tests with coverage thresholds (lines ≥ 90 %)
```

Tests use `node:test` against local mock servers; they never call the real API.

## Pull requests

- One focused change per pull request, with tests for new behaviour and fixed bugs.
- Keep the public API documented (TSDoc on every export) and update `README.md`, `README.ru.md` and the
  `Unreleased` section of `CHANGELOG.md`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for titles, e.g.
  `fix: honour Retry-After dates`, `feat: add …`.
- No new runtime dependencies.

## Releasing (maintainers)

Bump `version` in `package.json` and `src/version.ts`, move the changelog entries under the new version,
merge, then push a tag `vX.Y.Z`. The release workflow publishes to npm with provenance through npm
trusted publishing (configured for this repository, workflow `release.yml`, environment `npm`).
