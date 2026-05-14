// Top-level CLI entrypoint. Wires commander to the local/remote scanners,
// auth/config commands, and the shared output formatter.

import { Command } from "commander";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runLocalScan } from "./scan-local.js";
import { runRemoteScan } from "./scan-remote.js";
import { runRemoteUploadScan } from "./scan-remote-upload.js";
import { ApiClient, ApiError } from "./api-client.js";
import {
  loadConfig,
  saveConfig,
  resolveApiKey,
  resolveApiBase,
  configPath,
} from "./config.js";
import { renderTable, shouldFail, type Report } from "./format.js";
import { c } from "./colors.js";

const VERSION = "0.4.0";
const USER_AGENT = `licenseleak-cli/${VERSION} (+https://licenseleak.com)`;

function isRemoteUrl(target: string): boolean {
  // Match the spec: auto-remote only for https://github.com/... URLs. Other
  // URLs require an explicit --remote flag so a path like `./https-cache`
  // isn't accidentally interpreted as a network target.
  return /^https:\/\/github\.com\//i.test(target);
}

function exitWithReport(
  report: Report,
  format: "text" | "json",
  failOn: "critical" | "high" | "medium" | "low" | "none",
  opts: { showOfflineHint?: boolean } = {},
): never {
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(report) + "\n");
    if (opts.showOfflineHint) {
      // Single neutral line so security reviewers and local-only users both
      // see, plainly, that the default scan made zero outbound requests —
      // and that --remote exists for CI / shareable reports. Suppressed by
      // --no-hints, --format json, --remote, and on scan errors (the caller
      // gates this; we just render).
      process.stdout.write(
        "Scanned offline — no network requests made. Use --remote for hosted scanning (CI integration, shareable report URL).\n",
      );
    }
  }
  process.exit(shouldFail(report, failOn) ? 1 : 0);
}

async function promptHidden(question: string): Promise<string> {
  // Hide the typed key. readline doesn't have a built-in masked prompt, so we
  // monkey-patch the output stream while the prompt is open.
  const rl = readline.createInterface({ input, output });
  const ttyOut = output as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
  return new Promise((resolve) => {
    let muted = false;
    const originalWrite = ttyOut.write.bind(ttyOut);
    ttyOut.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (muted && typeof chunk === "string" && chunk !== "\n" && chunk !== "\r\n") {
        return originalWrite("");
      }
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof ttyOut.write;

    rl.question(question, (answer) => {
      ttyOut.write = originalWrite;
      output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

const program = new Command();

program
  .name("licenseleak")
  .description(
    "License compliance scanner — find AGPL/GPL/SSPL contamination before your acquirer does.\n" +
      "Docs: https://licenseleak.com",
  )
  .version(VERSION, "-v, --version", "Print the CLI version");

program
  .command("scan")
  .description(
    "Scan a local path (default) or a remote https://github.com/... URL.",
  )
  .argument("<target>", "Local directory path or remote repo URL")
  .option("--remote", "Force remote scan against the hosted API")
  .option("--branch <branch>", "Branch to scan (remote only)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option(
    "--fail-on <level>",
    "Exit 1 if any finding ≥ this severity is present (critical|high|medium|low|none)",
    "critical",
  )
  .option(
    "--no-hints",
    "Suppress informational hints printed after a successful local scan",
  )
  .action(async (target: string, opts) => {
    const format = (opts.format as string) === "json" ? "json" : "text";
    const failOn = String(opts.failOn) as
      | "critical"
      | "high"
      | "medium"
      | "low"
      | "none";
    if (!["critical", "high", "medium", "low", "none"].includes(failOn)) {
      console.error(`Invalid --fail-on value: ${failOn}`);
      process.exit(2);
    }

    const remote = Boolean(opts.remote) || isRemoteUrl(target);
    // When the user explicitly asks for a remote scan but points at a local
    // path, we package the working directory and upload it. Pure URL targets
    // continue to use the URL-based flow.
    const remoteUpload = remote && !isRemoteUrl(target);
    try {
      if (remote) {
        const cfg = await loadConfig();
        const apiKey = resolveApiKey(cfg);
        const base = resolveApiBase(cfg);
        if (!apiKey) {
          console.error(
            c.red("No API key found.") +
              " Set " +
              c.bold("LICENSELEAK_API_KEY") +
              " or run " +
              c.bold("licenseleak login") +
              ".",
          );
          process.exit(2);
        }
        const client = new ApiClient({ base, apiKey, userAgent: USER_AGENT });
        if (remoteUpload) {
          if (format === "text") {
            process.stderr.write(
              c.dim(`→ Packaging ${target} for upload to ${base}…\n`),
            );
          }
          const report = await runRemoteUploadScan({
            client,
            rootDir: target,
            branch: opts.branch,
            onPack: (info) => {
              if (format === "text") {
                process.stderr.write(
                  c.dim(
                    `  packed ${info.files.toLocaleString()} files (${formatBytes(info.bytes)} on disk)\n`,
                  ),
                );
                // Per-source exclusion summary lives on its own line so
                // CI logs make it obvious what scoping the user applied.
                // Suppressed entirely when no user-controlled exclusions
                // fired (the standard hardcoded ignores aren't shown).
                const gi = info.exclusions.counts.gitignore;
                const lli = info.exclusions.counts.licenseleakignore;
                if (gi > 0 || lli > 0) {
                  process.stderr.write(
                    c.dim(
                      `  excluded ${gi.toLocaleString()} file(s) by .gitignore, ` +
                        `${lli.toLocaleString()} by .licenseleakignore\n`,
                    ),
                  );
                }
              }
            },
            onUpload: (info) => {
              // The progress bar (onUploadProgress) already shows total size
              // in real time. Only emit a static line when stderr isn't a TTY
              // (CI, piped logs) — otherwise the bar will overwrite it anyway.
              if (
                format === "text" &&
                !(process.stderr as NodeJS.WriteStream).isTTY
              ) {
                process.stderr.write(
                  c.dim(`  uploading ${formatBytes(info.compressedBytes)}…\n`),
                );
              }
            },
            onUploadProgress: makeUploadProgressRenderer(format === "text"),
            onStatus: (s) => {
              if (format === "text") {
                process.stderr.write(
                  c.dim(`  status=${s.status} progress=${s.progress}%\n`),
                );
              }
            },
          });
          exitWithReport(report, format, failOn);
        }
        if (format === "text") {
          process.stderr.write(c.dim(`→ Submitting ${target} to ${base}…\n`));
        }
        const report = await runRemoteScan({
          client,
          repoUrl: target,
          branch: opts.branch,
          onStatus: (s) => {
            if (format === "text") {
              process.stderr.write(
                c.dim(`  status=${s.status} progress=${s.progress}%\n`),
              );
            }
          },
        });
        exitWithReport(report, format, failOn);
      } else {
        if (format === "text") {
          process.stderr.write(c.dim(`→ Scanning ${target}…\n`));
        }
        const report = await runLocalScan({ rootDir: target });
        // commander turns --no-hints into opts.hints === false (defaults true)
        const showOfflineHint = opts.hints !== false;
        exitWithReport(report, format, failOn, { showOfflineHint });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 401) {
        console.error(
          c.red("Authentication failed.") +
            " Re-run " +
            c.bold("licenseleak login") +
            " or check LICENSELEAK_API_KEY.",
        );
      } else {
        console.error(c.red("Error: ") + msg);
      }
      process.exit(2);
    }
  });

program
  .command("login")
  .description("Save an API key to ~/.licenseleak/config.json (mode 0600)")
  .option("--api-base <url>", "Override API base URL")
  .option(
    "--api-key <key>",
    "Set the API key non-interactively (avoid in shell history)",
  )
  .action(async (opts) => {
    const cfg = await loadConfig();
    const key = (opts.apiKey as string | undefined)?.trim() ||
      (await promptHidden("API key (ll_live_…): "));
    if (!key) {
      console.error(c.red("No API key provided."));
      process.exit(2);
    }
    if (!/^ll_(live|test)_/.test(key)) {
      console.error(
        c.yellow("Warning: ") +
          "API key does not start with `ll_live_` — it may not be valid.",
      );
    }
    const base = (opts.apiBase as string | undefined)?.trim() || cfg.apiBase;
    await saveConfig({ apiKey: key, apiBase: base });
    console.log(c.green("✓ ") + `Saved to ${configPath()} (mode 0600).`);
  });

program
  .command("logout")
  .description("Remove the saved API key")
  .action(async () => {
    const cfg = await loadConfig();
    if (!cfg.apiKey) {
      console.log("Nothing to remove.");
      return;
    }
    await saveConfig({ apiBase: cfg.apiBase });
    console.log(c.green("✓ ") + "API key removed.");
  });

program
  .command("whoami")
  .description("Print the account associated with the saved API key")
  .action(async () => {
    const cfg = await loadConfig();
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      console.error(
        "Not logged in. Run " + c.bold("licenseleak login") + ".",
      );
      process.exit(2);
    }
    const base = resolveApiBase(cfg);
    const client = new ApiClient({ base, apiKey, userAgent: USER_AGENT });
    try {
      const me = await client.me();
      console.log(c.bold("Account: ") + (me.email ?? me.userId));
      console.log(c.dim("Plan:    ") + me.plan);
      console.log(c.dim("Credits: ") + String(me.credits));
      console.log(c.dim("API:     ") + base);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c.red("whoami failed: ") + msg);
      process.exit(2);
    }
  });

program.addHelpText(
  "after",
  `
Examples:
  $ npx licenseleak scan .                       Scan the current directory
  $ npx licenseleak scan ./service               Scan a subdirectory
  $ npx licenseleak scan https://github.com/o/r  Submit a remote scan
  $ npx licenseleak scan . --remote              Upload local code to the hosted scanner
  $ npx licenseleak scan . --format json         Pipe a structured report
  $ npx licenseleak scan . --fail-on high        Fail CI on high+critical only
  $ npx licenseleak login                        Save your API key
  $ npx licenseleak whoami                       Show the active account

Environment:
  LICENSELEAK_API_KEY     Bearer token (overrides ~/.licenseleak/config.json)
  LICENSELEAK_API_BASE    Override the hosted API base URL
  NO_COLOR                Disable ANSI colors
`,
);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Returns an upload-progress callback that paints a single in-place line on
// stderr. When stderr isn't a TTY (CI logs, pipes), or when text rendering is
// disabled (e.g. --format json), this is a no-op so we don't pollute the
// output. Throttles redraws to ~10 FPS to keep terminal traffic sane.
function makeUploadProgressRenderer(
  enabled: boolean,
): ((sent: number, total: number) => void) | undefined {
  if (!enabled) return undefined;
  const isTty = Boolean((process.stderr as NodeJS.WriteStream).isTTY);
  if (!isTty) return undefined;
  const startedAt = Date.now();
  let lastDraw = 0;
  let lastLine = "";
  const draw = (sent: number, total: number, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastDraw < 100) return;
    lastDraw = now;
    const pct = total > 0 ? Math.min(1, sent / total) : 0;
    const width = 24;
    const filled = Math.round(pct * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
    const rate = sent / elapsedSec; // bytes/sec
    const remain = total - sent;
    const etaSec = rate > 0 && remain > 0 ? Math.ceil(remain / rate) : 0;
    const etaStr = etaSec > 0 ? ` · ETA ${formatDuration(etaSec)}` : "";
    const line =
      `  uploading [${bar}] ${(pct * 100).toFixed(0).padStart(3)}%  ` +
      `${formatBytes(sent)} / ${formatBytes(total)} · ${formatBytes(Math.round(rate))}/s${etaStr}`;
    // \r returns to col 0; pad with spaces to overwrite any leftover from a
    // previously-longer line, then \r again so the cursor sits at col 0.
    const pad = Math.max(0, lastLine.length - line.length);
    process.stderr.write("\r" + line + " ".repeat(pad));
    lastLine = line;
  };
  return (sent: number, total: number) => {
    const done = sent >= total;
    draw(sent, total, done);
    if (done) {
      process.stderr.write("\n");
    }
  };
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
