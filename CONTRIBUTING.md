# Contributing to `licenseleak`

Thanks for considering a contribution! This document covers how the
project is organized, how to run things locally, and what to expect when
you open a PR.

## Where the code lives

This repository (`licenseleak/cli`) is a **one-way release mirror** of the
`packages/cli/` directory in a private LicenseLeak monorepo. Every tagged
release on [npm](https://www.npmjs.com/package/licenseleak) lands here as
a single commit (the commit message back-references the upstream SHA), and
a matching `vX.Y.Z` git tag.

That means:

- **Issues:** open them here. We monitor this tracker.
- **PRs:** also open them here. Accepted PRs are replayed upstream by the
  maintainers and shipped in the next release. The exact commit SHA on
  this repo will differ from the merged change, but we'll credit you in
  the release notes and `CHANGELOG.md`.
- **Direct edits to `main` get overwritten** on the next release push.
  Don't push directly — open a PR.

The hosted scanner, similarity engine, benchmark corpus, and signed-report
pipeline are **not** part of this package — they live in the private
monorepo. The CLI is a thin client that calls the LicenseLeak API for
remote scans and runs a deterministic SPDX classifier locally.

## Local development

You'll need Node 18.17+ (we test against 18, 20, 22, 24) and npm.

```bash
git clone https://github.com/licenseleak/cli.git
cd cli
npm install
npm run typecheck   # tsc --noEmit
npm run build       # compiles src/ → dist/
npm test            # runs node:test against src/__tests__/
node bin/licenseleak.mjs --help   # smoke
```

To run the CLI against a local checkout while developing:

```bash
node bin/licenseleak.mjs scan /path/to/some/repo
```

The bin shim auto-falls-back to `tsx` against `src/index.ts` if `dist/`
isn't built, so iteration is fast.

## What kinds of contributions are welcome

**Especially welcome:**

- Bug reports with a minimal reproduction
- Lockfile / manifest parser improvements (e.g. new edge cases in
  `pnpm-lock.yaml`, `requirements.txt`, `Cargo.lock`, etc.)
- SPDX classifier improvements (false-positive / false-negative reductions)
- Documentation fixes
- Small UX polish (better error messages, clearer help text)
- New `--format` outputs (e.g. SARIF, JUnit) for CI integration

**Please open an issue first before starting work on:**

- New top-level commands
- Changes to the API client wire format (it talks to a hosted service)
- Changes to the `--fail-on` exit-code semantics (these break CI for
  existing users)

**Out of scope for this repo:**

- Changes to the hosted scanner heuristics (those live upstream)
- Changes to the benchmark corpus (also upstream)
- Anything involving the LicenseLeak web app, billing, or signed reports

## PR checklist

Before opening a PR, please:

1. Run `npm run typecheck && npm test` and confirm both pass
2. Add or update a test for any behavior change
3. Update `CHANGELOG.md` under an `## Unreleased` heading at the top
4. Keep the diff focused — one PR per logical change
5. Don't bump the package version in your PR (the maintainer does that
   at release time)

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess` on
- ESM throughout (`"type": "module"`)
- No new runtime dependencies without discussion — `commander` is
  intentionally the only one
- Prefer explicit error throws over silent fallbacks
- Match the existing style; we don't run a formatter, but `prettier`
  defaults are close

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](./LICENSE).

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
By participating, you agree to abide by its terms. Report unacceptable
behavior to <conduct@licenseleak.com>.

## Questions

Open a discussion or email <support@licenseleak.com>.
