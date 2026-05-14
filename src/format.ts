// Renders the findings table that's printed at the end of every scan.
// Two output modes: a colorized text table (default) and a structured JSON
// payload (`--format json`) shaped to match the hosted API's PublicScan +
// Finding-list response, so consumers can pipe both modes interchangeably.

import { c, colorSeverity } from "./colors.js";
import type { LicenseFamily, Severity } from "./classify.js";

export interface ReportFinding {
  severity: Severity;
  licenseFamily: LicenseFamily;
  licenseSpdx: string | null;
  filePath: string;
  startLine?: number | null;
  endLine?: number | null;
  rationale: string;
}

export interface Report {
  source: string;
  mode: "local" | "remote";
  scanId?: string;
  reportUrl?: string;
  counts: { critical: number; high: number; medium: number; low: number; info: number };
  findings: ReportFinding[];
  // Non-fatal advisories surfaced alongside the findings — e.g. the local
  // walk truncated at MAX_DIRS / MAX_DEPTH so the user knows results may be
  // incomplete. Always rendered above the findings table; serialized as-is
  // in JSON mode so CI consumers can grep for them.
  warnings?: string[];
}

function pad(s: string, w: number): string {
  // ANSI-aware width: subtract escape sequences before counting.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const padN = Math.max(0, w - visible.length);
  return s + " ".repeat(padN);
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s;
  return s.slice(0, Math.max(0, w - 1)) + "…";
}

export function renderTable(report: Report): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold("LicenseLeak — ") + c.dim(report.source));

  const k = report.counts;
  const parts: string[] = [];
  if (k.critical) parts.push(c.bold(c.red(`${k.critical} critical`)));
  if (k.high) parts.push(c.red(`${k.high} high`));
  if (k.medium) parts.push(c.yellow(`${k.medium} medium`));
  if (k.low) parts.push(c.blue(`${k.low} low`));
  if (k.info) parts.push(c.gray(`${k.info} info`));
  if (!parts.length) parts.push(c.green("0 findings"));
  lines.push("  " + parts.join(c.dim(" · ")));

  if (report.reportUrl) {
    lines.push("  " + c.dim("Signed report: ") + c.cyan(report.reportUrl));
  }

  if (report.warnings?.length) {
    lines.push("");
    for (const w of report.warnings) {
      lines.push("  " + c.yellow("⚠ ") + w);
    }
  }

  if (!report.findings.length) {
    lines.push("");
    lines.push("  " + c.green("✓ No license-compliance issues detected."));
    lines.push("");
    return lines.join("\n");
  }

  lines.push("");
  const header =
    c.dim(pad("SEVERITY", 10)) +
    c.dim(pad("LICENSE", 18)) +
    c.dim(pad("LOCATION", 50)) +
    c.dim("DETAIL");
  lines.push("  " + header);
  lines.push("  " + c.dim("─".repeat(96)));

  // Show the top 50 findings sorted critical-first to keep terminal output
  // bounded; the JSON payload always contains the full list.
  const sorted = [...report.findings].sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
  const visible = sorted.slice(0, 50);

  for (const f of visible) {
    const loc =
      f.startLine != null && f.endLine != null
        ? `${f.filePath}:${f.startLine}-${f.endLine}`
        : f.filePath;
    const lic = f.licenseSpdx
      ? `${f.licenseSpdx} (${f.licenseFamily})`
      : f.licenseFamily;
    lines.push(
      "  " +
        pad(colorSeverity(f.severity), 10) +
        pad(truncate(lic, 17), 18) +
        pad(truncate(loc, 49), 50) +
        c.dim(truncate(f.rationale, 60)),
    );
  }
  if (sorted.length > visible.length) {
    lines.push(
      "  " +
        c.dim(
          `… and ${sorted.length - visible.length} more. Re-run with --format json for the full list.`,
        ),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function sevRank(s: Severity): number {
  return ["info", "low", "medium", "high", "critical"].indexOf(s);
}

export function shouldFail(
  report: Report,
  threshold: "critical" | "high" | "medium" | "low" | "none",
): boolean {
  if (threshold === "none") return false;
  const min = ["info", "low", "medium", "high", "critical"].indexOf(threshold);
  for (const f of report.findings) {
    if (sevRank(f.severity) >= min) return true;
  }
  return false;
}
