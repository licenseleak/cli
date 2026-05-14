// Vendored, lookup-free dependency parsers. Reads manifests + lockfiles for
// npm/pip/go/cargo/ruby/php and returns normalized {ecosystem, pkg, version,
// licenseSpdx?, manifest}. License is filled when the lockfile carries it
// inline (composer.lock, package-lock.json); otherwise null and resolved by
// caller (or left unknown for fully-offline scans).

import fs from "node:fs/promises";
import path from "node:path";

export type Ecosystem = "npm" | "pip" | "go" | "cargo" | "ruby" | "php";

export interface ParsedDep {
  ecosystem: Ecosystem;
  pkg: string;
  version: string | null;
  source: "direct" | "transitive";
  licenseSpdx: string | null;
  manifest: string;
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function parseNpm(rootDir: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  const pkgRaw = await readMaybe(path.join(rootDir, "package.json"));
  if (pkgRaw) {
    try {
      const pj = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const [name, version] of Object.entries(pj.dependencies ?? {})) {
        out.push({
          ecosystem: "npm",
          pkg: name,
          version: String(version),
          source: "direct",
          licenseSpdx: null,
          manifest: "package.json",
        });
      }
      for (const [name, version] of Object.entries(pj.devDependencies ?? {})) {
        out.push({
          ecosystem: "npm",
          pkg: name,
          version: String(version),
          source: "direct",
          licenseSpdx: null,
          manifest: "package.json",
        });
      }
    } catch {
      /* malformed package.json */
    }
  }

  const npmLockRaw = await readMaybe(path.join(rootDir, "package-lock.json"));
  if (npmLockRaw) {
    try {
      const lock = JSON.parse(npmLockRaw) as {
        packages?: Record<string, { version?: string; license?: string }>;
      };
      const seen = new Set(out.map((d) => d.pkg));
      for (const [key, meta] of Object.entries(lock.packages ?? {})) {
        if (!key) continue;
        const name = key.replace(/^node_modules\//, "").split("/node_modules/").pop();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({
          ecosystem: "npm",
          pkg: name,
          version: meta.version ?? null,
          source: "transitive",
          licenseSpdx: meta.license ?? null,
          manifest: "package-lock.json",
        });
      }
    } catch {
      /* malformed lock */
    }
  }

  const pnpmLock = await readMaybe(path.join(rootDir, "pnpm-lock.yaml"));
  if (pnpmLock) {
    const seen = new Set(out.map((d) => d.pkg));
    for (const m of pnpmLock.matchAll(/^\s*\/([@\w./-]+)@/gm)) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({
          ecosystem: "npm",
          pkg: name,
          version: null,
          source: "transitive",
          licenseSpdx: null,
          manifest: "pnpm-lock.yaml",
        });
      }
    }
  }

  const yarnLock = await readMaybe(path.join(rootDir, "yarn.lock"));
  if (yarnLock) {
    const seen = new Set(out.map((d) => d.pkg));
    for (const m of yarnLock.matchAll(/^"?(@?[\w./-]+)@[^:"\s]+/gm)) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({
          ecosystem: "npm",
          pkg: name,
          version: null,
          source: "transitive",
          licenseSpdx: null,
          manifest: "yarn.lock",
        });
      }
    }
  }
  return out;
}

async function parsePip(rootDir: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  const req = await readMaybe(path.join(rootDir, "requirements.txt"));
  if (req) {
    for (const line of req.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*([<>=!~]=?\s*[^;\s]+)?/);
      if (!m || !m[1]) continue;
      out.push({
        ecosystem: "pip",
        pkg: m[1].toLowerCase(),
        version: m[2]?.replace(/[\s<>=!~]/g, "") ?? null,
        source: "direct",
        licenseSpdx: null,
        manifest: "requirements.txt",
      });
    }
  }
  const py = await readMaybe(path.join(rootDir, "pyproject.toml"));
  if (py) {
    for (const m of py.matchAll(/"([A-Za-z0-9_.\-]+)\s*[<>=!~]=?[^"]*"/g)) {
      const name = m[1]!.toLowerCase();
      if (out.some((d) => d.pkg === name)) continue;
      out.push({
        ecosystem: "pip",
        pkg: name,
        version: null,
        source: "direct",
        licenseSpdx: null,
        manifest: "pyproject.toml",
      });
    }
  }
  return out;
}

async function parseGo(rootDir: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  const mod = await readMaybe(path.join(rootDir, "go.mod"));
  if (mod) {
    const requireBlocks = mod.match(/require\s*\(([\s\S]*?)\)/g) ?? [];
    const lines: string[] = [];
    for (const block of requireBlocks) lines.push(...block.split(/\r?\n/));
    for (const m of mod.matchAll(/^require\s+(\S+)\s+(\S+)/gm)) lines.push(`${m[1]} ${m[2]}`);
    for (const raw of lines) {
      const m = raw.trim().match(/^([\w./-]+)\s+(\S+)/);
      if (!m || !m[1]) continue;
      out.push({
        ecosystem: "go",
        pkg: m[1],
        version: m[2] ?? null,
        source: "direct",
        licenseSpdx: null,
        manifest: "go.mod",
      });
    }
  }
  const sum = await readMaybe(path.join(rootDir, "go.sum"));
  if (sum) {
    const seen = new Set(out.map((d) => d.pkg));
    for (const line of sum.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(\S+?)(?:\/go\.mod)?\s+h1:/);
      if (!m || !m[1]) continue;
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        ecosystem: "go",
        pkg: name,
        version: m[2] ?? null,
        source: "transitive",
        licenseSpdx: null,
        manifest: "go.sum",
      });
    }
  }
  return out;
}

async function parseCargo(rootDir: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  const toml = await readMaybe(path.join(rootDir, "Cargo.toml"));
  if (toml) {
    const depsBlock = toml.match(/\[dependencies\]([\s\S]*?)(?:\n\[|\n*$)/);
    if (depsBlock?.[1]) {
      for (const line of depsBlock[1].split(/\r?\n/)) {
        const m = line.trim().match(/^([A-Za-z0-9_.\-]+)\s*=/);
        if (!m || !m[1]) continue;
        out.push({
          ecosystem: "cargo",
          pkg: m[1],
          version: null,
          source: "direct",
          licenseSpdx: null,
          manifest: "Cargo.toml",
        });
      }
    }
  }
  const lock = await readMaybe(path.join(rootDir, "Cargo.lock"));
  if (lock) {
    const seen = new Set(out.map((d) => d.pkg));
    for (const m of lock.matchAll(
      /\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g,
    )) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        ecosystem: "cargo",
        pkg: name,
        version: m[2] ?? null,
        source: "transitive",
        licenseSpdx: null,
        manifest: "Cargo.lock",
      });
    }
  }
  return out;
}

async function parseRuby(rootDir: string): Promise<ParsedDep[]> {
  const lock = await readMaybe(path.join(rootDir, "Gemfile.lock"));
  if (!lock) return [];
  const out: ParsedDep[] = [];
  for (const m of lock.matchAll(/^\s{4}([A-Za-z0-9_.\-]+)\s*\(([^)]+)\)/gm)) {
    out.push({
      ecosystem: "ruby",
      pkg: m[1]!,
      version: m[2] ?? null,
      source: "direct",
      licenseSpdx: null,
      manifest: "Gemfile.lock",
    });
  }
  return out;
}

async function parsePhp(rootDir: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  const raw = await readMaybe(path.join(rootDir, "composer.json"));
  if (raw) {
    try {
      const j = JSON.parse(raw) as {
        require?: Record<string, string>;
        "require-dev"?: Record<string, string>;
      };
      for (const block of [j.require, j["require-dev"]]) {
        for (const [name, version] of Object.entries(block ?? {})) {
          if (name.startsWith("php") || name.startsWith("ext-")) continue;
          out.push({
            ecosystem: "php",
            pkg: name,
            version: String(version),
            source: "direct",
            licenseSpdx: null,
            manifest: "composer.json",
          });
        }
      }
    } catch {
      /* malformed */
    }
  }
  const composerLock = await readMaybe(path.join(rootDir, "composer.lock"));
  if (composerLock) {
    try {
      const j = JSON.parse(composerLock) as {
        packages?: Array<{ name: string; version?: string; license?: string[] }>;
        "packages-dev"?: Array<{ name: string; version?: string; license?: string[] }>;
      };
      const seen = new Set(out.map((d) => d.pkg));
      for (const block of [j.packages, j["packages-dev"]]) {
        for (const p of block ?? []) {
          if (!p.name || seen.has(p.name)) continue;
          seen.add(p.name);
          out.push({
            ecosystem: "php",
            pkg: p.name,
            version: p.version ?? null,
            source: "transitive",
            licenseSpdx: (p.license && p.license[0]) ?? null,
            manifest: "composer.lock",
          });
        }
      }
    } catch {
      /* malformed */
    }
  }
  return out;
}

async function parseOneDir(rootDir: string): Promise<ParsedDep[]> {
  const [npm, pip, go, cargo, ruby, php] = await Promise.all([
    parseNpm(rootDir),
    parsePip(rootDir),
    parseGo(rootDir),
    parseCargo(rootDir),
    parseRuby(rootDir),
    parsePhp(rootDir),
  ]);
  return [...npm, ...pip, ...go, ...cargo, ...ruby, ...php];
}

// Bounded recursive walk: looks for manifests/lockfiles in subdirectories
// (e.g. monorepo workspaces) but skips vendor dirs and hidden dirs to keep
// runtime under the 30-second sniff-test budget.
const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  ".git",
  ".pnpm",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);

export const MAX_DIRS = 500;
export const MAX_DEPTH = 6;

export interface WalkInfo {
  dirsVisited: number;
  truncated: boolean;
  reason: "dir_count" | "max_depth" | null;
  // Whether the dir-count cap was hit AND we observed at least one directory
  // beyond the cap (so the user knows real content was skipped, not just
  // that we stopped one short).
  hitDepthAt: string | null;
}

async function discoverManifestDirs(
  rootDir: string,
): Promise<{ dirs: string[]; walk: WalkInfo }> {
  const found: string[] = [rootDir];
  let visited = 1;
  let truncated = false;
  let reason: WalkInfo["reason"] = null;
  let hitDepthAt: string | null = null;
  async function walk(dir: string, depth: number): Promise<void> {
    if (visited >= MAX_DIRS) {
      truncated = true;
      if (reason === null) reason = "dir_count";
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") && e.name !== ".") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const child = path.join(dir, e.name);
      const childDepth = depth + 1;
      // Depth check fires BEFORE we push/parse the child, so MAX_DEPTH means
      // "do not parse below this depth" rather than "stopped descending after
      // already parsing one level past this".
      if (childDepth > MAX_DEPTH) {
        truncated = true;
        if (reason === null) reason = "max_depth";
        if (hitDepthAt === null) hitDepthAt = child;
        continue;
      }
      visited++;
      if (visited > MAX_DIRS) {
        truncated = true;
        if (reason === null) reason = "dir_count";
        return;
      }
      found.push(child);
      await walk(child, childDepth);
    }
  }
  await walk(rootDir, 0);
  return {
    dirs: found,
    walk: { dirsVisited: visited, truncated, reason, hitDepthAt },
  };
}

export interface ParseAllResult {
  deps: ParsedDep[];
  walk: WalkInfo;
}

export async function parseAll(rootDir: string): Promise<ParseAllResult> {
  const { dirs, walk } = await discoverManifestDirs(rootDir);
  const all = await Promise.all(dirs.map(parseOneDir));
  // De-dupe across subdirs by ecosystem+pkg+manifest path. Without this a
  // monorepo with the same dep in many packages would emit one finding per
  // package, which is noisy for a sniff test.
  const seen = new Set<string>();
  const out: ParsedDep[] = [];
  for (const list of all) {
    for (const d of list) {
      const key = `${d.ecosystem}\u0000${d.pkg}\u0000${d.licenseSpdx ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return { deps: out, walk };
}
