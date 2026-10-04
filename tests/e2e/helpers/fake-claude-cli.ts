/**
 * Puts `fake-claude-slow-turn.ts` in front of the test server's CLI, for one
 * spec.
 *
 * The server resolves the CLI at EVERY spawn (`resolveCliPath` in
 * server/providers/claude-code.ts), and it looks under the versions folder of
 * its HOME before the launcher stub that `scripts/start-test-server.sh`
 * writes. So an entry there wins from the next spawn on, with no restart, and
 * removing it gives the stub back. The suite runs one worker per server, so no
 * other spec spawns a CLI while it is installed; sessions spawned before it
 * keep the child they have.
 *
 * ON WINDOWS TOO. The entry used to be a bash script found with `command -v
 * bun`: `execSync` runs cmd.exe there, which has no `command`, so every spec
 * using it died in `beforeAll` on the Windows bench. The entry is now a `.cmd`
 * on Windows (Bun's spawn runs one, measured on the PC: arguments and the
 * variable set inside it arrive) and a bash script elsewhere, and bun is found
 * without a shell (`bunPath`).
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { request as playwrightRequest } from "@playwright/test";
import { E2E_BASE, E2E_HOME } from "./test-server";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
const IS_WINDOWS = process.platform === "win32";
/** Sorted above any real version: the resolver takes the highest. */
const ENTRY = join(VERSIONS_DIR, IS_WINDOWS ? "999.0.0-e2e.cmd" : "999.0.0-e2e");
const SCRIPT = resolve(__dirname, "fake-claude-slow-turn.ts");

/**
 * The absolute path of bun. The server spawns the CLI with a trimmed
 * environment, so the wrapper names bun by its path instead of trusting that
 * PATH has it there. This process may be bun itself, or node running the
 * Playwright CLI: then PATH is walked by hand, and the installer's own folder
 * is the last guess (the PC's PATH carries an unpaired quote that breaks
 * cmd's lookup, not this one).
 */
export function bunPath(): string {
  if (process.versions.bun) return process.execPath;
  const names = IS_WINDOWS ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".bun", "bin")];
  for (const dir of dirs) {
    const clean = dir.replace(/^"|"$/g, "");
    if (!clean) continue;
    for (const name of names) {
      const candidate = join(clean, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("bun not found on PATH nor in ~/.bun/bin: the fake CLI cannot be installed");
}

/** The text of the entry that runs `script` under bun with `env` set, on `platform`. */
function fakeCliEntry(platform: NodeJS.Platform, bun: string, script: string, env: Record<string, string> = {}): string {
  if (platform === "win32") {
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"\r\n`).join("");
    return `@echo off\r\n${sets}"${bun}" "${script}" %*\r\n`;
  }
  const exports = Object.entries(env).map(([k, v]) => `export ${k}="${v}"\n`).join("");
  return `#!/usr/bin/env bash\n${exports}exec "${bun}" "${script}" "$@"\n`;
}

/**
 * Installs `script` (a bun script) as the CLI, with `env` set for it, on any
 * platform; returns its removal. Every spec that needs its own fake CLI goes
 * through here: a hand-written bash entry found with `command -v bun` dies in
 * `beforeAll` on the Windows bench.
 */
export function installFakeCli(script: string, env: Record<string, string> = {}): () => void {
  return install(script, env);
}

function install(script: string, env: Record<string, string> = {}): () => void {
  mkdirSync(VERSIONS_DIR, { recursive: true });
  writeFileSync(ENTRY, fakeCliEntry(process.platform, bunPath(), script, env));
  if (!IS_WINDOWS) chmodSync(ENTRY, 0o755);
  return () => rmSync(ENTRY, { force: true });
}

/** Installs the slow-turn CLI; returns its removal. */
export function installSlowTurnCli(): () => void {
  return install(SCRIPT);
}

const QUEUE_TURNS_SCRIPT = resolve(__dirname, "fake-claude-queue-turns.ts");

/**
 * Installs `fake-claude-queue-turns.ts`, which writes down every message it is
 * handed and whether a turn was running at that moment, to `logPath`.
 * Returns its removal.
 */
export function installQueueTurnsCli(logPath: string): () => void {
  return install(QUEUE_TURNS_SCRIPT, { FAKE_CLI_LOG: logPath });
}

const COMPACT_SCRIPT = resolve(__dirname, "fake-claude-compact.ts");

/**
 * Installs `fake-claude-compact.ts`: `/compact` fails on an empty session with
 * the CLI's recorded failure, and compacts once a turn has run. Returns its
 * removal.
 */
export function installCompactCli(): () => void {
  return install(COMPACT_SCRIPT);
}

const REPLAY_SCRIPT = resolve(__dirname, "fake-claude-replay.ts");

/**
 * Installs `fake-claude-replay.ts`: lines recorded from Claude Code 2.1.288
 * (the init's `slash_commands`, `commands_changed`, the `<synthetic>` answer
 * of a local command, `/compact`'s outcome), with its start arguments and
 * every message written to `logPath`. Returns its removal.
 */
export function installReplayCli(logPath: string): () => void {
  return install(REPLAY_SCRIPT, { FAKE_CLI_LOG: logPath });
}

/**
 * Installs `script` (a bun script) as the test server's CODEX CLI; returns its
 * removal.
 *
 * Not through a folder the probe walks: the codex resolver memoizes the first
 * binary it finds, and a real `codex` on PATH would win. The path goes through
 * the route Settings uses to point at a CLI by hand
 * (`POST /api/providers/cli/configure`), which stores it, forgets the memoized
 * answers and registers the provider in one call. The removal clears it the
 * same way, so the probe answers again for the specs after. Its own request
 * context: a `request` fixture from `beforeAll` cannot be used in `afterAll`.
 */
export async function installFakeCodex(script: string, env: Record<string, string> = {}): Promise<() => Promise<void>> {
  const dir = join(E2E_HOME, "fake-codex");
  const entry = join(dir, IS_WINDOWS ? "codex.cmd" : "codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(entry, fakeCliEntry(process.platform, bunPath(), script, env));
  if (!IS_WINDOWS) chmodSync(entry, 0o755);
  const configure = async (path: string | null) => {
    const request = await playwrightRequest.newContext();
    try {
      const res = await request.post(`${E2E_BASE}/api/providers/cli/configure`, { data: { agent: "codex", path } });
      if (!res.ok()) throw new Error(`codex configure ${path ?? "(clear)"}: HTTP ${res.status()} ${await res.text()}`);
    } finally {
      await request.dispose();
    }
  };
  await configure(entry);
  return async () => {
    await configure(null);
    rmSync(dir, { recursive: true, force: true });
  };
}
