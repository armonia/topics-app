#!/usr/bin/env node
/**
 * start-test-server.win.mjs - the Windows twin of `scripts/start-test-server.sh`.
 *
 * WHY A SECOND FILE AND NOT GIT-BASH. Running the `.sh` through
 * `C:\Program Files\Git\bin\bash.exe` looks cheaper and is not: the caller hands
 * DATA_DIR down as a Windows path (`C:\Users\...\Temp\topics-test-data-13334`),
 * and inside bash every backslash in it is an escape. `mkdir -p "$DATA_DIR"`
 * then creates a single file whose NAME is the whole path, the server writes its
 * database somewhere else entirely, and the bench spends the run comparing two
 * directories that were never the same one. The launcher is the one place where
 * the two operating systems genuinely disagree, so it is the one place that gets
 * two files.
 *
 * WHAT IT DOES NOT DO. It does not restate the environment: BUN_PORT, DATA_DIR,
 * TOPICS_HOME, OPENCLAW_DIR, the bridge endpoints, TOPICS_E2E and the rest come
 * from `testServerEnv()` in tests/e2e/helpers/test-server.ts, which stays the
 * single list for both platforms. This file only fills the gaps for someone who
 * runs it by hand, creates the directories, plants the `claude` stub and execs
 * the server. Every explanation of WHY a variable exists lives in the `.sh` and
 * in `testServerEnv()`; duplicating it here would guarantee the two copies
 * diverge.
 *
 * Run by hand:
 *   node scripts/start-test-server.win.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const port = process.env.BUN_PORT || "13334";
const defaultDataDir = join(
  tmpdir(),
  port === "13334" ? "topics-test-data" : `topics-test-data-${port}`,
);
const dataDir = process.env.DATA_DIR || defaultDataDir;
const home = join(dataDir, ".home");

const env = {
  ...process.env,
  BUN_PORT: port,
  DATA_DIR: dataDir,
  TOPICS_HOME: process.env.TOPICS_HOME || join(dataDir, ".topics-home"),
  OPENCLAW_DIR: process.env.OPENCLAW_DIR || join(dataDir, ".openclaw"),
  // Both names: `os.homedir()` reads USERPROFILE on Windows, while a good deal
  // of this codebase (and every dependency written for POSIX first) reads HOME.
  // Setting only one of them isolates half the reads, which is the worst of the
  // two outcomes because it looks isolated.
  HOME: home,
  USERPROFILE: home,
  TOPICS_PTY_SOCKET: process.env.TOPICS_PTY_SOCKET || `\\\\.\\pipe\\topics-pty-bridge-e2e-${port}`,
  TOPICS_AI_BRIDGE_SOCKET:
    process.env.TOPICS_AI_BRIDGE_SOCKET || `\\\\.\\pipe\\topics-ai-bridge-e2e-${port}`,
  TOPICS_E2E: process.env.TOPICS_E2E || "1",
  TOPICS_PUBLIC_DIR: process.env.TOPICS_PUBLIC_DIR || "",
  GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || "test-token",
};

for (const dir of [dataDir, env.TOPICS_HOME, env.OPENCLAW_DIR, home]) {
  mkdirSync(dir, { recursive: true });
}

/**
 * The `claude` stub, same contract as the one the `.sh` writes inline: answers
 * `--version`, ends the turn when the chat runtime passes `--print`, and stays
 * alive otherwise because a terminal session that exits within three seconds is
 * deleted by the server as a failed launch.
 *
 * Two files instead of one because a `.cmd` is what `resolveClaudeBin()` probes
 * for on Windows (server/lib/claude-bin.ts), while the behaviour is far easier
 * to get right in JavaScript than in batch.
 */
const binDir = join(home, ".local", "bin");
mkdirSync(binDir, { recursive: true });
const stubJs = join(binDir, "claude-stub.mjs");
if (!existsSync(stubJs)) {
  writeFileSync(
    stubJs,
    [
      "const args = process.argv.slice(2);",
      "if (args.some((a) => a === '--version' || a === '-v')) { process.stdout.write('claude 0.0.0-e2e-stub\\n'); process.exit(0); }",
      "if (!args.some((a) => a === '--print' || a === '-p')) { setInterval(() => {}, 3600_000); }",
      "else {",
      "  process.stdin.resume();",
      "  process.stdin.on('data', () => {});",
      "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\\n');",
      "  process.stdin.destroy();",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
  );
}
const stubCmd = join(binDir, "claude.cmd");
if (!existsSync(stubCmd)) {
  writeFileSync(stubCmd, `@echo off\r\nnode "%~dp0claude-stub.mjs" %*\r\n`);
}

const server = spawn("bun", ["run", "server.ts"], {
  cwd: REPO_ROOT,
  env,
  stdio: "inherit",
});
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
server.on("error", (err) => {
  console.error(`[start-test-server.win] cannot start bun: ${err.message}`);
  process.exit(1);
});
