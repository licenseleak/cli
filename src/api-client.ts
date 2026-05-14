// Minimal client for the hosted LicenseLeak API. Avoids pulling in the
// generated react SDK to keep the CLI lean and dependency-free.

export interface ApiClientOptions {
  base: string;
  apiKey: string;
  userAgent: string;
}

export interface ApiScan {
  id: string;
  status:
    | "pending"
    | "queued"
    | "cloning"
    | "scanning"
    | "signing"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  progress: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  publicUrl?: string | null;
  publicSlug?: string | null;
  errorMessage?: string | null;
  queuePosition?: number | null;
  repoUrl: string;
}

export interface ApiFinding {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  licenseFamily:
    | "agpl"
    | "gpl"
    | "sspl"
    | "lgpl"
    | "copyleft_other"
    | "permissive"
    | "unknown";
  licenseSpdx: string | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  rationale: string;
}

export interface ApiMe {
  userId: string;
  email?: string;
  plan: string;
  credits: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private async request<T>(
    method: "GET" | "POST",
    p: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(p.replace(/^\//, ""), this.opts.base.replace(/\/?$/, "/"));
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        Accept: "application/json",
        "User-Agent": this.opts.userAgent,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        msg = j.message || j.error || msg;
      } catch {
        if (text) msg = `${msg}: ${text.slice(0, 200)}`;
      }
      throw new ApiError(res.status, msg);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  me(): Promise<ApiMe> {
    return this.request<ApiMe>("GET", "/api/me");
  }

  createScan(body: { repoUrl: string; branch?: string }): Promise<ApiScan> {
    return this.request<ApiScan>("POST", "/api/scans", body);
  }

  getScan(id: string): Promise<ApiScan> {
    return this.request<ApiScan>("GET", `/api/scans/${id}`);
  }

  listFindings(id: string): Promise<ApiFinding[]> {
    return this.request<ApiFinding[]>("GET", `/api/scans/${id}/findings`);
  }

  // Upload a gzipped tarball of the user's working directory. The body is the
  // raw archive bytes (Content-Type: application/gzip). Branch is appended as
  // a query parameter — it's a label only, not a checkout target.
  //
  // We stream the body in fixed-size chunks via ReadableStream so we can
  // surface real upload progress to the caller. Each chunk is enqueued only
  // when fetch's consumer pulls it, which means the byte counter tracks the
  // socket drain rate fairly closely (modulo TLS/kernel buffering).
  async uploadScan(input: {
    tarball: Buffer;
    branch?: string;
    // CLI walker exclusion summary (Task #360). Sent as request headers so
    // the server can persist the active `.licenseleakignore` patterns + the
    // per-source removed-file counts on the scan row, then surface them in
    // the signed manifest and the public report's "Exclusions" section.
    // Headers (rather than a multipart body) keep the existing
    // application/gzip wire format unchanged.
    exclusions?: {
      counts: { gitignore: number; licenseleakignore: number };
      licenseleakignorePatterns: string[];
    };
    onProgress?: (sent: number, total: number) => void;
  }): Promise<ApiScan> {
    const qs = input.branch ? `?branch=${encodeURIComponent(input.branch)}` : "";
    const url = new URL(
      `api/scans/upload${qs}`,
      this.opts.base.replace(/\/?$/, "/"),
    );
    const total = input.tarball.length;
    const CHUNK = 64 * 1024; // 64 KB — small enough to feel live, big enough to avoid syscall overhead
    let sent = 0;
    // Initial 0% tick so the UI can render the bar before any bytes drain.
    input.onProgress?.(0, total);
    const tarball = input.tarball;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const end = Math.min(sent + CHUNK, total);
        // Subarray shares memory with the underlying Buffer — no copy.
        const chunk = new Uint8Array(
          tarball.buffer,
          tarball.byteOffset + sent,
          end - sent,
        );
        controller.enqueue(chunk);
        sent = end;
        input.onProgress?.(sent, total);
      },
    });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.opts.userAgent,
      "Content-Type": "application/gzip",
      "Content-Length": String(total),
    };
    if (input.exclusions) {
      // base64url-encoded JSON for the patterns header so arbitrary glob
      // characters survive HTTP header transport without escaping concerns.
      // The counts header stays as plain JSON since it's just two integers.
      headers["X-Licenseleak-Excluded-Counts"] = JSON.stringify(input.exclusions.counts);
      const patternsJson = JSON.stringify(input.exclusions.licenseleakignorePatterns);
      headers["X-Licenseleak-Ignore-Patterns"] = Buffer.from(patternsJson, "utf8").toString(
        "base64",
      );
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        msg = j.message || j.error || msg;
      } catch {
        if (text) msg = `${msg}: ${text.slice(0, 200)}`;
      }
      throw new ApiError(res.status, msg);
    }
    return JSON.parse(text) as ApiScan;
  }
}
