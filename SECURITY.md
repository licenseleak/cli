# Security Policy

## Supported versions

Only the most recent minor version of `licenseleak` on npm receives security
fixes. We backport critical fixes to the previous minor version on a
best-effort basis when there is a clear migration risk.

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

We strongly prefer reports through one of these private channels:

1. **GitHub private vulnerability reporting** (preferred) —
   <https://github.com/licenseleak/cli/security/advisories/new>.
   This creates a private advisory that only maintainers can see and lets us
   coordinate a fix and CVE assignment with you directly.

2. **Email** — <security@licenseleak.com>. PGP key available on request.
   Please include:
   - A description of the issue and its impact.
   - Steps to reproduce, or a proof-of-concept.
   - The version of `licenseleak` (or commit SHA) affected.
   - Your name / handle for credit (optional — anonymous reports are fine).

## What to expect

- **Acknowledgement:** within **2 business days** of your report.
- **Triage and severity assessment:** within **5 business days**, using
  [CVSS v3.1](https://www.first.org/cvss/calculator/3.1).
- **Fix timeline:** critical issues are patched and released within **7 days**
  of confirmation. High-severity issues within **14 days**. Lower-severity
  issues are bundled into the next regular release.
- **Disclosure:** we coordinate public disclosure with you. By default we
  publish a GitHub Security Advisory (and request a CVE where appropriate)
  the same day we ship the fixed version to npm.

## Scope

In scope:

- The `licenseleak` npm package and its CLI binary (this repo).
- The `bin/licenseleak.mjs` shim and everything under `src/` and `dist/`.
- Vendored data files (e.g. `spdx-snapshot.json`) if shipped with a
  vulnerability.

Out of scope (report directly to <security@licenseleak.com> instead):

- The hosted scanner API (<https://api.licenseleak.com>) — that lives in a
  separate codebase.
- The licenseleak.com web app.
- Third-party dependencies — please report upstream first; we will track and
  ship a bumped version.

## Safe-harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to follow this policy.
- Avoid privacy violations, destruction of data, and degradation of service.
- Give us reasonable time to fix the issue before public disclosure
  (typically 90 days, less for critical issues we can ship quickly).

Thank you for helping keep `licenseleak` and its users safe.
