# licenseleak

Local-first license compliance scanner. Find AGPL / GPL / SSPL contamination
in your codebase — including the bits Copilot, Cursor, and friends quietly
pasted in — before your acquirer does.

## Quickstart (30 seconds)

```bash
# Scan the current directory locally — no signup, no upload
npx licenseleak scan .

# Scan a remote GitHub repo via the hosted API (requires an API key)
npx licenseleak login
npx licenseleak scan https://github.com/your-org/your-repo
```

`scan` exits with code `1` if any **critical** finding is present (override
with `--fail-on high|medium|low|none`), so you can drop it into a pre-commit
hook or any CI without copy-pasting YAML.

## Commands

| Command | Description |
| --- | --- |
| `licenseleak scan <path-or-url>` | Scan a local path (default) or a `https://github.com/...` URL. |
| `licenseleak login` | Save an API key to `~/.licenseleak/config.json` (mode `0600`). |
| `licenseleak logout` | Remove the saved API key. |
| `licenseleak whoami` | Print the account, plan, and credit balance for the saved key. |
| `licenseleak --help` | Full flag reference. |

## Flags

- `--remote` — force a remote scan even when given a local-looking path.
- `--branch <name>` — branch to scan (remote only).
- `--format <text|json>` — emit a structured JSON report for piping into
  other tooling. Same shape as the hosted API's findings response.
- `--fail-on <critical|high|medium|low|none>` — exit-code threshold. Default
  `critical`.
- `--no-hints` — suppress the one-line "scanned offline" hint printed after a
  successful local scan in text mode. Useful for CI logs and power users.

## Excluding files from upload

Remote uploads (`licenseleak scan <path>`, with auto-remote on, or
`--remote`) walk your working directory and apply two ignore files:

1. `.gitignore` — read from the repo root, matching `git check-ignore`
   semantics (anchoring, `dir/` directory-only, `!negation`).
2. `.licenseleakignore` — same syntax as `.gitignore`, **additive on top**.
   Use it to exclude paths you want git to track but don't want
   LicenseLeak to scan (e.g. vendored fixtures, generated test snapshots,
   one specific package in a monorepo). A `!pattern` line can re-include
   a path that `.gitignore` would have excluded.

The CLI prints a one-line summary to stderr after packing:

```
  excluded 142 file(s) by .gitignore, 7 by .licenseleakignore
```

The active `.licenseleakignore` patterns and per-source counts are sent
with the upload, persisted on the scan record, embedded in the signed
manifest, and shown under "Exclusions" in the public HTML / PDF report
so anyone reviewing the report can see exactly what scope you scanned.

## Auth

The CLI reads its API key from, in order:

1. `LICENSELEAK_API_KEY` environment variable.
2. `~/.licenseleak/config.json` (created by `licenseleak login`, file mode
   `0600`).

Generate a key from the
[Settings → API keys](https://licenseleak.com/app/settings) page.
The key is sent as `Authorization: Bearer ll_live_…`.

## Network access

The default `licenseleak scan <path>` command is **fully offline**: it reads
manifests and lockfiles from disk, classifies them locally, and prints the
result. No source code, dependency list, telemetry, or update check is sent
anywhere.

Outbound HTTP requests are made **only** by the following commands and flags:

| Trigger | Endpoint | What is sent |
| --- | --- | --- |
| `licenseleak scan https://github.com/...` | Hosted API (`POST /api/scans`) | The repo URL and optional branch name. |
| `licenseleak scan <path> --remote` | Hosted API (`POST /api/scans/upload`) | A gzipped tarball of your working directory, plus the active `.licenseleakignore` patterns and per-source excluded-file counts (sent as `X-Licenseleak-Ignore-Patterns` / `X-Licenseleak-Excluded-Counts` headers and embedded in the signed manifest). |
| `licenseleak whoami` | Hosted API (`GET /api/me`) | Your API key, to look up account / plan / credits. |

`licenseleak login` and `licenseleak logout` make no network calls — they
only read/write `~/.licenseleak/config.json` (mode `0600`). The saved key
is then used by the commands above.

That is the complete list. No other command, flag, or code path in this CLI
opens a network connection. There is no telemetry, no auto-update check, no
crash reporter, no analytics beacon.

## Local vs remote

- **Local** (default for paths): walks the directory's manifests and
  lockfiles for npm, pip, go, cargo, ruby, and php; classifies each
  dependency by SPDX license family; reports any non-permissive match. No
  source code or telemetry is uploaded anywhere. Best for a fast pre-commit
  sniff test.
- **Remote** (default for `https://` URLs, or `--remote`): submits the repo
  URL to the hosted scanner, which performs deep AST fingerprinting against a
  copyleft corpus and produces a signed PDF. Polls until terminal and prints
  the same colorized table.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Scan completed and no finding met the `--fail-on` threshold. |
| `1` | Scan completed and at least one finding met the threshold. |
| `2` | Scanner error, auth failure, invalid arguments. |

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).

## Source of truth

This repository (`licenseleak/cli`) is a one-way release mirror of
`packages/cli/` from the LicenseLeak monorepo. Each tagged release on
[npm](https://www.npmjs.com/package/licenseleak) lands here as a single
commit (with a back-reference to the upstream commit SHA), and a matching
`vX.Y.Z` git tag.

- **Issues and discussions:** open them on this repo —
  <https://github.com/licenseleak/cli/issues>
- **Pull requests:** also welcome on this repo. Accepted PRs are replayed
  upstream by the maintainers and shipped in the next release.
- **The hosted scanner, similarity engine, benchmark corpus, and signed-
  report pipeline live in the private monorepo and are not part of this
  package** — the CLI is a thin client that calls the LicenseLeak API for
  remote scans and runs a deterministic SPDX classifier locally.
