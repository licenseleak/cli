#!/usr/bin/env node
// Entry shim. Loads the compiled ESM CLI; falls back to tsx for source dev.
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, "..", "dist", "index.js");
const src = path.join(here, "..", "src", "index.ts");

async function run() {
  if (existsSync(built)) {
    await import(pathToFileURL(built).href);
    return;
  }
  if (existsSync(src)) {
    // Dev mode: run TypeScript source via tsx if available.
    try {
      const { register } = await import("tsx/esm/api");
      register();
      await import(pathToFileURL(src).href);
      return;
    } catch {
      console.error(
        "licenseleak: not built. Run `pnpm --filter licenseleak build` (or install with tsx).",
      );
      process.exit(1);
    }
  }
  console.error("licenseleak: build artifact not found at " + built);
  process.exit(1);
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
