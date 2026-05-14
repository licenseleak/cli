// Remote scan from a local directory: package the working tree into a
// `.tar.gz`, POST it to /api/scans/upload, and poll the same way the
// URL-based remote scan does. The output shape is the same `Report` so the
// CLI's renderer treats both modes interchangeably.

import path from "node:path";
import fs from "node:fs/promises";
import type { Report, ReportFinding } from "./format.js";
import { ApiClient, type ApiScan } from "./api-client.js";
import { packTarGz, walkForUpload, TarPackError, type ExclusionSummary } from "./tar-pack.js";

export interface RemoteUploadScanOptions {
  client: ApiClient;
  rootDir: string;
  branch?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPack?: (info: { files: number; bytes: number; exclusions: ExclusionSummary }) => void;
  onUpload?: (info: { compressedBytes: number }) => void;
  onUploadProgress?: (sent: number, total: number) => void;
  onStatus?: (s: ApiScan) => void;
}

const TERMINAL = new Set<ApiScan["status"]>([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export async function runRemoteUploadScan(
  opts: RemoteUploadScanOptions,
): Promise<Report> {
  const interval = opts.pollIntervalMs ?? 3_000;
  const timeout = opts.timeoutMs ?? 15 * 60_000;

  const root = path.resolve(opts.rootDir);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }

  // Walk + pack are split so we can surface the file count up front (a slow
  // pack on a giant tree should at least show how many files were considered
  // before the user concludes the CLI is hung).
  let walked;
  try {
    walked = await walkForUpload({ rootDir: root });
  } catch (err) {
    if (err instanceof TarPackError) throw new Error(err.message);
    throw err;
  }
  if (walked.entries.length === 0) {
    throw new Error(
      `Nothing to upload from ${root} — every file matched a standard ignore or .gitignore rule.`,
    );
  }
  opts.onPack?.({
    files: walked.entries.length,
    bytes: walked.totalBytes,
    exclusions: walked.exclusions,
  });

  let tarball: Buffer;
  try {
    tarball = await packTarGz({
      entries: walked.entries,
      onProgress: () => { /* no-op for now; packing a few hundred MB is fast */ },
    });
  } catch (err) {
    if (err instanceof TarPackError) throw new Error(err.message);
    throw err;
  }
  opts.onUpload?.({ compressedBytes: tarball.length });

  const created = await opts.client.uploadScan({
    tarball,
    branch: opts.branch,
    exclusions: walked.exclusions,
    onProgress: opts.onUploadProgress,
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
    source: root,
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
