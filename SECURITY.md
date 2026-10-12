# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | yes       |

Security fixes are released for the latest minor version of the current major version.

## Reporting a vulnerability

Email **security@polyzon.org**. Please include the affected version, a description of the issue, steps to
reproduce, and its impact. We acknowledge reports within three working days and keep you informed until
the fix is released. Please give us a reasonable time to fix the issue before disclosing it.

**Do not file security issues publicly** (GitHub issues, discussions, pull requests). In particular, never
post API tokens (`pzk_…`), proxy credentials, request logs with `Authorization` headers, or details of an
unfixed vulnerability in public. If a token leaked, revoke it at https://polyzon.org/account/ right away.

## Scope

This repository covers the Node.js SDK. Vulnerabilities of the API itself (api.polyzon.org) or of
polyzon.org can be reported to the same address.
