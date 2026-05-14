import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLocalScan } from "../scan-local.js";

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-"));
}

test("local scan flags a GPL composer.lock dep", async () => {
  const dir = await makeTmp();
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/gpl-thing", version: "1.0.0", license: ["GPL-3.0-or-later"] }],
    }),
  );
  const r = await runLocalScan({ rootDir: dir });
  assert.equal(r.mode, "local");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]?.severity, "high");
  assert.equal(r.findings[0]?.licenseFamily, "gpl");
});

test("local scan returns empty findings on a clean MIT package.json", async () => {
  const dir = await makeTmp();
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
  );
  // No lockfile-derived license: lodash dep emits no finding because we
  // don't fail on null-license deps in offline mode.
  const r = await runLocalScan({ rootDir: dir });
  assert.equal(r.findings.length, 0);
});

test("local scan throws on missing path", async () => {
  await assert.rejects(() => runLocalScan({ rootDir: "/no/such/dir/exists/xyzzy" }));
});

test("local scan emits a truncation warning when the dir-count cap is hit", async () => {
  // Realistic monorepo shape: a packages/ directory with 600 sibling package
  // dirs, each with its own package.json. The CLI walker caps at 500 dirs;
  // without the warning the user would see "0 findings" and never know that
  // 100+ packages were silently skipped.
  const root = await makeTmp();
  const pkgs = path.join(root, "packages");
  await fs.mkdir(pkgs);
  for (let i = 0; i < 600; i++) {
    const d = path.join(pkgs, `pkg-${i}`);
    await fs.mkdir(d);
    await fs.writeFile(
      path.join(d, "package.json"),
      JSON.stringify({ name: `pkg-${i}` }),
    );
  }
  const r = await runLocalScan({ rootDir: root });
  assert.ok(r.warnings && r.warnings.length > 0, "expected truncation warning");
  assert.match(r.warnings![0]!, /500-directory cap/);
  assert.match(r.warnings![0]!, /Re-run/);
});

test("local scan emits a depth warning when the depth cap is hit", async () => {
  // 8 levels deep > MAX_DEPTH (6). Confirms the depth advisory fires
  // separately from the dir-count one and identifies the first cut-off.
  // The cap means "do not parse below this depth": with MAX_DEPTH=6 the
  // root counts as depth 0, lvl0..lvl5 are at depths 1..6 and ARE parsed,
  // and lvl6 at depth 7 is the first dir to be skipped.
  const root = await makeTmp();
  let cur = root;
  for (let i = 0; i < 8; i++) {
    cur = path.join(cur, `lvl${i}`);
    await fs.mkdir(cur);
    await fs.writeFile(path.join(cur, "package.json"), JSON.stringify({ name: `lvl${i}` }));
  }
  const r = await runLocalScan({ rootDir: root });
  assert.ok(r.warnings && r.warnings.length > 0, "expected depth warning");
  assert.match(r.warnings![0]!, /depth 6/);
  // First-cut-off path should point at lvl6 (the first dir past the cap),
  // not at lvl7 — the old off-by-one would have skipped lvl7 first while
  // still parsing lvl6.
  assert.match(r.warnings![0]!, /first hit:.*lvl6/);
  assert.doesNotMatch(r.warnings![0]!, /first hit:.*lvl7/);
});

test("local scan does NOT emit a warning on a small clean tree", async () => {
  const dir = await makeTmp();
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
  );
  const r = await runLocalScan({ rootDir: dir });
  assert.equal(r.warnings, undefined);
});
