// Walker coverage for `.licenseleakignore` (Task #360):
//   - .gitignore patterns still apply on their own.
//   - .licenseleakignore is additive: a path matched by either file is excluded.
//   - .licenseleakignore can negate a .gitignore exclusion (re-include).
//   - Per-source counts attribute each removed file to the file that
//     ultimately caused the exclusion (last matching non-negated rule wins).
// We exercise walkForUpload directly with an on-disk temp dir rather than
// shelling the CLI binary so the assertions can inspect the structured
// ExclusionSummary the upload path forwards to the server.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { walkForUpload } from "../tar-pack.js";

async function mkTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ll-walker-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return root;
}

// Note: directory names like `build`, `vendor`, `node_modules`, `dist`,
// `target` are short-circuited by the CLI's hardcoded
// STANDARD_IGNORE_DIRS list before any ignore rule runs, so the
// per-source counts deliberately do NOT include them. We use neutral
// directory names (`generated/`, `fixtures/`) here to prove the
// `.gitignore` / `.licenseleakignore` attribution works on its own.

test(".gitignore alone excludes matching files and counts them", async () => {
  const root = await mkTree({
    ".gitignore": "secrets.txt\ngenerated/\n",
    "src/index.ts": "ok",
    "secrets.txt": "shh",
    "generated/out.js": "compiled",
    "generated/nested/x.js": "compiled",
  });
  const r = await walkForUpload({ rootDir: root });
  const archived = r.entries.map((e) => e.archivePath).sort();
  assert.deepEqual(archived, [".gitignore", "src/index.ts"]);
  assert.equal(r.exclusions.counts.gitignore, 3); // secrets.txt + 2 under generated/
  assert.equal(r.exclusions.counts.licenseleakignore, 0);
  assert.deepEqual(r.exclusions.licenseleakignorePatterns, []);
});

test(".licenseleakignore is additive on top of .gitignore", async () => {
  const root = await mkTree({
    ".gitignore": "generated/\n",
    ".licenseleakignore": "fixtures/\n*.snap\n",
    "src/a.ts": "ok",
    "generated/x.js": "g1",
    "fixtures/lib.js": "v1",
    "fixtures/sub/lib.js": "v2",
    "src/comp.snap": "snap",
  });
  const r = await walkForUpload({ rootDir: root });
  const archived = r.entries.map((e) => e.archivePath).sort();
  assert.deepEqual(archived, [".gitignore", ".licenseleakignore", "src/a.ts"]);
  assert.equal(r.exclusions.counts.gitignore, 1);
  assert.equal(r.exclusions.counts.licenseleakignore, 3); // fixtures/lib.js, fixtures/sub/lib.js, src/comp.snap
  assert.deepEqual(r.exclusions.licenseleakignorePatterns, ["fixtures/", "*.snap"]);
});

test(".licenseleakignore negation re-includes a .gitignore-excluded file", async () => {
  const root = await mkTree({
    ".gitignore": "*.log\n",
    ".licenseleakignore": "!keep.log\n",
    "drop.log": "noisy",
    "keep.log": "important",
    "src/a.ts": "ok",
  });
  const r = await walkForUpload({ rootDir: root });
  const archived = r.entries.map((e) => e.archivePath).sort();
  // keep.log is re-included by the negation; drop.log stays excluded.
  assert.deepEqual(archived, [".gitignore", ".licenseleakignore", "keep.log", "src/a.ts"]);
  assert.equal(r.exclusions.counts.gitignore, 1);
  assert.equal(r.exclusions.counts.licenseleakignore, 0);
});
