import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  __addSnapshotEntryForTest,
  classifyLicense,
  scoreFamily,
} from "../classify.js";
import { shouldFail, type Report } from "../format.js";

test("classifies AGPL family as critical", () => {
  assert.equal(classifyLicense("AGPL-3.0-only"), "agpl");
  assert.equal(scoreFamily("agpl").severity, "critical");
});

test("classifies MIT as permissive", () => {
  assert.equal(classifyLicense("MIT"), "permissive");
});

test("classifies SSPL as critical", () => {
  assert.equal(classifyLicense("SSPL-1.0"), "sspl");
  assert.equal(scoreFamily("sspl").severity, "critical");
});

test("compound expression takes the strongest family", () => {
  assert.equal(classifyLicense("MIT OR GPL-3.0"), "gpl");
  assert.equal(classifyLicense("Apache-2.0 AND AGPL-3.0"), "agpl");
});

test("unknown identifier stays unknown", () => {
  assert.equal(classifyLicense("WeirdProprietary-1.0"), "unknown");
  assert.equal(classifyLicense(null), "unknown");
});

test("bundled SPDX snapshot covers core copyleft identifiers", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const snapshotPath = resolve(here, "..", "..", "spdx-snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    licenses: Record<string, string>;
    count?: number;
  };
  assert.ok(snapshot.licenses["AGPL-3.0-only"], "AGPL-3.0-only present in snapshot");
  assert.equal(snapshot.licenses["AGPL-3.0-only"], "agpl");
  assert.equal(snapshot.licenses["SSPL-1.0"], "sspl");
  assert.equal(snapshot.licenses["MIT"], "permissive");
  assert.ok((snapshot.count ?? Object.keys(snapshot.licenses).length) > 100);
});

test("classifyLicense reflects entries added to the snapshot", () => {
  // The regex rules already catch AGPL-* via prefix; pick an id that does NOT
  // match any FAMILY_RULES regex so we can prove the snapshot is consulted.
  assert.equal(classifyLicense("FutureCopyleft-9.9"), "unknown");
  __addSnapshotEntryForTest("FutureCopyleft-9.9", "agpl");
  assert.equal(classifyLicense("FutureCopyleft-9.9"), "agpl");
  assert.equal(scoreFamily(classifyLicense("FutureCopyleft-9.9")).severity, "critical");
});

test("shouldFail respects threshold", () => {
  const report: Report = {
    source: ".",
    mode: "local",
    counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
    findings: [
      {
        severity: "critical",
        licenseFamily: "agpl",
        licenseSpdx: "AGPL-3.0",
        filePath: "package.json → foo",
        rationale: "x",
      },
    ],
  };
  assert.equal(shouldFail(report, "critical"), true);
  assert.equal(shouldFail(report, "none"), false);
});
