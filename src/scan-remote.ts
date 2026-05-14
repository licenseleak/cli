// Remote scan: submits a public GitHub repo URL to the hosted API, polls until
// terminal state, and returns the same Report shape as the local scanner so
// the CLI's renderer is mode-agnostic.

import type { Report, ReportFinding } from "./format.js";
import { ApiClient, type ApiScan } from "./api-client.js";

export interface RemoteScanOptions {
  client: ApiClient;
  repoUrl: string;
  branch?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (s: ApiScan) => void;
}

const TERMINAL = new Set<ApiScan["status"]>([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export async function runRemoteScan(opts: RemoteScanOptions): Promise<Report> {
  const interval = opts.pollIntervalMs ?? 3_000;
  const timeout = opts.timeoutMs ?? 15 * 60_000;

  const created = await opts.client.createScan({
    repoUrl: opts.repoUrl,
    branch: opts.branch,
  });
  opts.onStatus?.(created);

  const started = Date.now();
  let scan = created;
  while (!TERMINAL.has(scan.status)) {
    if (Date.now() - started > timeout) {
      throw new Error(
        `Timed out after ${Math.round(timeout / 1000)}s waiting for scan ${scan.id} to finish.`,
      );
    }
    await sleep(interval);
    scan = await opts.client.getScan(scan.id);
    opts.onStatus?.(scan);
  }

  if (scan.status === "failed" || scan.status === "cancelled") {
    throw new Error(
      `Scan ${scan.id} ${scan.status}: ${scan.errorMessage ?? "no error message"}`,
    );
  }

  const findings = await opts.client.listFindings(scan.id);
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const out: ReportFinding[] = findings.map((f) => {
    counts[f.severity]++;
    return {
      severity: f.severity,
      licenseFamily: f.licenseFamily,
      licenseSpdx: f.licenseSpdx,
      filePath: f.filePath,
      startLine: f.startLine,
      endLine: f.endLine,
      rationale: f.rationale,
    };
  });

  return {
    source: opts.repoUrl,
    mode: "remote",
    scanId: scan.id,
    reportUrl: scan.publicUrl ?? undefined,
    counts,
    findings: out,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
