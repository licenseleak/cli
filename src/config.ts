// Persistent config at ~/.licenseleak/config.json. File mode 0600. The API
// key is also overridable via LICENSELEAK_API_KEY for CI; the env var wins.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Config {
  apiKey?: string;
  apiBase?: string;
}

const DEFAULT_BASE = "https://licenseleak.com";

export function configDir(): string {
  return path.join(os.homedir(), ".licenseleak");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Config;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      apiBase: typeof parsed.apiBase === "string" ? parsed.apiBase : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Write atomically with mode 0600 so the API key is never world-readable.
  const tmp = configPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.rename(tmp, configPath());
  try {
    await fs.chmod(configPath(), 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

export function resolveApiKey(cfg: Config): string | undefined {
  return process.env.LICENSELEAK_API_KEY?.trim() || cfg.apiKey;
}

export function resolveApiBase(cfg: Config): string {
  return (
    process.env.LICENSELEAK_API_BASE?.trim() ||
    cfg.apiBase ||
    DEFAULT_BASE
  );
}
