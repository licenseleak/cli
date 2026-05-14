// Minimal tar+gzip packer used by the CLI to ship a working directory to the
// hosted scanner. We deliberately don't pull in a third-party tar dependency:
//   * the CLI is shipped to end users and a smaller install size matters
//   * the tar shape we emit is constrained (we only need regular files +
//     directories, no devices / FIFOs / hardlinks)
//   * the server side validates everything on extract, so we just need a
//     conforming archive — not a feature-complete tar implementation.
//
// Format details:
//   * USTAR header (POSIX 1003.1-1990) for entries whose path fits the 100 +
//     155 byte name/prefix split.
//   * GNU LongLink (`L` typeflag, magic `././@LongLink`) for paths longer
//     than that — GNU tar and BSD tar both honor it. The corresponding
//     entry's name field is then truncated to 100 bytes (its content is
//     ignored in favor of the LongLink record).
//   * Regular files use type `0`; directories use type `5` with an empty
//     payload.
//   * uid/gid/mtime are set deterministically (0/0/Unix epoch) so two runs
//     of the same tree hash identically — useful when ops needs to attribute
//     a scan to a particular CLI invocation.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BLOCK = 512;

export interface PackEntry {
  // Path relative to the archive root, forward slashes only.
  archivePath: string;
  // Absolute path on disk (regular files only).
  absPath?: string;
  // True for directory entries.
  isDirectory?: boolean;
}

export interface PackOptions {
  entries: PackEntry[];
  // If set, abort with a friendly error once the compressed output exceeds
  // this byte count. Defaults to 100 MB to mirror the server-side cap.
  maxCompressedBytes?: number;
  // Periodic progress callback, invoked with the running uncompressed and
  // compressed byte counts (best-effort, not exact at completion).
  onProgress?: (uncompressed: number, compressed: number, packedFiles: number) => void;
}

export class TarPackError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TarPackError";
    this.code = code;
  }
}

export async function packTarGz(opts: PackOptions): Promise<Buffer> {
  const max = opts.maxCompressedBytes ?? 100 * 1024 * 1024;
  const gz = zlib.createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  let compressed = 0;
  let uncompressed = 0;
  let packed = 0;

  gz.on("data", (chunk: Buffer) => {
    compressed += chunk.length;
    chunks.push(chunk);
    if (compressed > max) {
      gz.destroy(
        new TarPackError(
          `Archive exceeds ${(max / (1024 * 1024)).toFixed(0)} MB compressed cap.`,
          "upload_too_large",
        ),
      );
    }
  });

  const source = new Readable({ read() { /* noop, pushed manually below */ } });
  const pipePromise = pipeline(source, gz);

  try {
    for (const ent of opts.entries) {
      const archivePath = normalizePath(ent.archivePath);
      if (!archivePath) continue;
      if (ent.isDirectory) {
        const header = buildHeaderWithLongName(archivePath, 0, "5", 0o755);
        for (const block of header) {
          source.push(block);
          uncompressed += block.length;
        }
      } else if (ent.absPath) {
        const stat = await fs.stat(ent.absPath);
        if (!stat.isFile()) continue;
        const size = stat.size;
        const header = buildHeaderWithLongName(archivePath, size, "0", 0o644);
        for (const block of header) {
          source.push(block);
          uncompressed += block.length;
        }
        const data = await fs.readFile(ent.absPath);
        source.push(data);
        uncompressed += data.length;
        const pad = padding(size);
        if (pad) {
          source.push(Buffer.alloc(pad, 0));
          uncompressed += pad;
        }
        packed++;
        if (opts.onProgress && packed % 25 === 0) opts.onProgress(uncompressed, compressed, packed);
      }
    }
    // Two trailing zero blocks terminate the archive.
    source.push(Buffer.alloc(BLOCK * 2, 0));
    uncompressed += BLOCK * 2;
    source.push(null);
    await pipePromise;
  } catch (err) {
    if (err instanceof TarPackError) throw err;
    throw new TarPackError(
      err instanceof Error ? err.message : String(err),
      "upload_pack_failed",
    );
  }
  if (opts.onProgress) opts.onProgress(uncompressed, compressed, packed);
  return Buffer.concat(chunks);
}

function normalizePath(p: string): string {
  // Always forward slashes; strip any leading "./" or "/"; drop ".." entirely
  // so a malicious manifest can't smuggle path-escape into the archive.
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!norm || norm === "." || norm.split("/").some((seg) => seg === "..")) return "";
  return norm;
}

function padding(size: number): number {
  const r = size % BLOCK;
  return r === 0 ? 0 : BLOCK - r;
}

// Build either a single ustar header (path fits the name/prefix split) OR a
// GNU LongLink header followed by a ustar header whose name is the truncated
// path. Returns one or more 512-byte blocks.
function buildHeaderWithLongName(
  archivePath: string,
  size: number,
  typeflag: string,
  mode: number,
): Buffer[] {
  const fits = splitName(archivePath);
  if (fits) {
    return [buildUstarHeader(fits.name, fits.prefix, size, typeflag, mode)];
  }
  // LongLink: payload is the full name + NUL, padded to 512.
  const nameBuf = Buffer.from(archivePath + "\0", "utf8");
  const longHeader = buildUstarHeader("././@LongLink", "", nameBuf.length, "L", 0o644);
  const padLen = padding(nameBuf.length);
  const longPayload = Buffer.concat([nameBuf, Buffer.alloc(padLen, 0)]);
  // The trailing real header still needs *some* name; the first 100 bytes of
  // the path is what GNU tar writes, so we mirror that.
  const truncated = archivePath.slice(0, 100);
  const realHeader = buildUstarHeader(truncated, "", size, typeflag, mode);
  return [longHeader, longPayload, realHeader];
}

function splitName(archivePath: string): { name: string; prefix: string } | null {
  const buf = Buffer.from(archivePath, "utf8");
  if (buf.length <= 100) return { name: archivePath, prefix: "" };
  // Find a "/" splitter such that prefix <= 155 and name <= 100 bytes.
  // Walk from the right looking for a slash that lands name in <=100.
  for (let i = archivePath.length - 1; i >= 0; i--) {
    if (archivePath[i] !== "/") continue;
    const name = archivePath.slice(i + 1);
    const prefix = archivePath.slice(0, i);
    if (Buffer.byteLength(name, "utf8") <= 100 && Buffer.byteLength(prefix, "utf8") <= 155) {
      return { name, prefix };
    }
  }
  return null;
}

function buildUstarHeader(
  name: string,
  prefix: string,
  size: number,
  typeflag: string,
  mode: number,
): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  writeStr(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime
  // Checksum field starts as spaces for the calculation.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header.write(typeflag, 156, 1, "ascii");
  // linkname (157..256): empty
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii"); // version
  // uname/gname omitted (root)
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  writeStr(header, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  writeOctal(header, 148, 7, sum);
  header[155] = 0x20;
  return header;
}

function writeStr(buf: Buffer, offset: number, length: number, value: string): void {
  const enc = Buffer.from(value, "utf8");
  enc.copy(buf, offset, 0, Math.min(enc.length, length));
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  // Field is octal ASCII, NUL-terminated (or space-terminated for checksum).
  const str = value.toString(8);
  const padded = str.padStart(length - 1, "0");
  buf.write(padded, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Directory walker with standard ignores + minimal .gitignore support.
// We deliberately implement only the subset of gitignore semantics that
// matters for the typical CLI use case: top-level patterns, leading slash
// rooting, trailing slash for directories, and `*` globs within a single
// segment. Negation (`!pattern`) is honored. Anything more exotic is simply
// not matched — the user's safety net is the 100 MB upload cap.

const STANDARD_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".parcel-cache",
  "out",
]);

export type IgnoreSource = "gitignore" | "licenseleakignore";

interface IgnoreRule {
  rx: RegExp;
  negate: boolean;
  dirOnly: boolean;
  source: IgnoreSource;
  raw: string;
}

function compilePatternToRegex(raw: string, source: IgnoreSource): IgnoreRule | null {
  let pat = raw.trim();
  if (!pat || pat.startsWith("#")) return null;
  let negate = false;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  }
  let dirOnly = false;
  if (pat.endsWith("/")) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }
  // Treat leading-slash patterns as anchored to the root.
  let anchored = false;
  if (pat.startsWith("/")) {
    anchored = true;
    pat = pat.slice(1);
  }
  // If the pattern contains a slash anywhere, it's also implicitly anchored.
  if (pat.includes("/")) anchored = true;

  // Convert glob to regex. We support *, ?, ** in their gitignore-ish meanings.
  let rx = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        rx += ".*";
        i++;
        if (pat[i + 1] === "/") i++;
      } else {
        rx += "[^/]*";
      }
    } else if (ch === "?") {
      rx += "[^/]";
    } else if (/[\\^$+.()|{}\[\]]/.test(ch)) {
      rx += "\\" + ch;
    } else {
      rx += ch;
    }
  }
  const head = anchored ? "^" : "(^|.*/)";
  const tail = dirOnly ? "(/.*)?$" : "(/.*)?$";
  return { rx: new RegExp(head + rx + tail), negate, dirOnly, source, raw };
}

async function readIgnoreFile(
  root: string,
  fileName: string,
  source: IgnoreSource,
): Promise<{ rules: IgnoreRule[]; patterns: string[] }> {
  const file = path.join(root, fileName);
  try {
    const txt = await fs.readFile(file, "utf8");
    const rules: IgnoreRule[] = [];
    const patterns: string[] = [];
    for (const line of txt.split(/\r?\n/)) {
      const r = compilePatternToRegex(line, source);
      if (r) {
        rules.push(r);
        patterns.push(r.raw);
      }
    }
    return { rules, patterns };
  } catch {
    return { rules: [], patterns: [] };
  }
}

export interface ExclusionSummary {
  // Per-source counts of files removed by ignore rules. Standard hardcoded
  // ignores (node_modules, .git, dist, …) are NOT counted here — they're
  // never user-controlled and would dwarf the .licenseleakignore count we
  // actually want reviewers to see.
  counts: Record<IgnoreSource, number>;
  // Verbatim active patterns from `.licenseleakignore`. We do NOT echo
  // `.gitignore` patterns; those live in the user's repo and a reviewer
  // can read them there. The trust concern the report addresses is
  // specifically "what did the user ADD on top of git's defaults".
  licenseleakignorePatterns: string[];
}

export interface WalkResult {
  entries: PackEntry[];
  totalBytes: number;
  exclusions: ExclusionSummary;
}

export interface WalkOptions {
  rootDir: string;
  maxUncompressedBytes?: number;
}

export async function walkForUpload(opts: WalkOptions): Promise<WalkResult> {
  const root = path.resolve(opts.rootDir);
  const gi = await readIgnoreFile(root, ".gitignore", "gitignore");
  const lli = await readIgnoreFile(root, ".licenseleakignore", "licenseleakignore");
  // Order matters: `.licenseleakignore` is additive ON TOP of `.gitignore`,
  // so its rules (including negations) are evaluated last and win on a tie.
  const rules: IgnoreRule[] = [...gi.rules, ...lli.rules];
  const entries: PackEntry[] = [];
  let totalBytes = 0;
  const max = opts.maxUncompressedBytes ?? 500 * 1024 * 1024;
  const counts: Record<IgnoreSource, number> = { gitignore: 0, licenseleakignore: 0 };

  // Returns { ignored, attributedTo } so the walker can attribute each
  // excluded file to the source that ultimately caused the exclusion. The
  // last matching non-negated rule wins (matches `git check-ignore` behavior),
  // and a `.licenseleakignore` negation re-including a file removes the
  // earlier `.gitignore` exclusion entirely.
  function ignored(
    rel: string,
    isDir: boolean,
  ): { ignored: boolean; attributedTo: IgnoreSource | null } {
    let result = false;
    let attributedTo: IgnoreSource | null = null;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.rx.test(rel)) {
        result = !r.negate;
        attributedTo = r.negate ? null : r.source;
      }
    }
    return { ignored: result, attributedTo };
  }

  async function walk(dir: string, relDir: string): Promise<void> {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (STANDARD_IGNORE_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // never follow / pack symlinks
      if (ent.isDirectory()) {
        const m = ignored(rel, true);
        if (m.ignored) {
          // Count every file under an ignored directory under the same
          // attribution so per-source totals reflect what was actually
          // removed from the upload (a single `node_modules/` rule shows
          // up as "thousands of files," not "one directory").
          if (m.attributedTo) {
            const n = await countFilesUnder(abs);
            counts[m.attributedTo] += n;
          }
          continue;
        }
        await walk(abs, rel);
      } else if (ent.isFile()) {
        const m = ignored(rel, false);
        if (m.ignored) {
          if (m.attributedTo) counts[m.attributedTo] += 1;
          continue;
        }
        let st: import("node:fs").Stats;
        try {
          st = await fs.stat(abs);
        } catch {
          continue;
        }
        if (st.size > 50 * 1024 * 1024) continue; // skip individual files > 50MB
        totalBytes += st.size;
        if (totalBytes > max) {
          throw new TarPackError(
            `Working directory exceeds the ${(max / (1024 * 1024)).toFixed(0)} MB uncompressed cap. Add patterns to .gitignore or scan a subdirectory.`,
            "upload_too_large",
          );
        }
        entries.push({ archivePath: rel, absPath: abs });
      }
    }
  }

  await walk(root, "");
  return {
    entries,
    totalBytes,
    exclusions: { counts, licenseleakignorePatterns: lli.patterns },
  };
}

// Recursively count regular files under `dir` (skips symlinks and the
// hardcoded standard ignore directories so the per-source attribution
// stays focused on user-controlled exclusions). Errors are absorbed —
// an unreadable subtree contributes 0 to the count.
async function countFilesUnder(dir: string): Promise<number> {
  let n = 0;
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of dirents) {
    if (STANDARD_IGNORE_DIRS.has(ent.name)) continue;
    if (ent.isSymbolicLink()) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      n += await countFilesUnder(abs);
    } else if (ent.isFile()) {
      n += 1;
    }
  }
  return n;
}
