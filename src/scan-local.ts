// Local scan: walk a directory's manifests + lockfiles, classify each
// dependency by license family, and produce findings for any non-permissive
// match. No network required; no source code is uploaded anywhere.

import path from "node:path";
import fs from "node:fs/promises";
import { parseAll, MAX_DIRS, MAX_DEPTH, type ParsedDep } from "./parsers.js";
import { classifyLicense, scoreFamily, type Severity } from "./classify.js";
import type { Report, ReportFinding } from "./format.js";

export interface LocalScanOptions {
  rootDir: string;
}

export async function runLocalScan(opts: LocalScanOptions): Promise<Report> {
  const abs = path.resolve(opts.rootDir);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${abs}`);
    }
  } catch (err) {
    throw new Error(
      `Cannot scan path: ${abs} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const { deps, walk } = await parseAll(abs);
  const findings: ReportFinding[] = [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const warnings: string[] = [];

  if (walk.truncated) {
    if (walk.reason === "dir_count") {
      warnings.push(
        `Directory walk stopped at the ${MAX_DIRS}-directory cap — manifests in deeper subdirectories were not scanned. ` +
          `Re-run against specific subpaths (e.g. \`licenseleak scan ./packages/foo\`) to cover the rest.`,
      );
    } else if (walk.reason === "max_depth") {
      warnings.push(
        `Directory walk stopped at depth ${MAX_DEPTH}` +
          (walk.hitDepthAt ? ` (first hit: ${path.relative(abs, walk.hitDepthAt) || "."})` : "") +
          ` — manifests below this depth were not scanned. Re-run against the deeper subpath directly to cover them.`,
      );
    }
  }

  for (const d of deps) {
    const family = classifyLicense(d.licenseSpdx);
    if (family === "permissive") continue; // not interesting
    if (family === "unknown" && !d.licenseSpdx) continue; // would flag every dep
    const { severity, band } = scoreFamily(family);
    counts[severity]++;
    findings.push({
      severity,
      licenseFamily: family,
      licenseSpdx: d.licenseSpdx,
      filePath: depDisplayPath(d),
      startLine: null,
      endLine: null,
      rationale: rationaleFor(d, family, band),
    });
  }

  return {
    source: abs,
    mode: "local",
    counts,
    findings,
    warnings: warnings.length ? warnings : undefined,
  };
}

function depDisplayPath(d: ParsedDep): string {
  const ver = d.version ? `@${d.version}` : "";
  return `${d.manifest} → ${d.pkg}${ver}`;
}

function rationaleFor(
  d: ParsedDep,
  family: ReturnType<typeof classifyLicense>,
  band: string,
): string {
  if (family === "unknown") {
    return `Unknown license "${d.licenseSpdx ?? "n/a"}" — needs manual review.`;
  }
  return `${family.toUpperCase()} dependency · ${band}`;
}

// Re-exports for the JSON formatter.
export type { Severity };
