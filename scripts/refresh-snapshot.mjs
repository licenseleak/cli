#!/usr/bin/env node
// Regenerates packages/cli/spdx-snapshot.json from the canonical SPDX catalog
// at https://spdx.org/licenses/licenses.json. Mirrors the family taxonomy used
// by artifacts/api-server/src/scanner/spdxRefresh.ts so the CLI's offline
// classifier stays close to parity with the hosted scanner.
//
// Run manually (`node packages/cli/scripts/refresh-snapshot.mjs`) or via the
// scheduled GitHub workflow at .github/workflows/refresh-cli-spdx.yml. The
// generated JSON is committed and bundled into the npm package via the `files`
// array in package.json.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SPDX_URL = "https://spdx.org/licenses/licenses.json";
const TIMEOUT_MS = 30_000;

const FAMILY_RULES = [
  { re: /^AGPL/i, family: "agpl" },
  { re: /^SSPL/i, family: "sspl" },
  { re: /^GPL/i, family: "gpl" },
  { re: /^LGPL/i, family: "lgpl" },
  {
    re: /^(EUPL|OSL|EPL|MPL|CDDL|CPL|MS-RL|BUSL|Commons-Clause|Elastic-2\.0|RSAL)/i,
    family: "copyleft_other",
  },
];

function familyFor(spdxId) {
  for (const r of FAMILY_RULES) if (r.re.test(spdxId)) return r.family;
  return "permissive";
}

async function main() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let json;
  try {
    const r = await fetch(SPDX_URL, {
      headers: { Accept: "application/json", "User-Agent": "LicenseLeak-CLI-snapshot/1.0" },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.error(`SPDX fetch failed: HTTP ${r.status}`);
      process.exit(1);
    }
    json = await r.json();
  } finally {
    clearTimeout(t);
  }

  const entries = Array.isArray(json?.licenses) ? json.licenses : [];
  if (entries.length === 0) {
    console.error("SPDX response had no licenses");
    process.exit(1);
  }

  const licenses = {};
  for (const e of entries) {
    if (!e?.licenseId) continue;
    licenses[e.licenseId] = familyFor(e.licenseId);
  }

  const sortedKeys = Object.keys(licenses).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = licenses[k];

  const out = {
    source: SPDX_URL,
    generatedAt: new Date().toISOString(),
    count: sortedKeys.length,
    licenses: sorted,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, "..", "spdx-snapshot.json");
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${sortedKeys.length} SPDX entries to ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
