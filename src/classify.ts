// Vendored license-family classifier + risk scoring. Mirrors
// artifacts/api-server/src/scanner/licenseDb.ts and risk.ts so the CLI can run
// fully offline against a local path.
//
// We bundle a snapshot of the SPDX catalog (../spdx-snapshot.json, regenerated
// weekly by scripts/refresh-snapshot.mjs and the GitHub workflow at
// .github/workflows/refresh-cli-spdx.yml) so that newly added SPDX identifiers
// — e.g. a future AGPL-4.0 — are classified into the correct family the moment
// the user upgrades the CLI, instead of silently falling back to "unknown".
// The deterministic regex rules below remain as a safety net for ids that
// predate or never made it into the snapshot.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type LicenseFamily =
  | "agpl"
  | "gpl"
  | "sspl"
  | "lgpl"
  | "copyleft_other"
  | "permissive"
  | "unknown";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

const FAMILY_RULES: Array<{ re: RegExp; family: LicenseFamily }> = [
  { re: /^AGPL/i, family: "agpl" },
  { re: /^SSPL/i, family: "sspl" },
  { re: /^GPL/i, family: "gpl" },
  { re: /^LGPL/i, family: "lgpl" },
  {
    re: /^(EUPL|OSL|EPL|MPL|CDDL|CPL|MS-RL|BUSL|Commons-Clause|Elastic-2\.0)/i,
    family: "copyleft_other",
  },
  {
    re: /^(MIT|BSD|Apache|ISC|0BSD|Unlicense|Zlib|WTFPL|CC0|BlueOak|MS-PL|Python-2\.0|PostgreSQL)/i,
    family: "permissive",
  },
];

const FAMILY_ORDER: LicenseFamily[] = [
  "permissive",
  "lgpl",
  "copyleft_other",
  "gpl",
  "sspl",
  "agpl",
];

const VALID_FAMILIES: ReadonlySet<LicenseFamily> = new Set<LicenseFamily>([
  "agpl",
  "gpl",
  "sspl",
  "lgpl",
  "copyleft_other",
  "permissive",
  "unknown",
]);

interface SpdxSnapshot {
  source?: string;
  generatedAt?: string;
  count?: number;
  licenses: Record<string, string>;
}

function loadSnapshot(): Map<string, LicenseFamily> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Resolves to <package-root>/spdx-snapshot.json from both src/ (tsx tests)
    // and dist/ (published builds).
    const path = resolve(here, "..", "spdx-snapshot.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SpdxSnapshot;
    const map = new Map<string, LicenseFamily>();
    if (parsed && parsed.licenses && typeof parsed.licenses === "object") {
      for (const [id, fam] of Object.entries(parsed.licenses)) {
        if (typeof id !== "string" || typeof fam !== "string") continue;
        if (!VALID_FAMILIES.has(fam as LicenseFamily)) continue;
        map.set(id.toLowerCase(), fam as LicenseFamily);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

const SNAPSHOT: Map<string, LicenseFamily> = loadSnapshot();

/**
 * Test-only hook: register additional snapshot entries at runtime so unit
 * tests can prove the snapshot is consulted without rewriting the bundled
 * JSON. Not part of the public API.
 */
export function __addSnapshotEntryForTest(spdxId: string, family: LicenseFamily): void {
  SNAPSHOT.set(spdxId.trim().toLowerCase(), family);
}

function classifySingle(part: string): LicenseFamily {
  const hit = SNAPSHOT.get(part.toLowerCase());
  if (hit) return hit;
  for (const rule of FAMILY_RULES) if (rule.re.test(part)) return rule.family;
  return "unknown";
}

export function classifyLicense(spdx: string | null | undefined): LicenseFamily {
  if (!spdx) return "unknown";
  const id = spdx.trim();
  if (!id) return "unknown";
  const parts = id
    .split(/\s+OR\s+|\s+AND\s+|,/i)
    .map((s) => s.replace(/[()]/g, "").trim())
    .filter(Boolean);
  let strongest: LicenseFamily = "unknown";
  for (const part of parts) {
    const fam = classifySingle(part);
    if (fam === "unknown") continue;
    if (
      strongest === "unknown" ||
      FAMILY_ORDER.indexOf(fam) > FAMILY_ORDER.indexOf(strongest)
    ) {
      strongest = fam;
    }
  }
  return strongest;
}

const FAMILY_BAND: Record<LicenseFamily, { severity: Severity; band: string }> = {
  agpl: { severity: "critical", band: "$50k–$5M (must open-source product, existential)" },
  sspl: { severity: "critical", band: "$50k–$5M (cloud-distribution prohibition)" },
  gpl: { severity: "high", band: "$50k–$500k typical settlement" },
  copyleft_other: {
    severity: "medium",
    band: "$10k–$100k attribution + source obligations",
  },
  lgpl: { severity: "medium", band: "Low — dynamic-link OK, attribution required" },
  permissive: { severity: "info", band: "Attribution only" },
  unknown: { severity: "low", band: "Unknown — manual review" },
};

export function scoreFamily(family: LicenseFamily): { severity: Severity; band: string } {
  return FAMILY_BAND[family];
}

export const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}
