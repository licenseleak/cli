import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "..", "..", "bin", "licenseleak.mjs");

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

test("--version prints the CLI version", () => {
  const r = runCli(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("scan exits 1 by default when a critical AGPL dep is found", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-cli-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/agpl", version: "1.0.0", license: ["AGPL-3.0"] }],
    }),
  );
  const r = runCli(["scan", dir]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /CRITICAL/);
});

test("scan --fail-on none always exits 0 even with criticals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-cli-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/agpl", version: "1.0.0", license: ["AGPL-3.0"] }],
    }),
  );
  const r = runCli(["scan", dir, "--fail-on", "none"]);
  assert.equal(r.code, 0);
});

test("scan --format json emits a parseable structured report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-cli-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/gpl", version: "1.0.0", license: ["GPL-3.0"] }],
    }),
  );
  const r = runCli(["scan", dir, "--format", "json", "--fail-on", "none"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout) as {
    mode: string;
    findings: Array<{ severity: string; licenseFamily: string }>;
  };
  assert.equal(parsed.mode, "local");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.licenseFamily, "gpl");
});

test("scan walks subdirectories for nested manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-mono-"));
  await fs.mkdir(path.join(root, "packages", "svc"), { recursive: true });
  await fs.writeFile(
    path.join(root, "packages", "svc", "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/sspl", version: "1", license: ["SSPL-1.0"] }],
    }),
  );
  const r = runCli(["scan", root, "--format", "json", "--fail-on", "none"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout) as {
    findings: Array<{ licenseFamily: string }>;
  };
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.licenseFamily, "sspl");
});

test("scan prints the offline hint after a successful local text scan", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-hint-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/mit", version: "1.0.0", license: ["MIT"] }],
    }),
  );
  const r = runCli(["scan", dir]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(
    r.stdout,
    /Scanned offline — no network requests made\. Use --remote/,
  );
});

test("scan --no-hints suppresses the offline hint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-nohint-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/mit", version: "1.0.0", license: ["MIT"] }],
    }),
  );
  const r = runCli(["scan", dir, "--no-hints"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /Scanned offline/);
});

test("scan --format json never prints the offline hint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-jsonhint-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/mit", version: "1.0.0", license: ["MIT"] }],
    }),
  );
  const r = runCli(["scan", dir, "--format", "json"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /Scanned offline/);
  // Must remain valid JSON (no trailing prose).
  JSON.parse(r.stdout);
});

test("scan still prints the offline hint when findings cause a non-zero exit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ll-cli-hintfail-"));
  await fs.writeFile(
    path.join(dir, "composer.lock"),
    JSON.stringify({
      packages: [{ name: "acme/agpl", version: "1.0.0", license: ["AGPL-3.0"] }],
    }),
  );
  const r = runCli(["scan", dir]);
  assert.equal(r.code, 1);
  // The scan itself completed successfully — the non-zero exit is the
  // --fail-on threshold, not an error. The hint should still appear.
  assert.match(r.stdout, /Scanned offline/);
});

test("scan --help advertises the --no-hints flag", () => {
  const r = runCli(["scan", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--no-hints/);
});

test("remote scan without an API key fails fast with exit 2", () => {
  const clean = spawnSync(process.execPath, [bin, "scan", "https://github.com/acme/repo"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", LICENSELEAK_API_KEY: "", HOME: "/nonexistent-ll-home" },
  });
  // Auto-remote must have triggered: we should NOT see the local-scan error,
  // and we SHOULD see a missing-API-key complaint with exit 2.
  assert.equal(clean.status, 2);
  assert.ok(!/Cannot scan path/.test(clean.stderr || ""));
  assert.match(clean.stderr || "", /API key/i);
});
