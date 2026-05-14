# Changelog

## 0.4.0

### Added
- `.licenseleakignore` support for remote uploads (Task #360). The walker
  reads `.licenseleakignore` from the repo root, applies it **additively**
  on top of `.gitignore` (negation supported), and prints a one-line
  per-source exclusion summary to stderr after packing:

  ```
    excluded 142 file(s) by .gitignore, 7 by .licenseleakignore
  ```
- Active `.licenseleakignore` patterns and per-source excluded-file counts
  are forwarded to the hosted API as request headers
  (`X-Licenseleak-Ignore-Patterns`, `X-Licenseleak-Excluded-Counts`),
  persisted on the scan record, embedded in the signed manifest, and
  rendered under "Exclusions" in the public HTML / PDF report.

### Changed
- Bumped CLI version constant + package version to `0.4.0` (the previously
  shipped binary still self-reported `0.2.0`; both are now in sync).

## 0.3.0

- Initial published baseline of the remote-upload pipeline (`scan <path>`
  with auto-remote on, `--remote` flag, signed PDF reports).
