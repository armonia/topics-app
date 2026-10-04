/**
 * THE CHAT AND BOARD ENGINE SPAWN CARRIES TOPICS' HOOKS.
 *
 * Once the entries leave the user's global `~/.claude/settings.json`, the one
 * `--settings` of the spawn is the only way a session gets its phases, its live
 * tool label and its end-of-turn notification. `claude/args.test.ts` proves the
 * builder when somebody hands it `hooksScriptPath`; this proves the provider
 * hands it, on the argv that really reaches `client.spawn`. Without that line
 * every session loses all three, and nothing else goes red.
 *
 * The broker client's `spawn` is replaced to record the argv: no daemon, no CLI.
 *
 * @covers CCS-06
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOPICS_HOOK_EVENTS, topicsHookCommand } from "../lib/topics-hooks";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SK = "topic:hooks-spawn";
let tempRoot = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempRoot = mkdtempSync(join(tmpdir(), "hooks-spawn-"));
  setEnv("DATA_DIR", join(tempRoot, "data"));
  setEnv("HOME", tempRoot);
  setEnv("TOPICS_HOME", join(tempRoot, "topics-home"));
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempRoot, "ai-bridge.sock"));
  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT, tempRoot);
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("hooks-spawn", "hooks-spawn", "hooks-spawn", SK, now, now);
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  const { cleanupMcpConfigForSession } = await import("./claude-code");
  cleanupMcpConfigForSession(SK);
  try { (await import("../db")).closeDatabase(); } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

test("the spawned argv has ONE --settings, with the seven hooks on the script under TOPICS_HOME", async () => {
  const { ClaudeCodeProvider, aiBridgeEnabled } = await import("./claude-code");
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const { hookScriptPath } = await import("../lib/topics-hook-script");
  // The branch every macOS and Linux server takes (`TOPICS_AI_BRIDGE` unset).
  expect(aiBridgeEnabled()).toBe(true);

  const client = getAiBridgeClient();
  let argv: string[] | null = null;
  client.spawn = async (_id, opts) => {
    argv = opts.args;
    return new Promise(() => {});
  };
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp = (provider as any).spawnPersistentProcess(SK);
  clearTimeout(pp.lifetimeTimer);

  expect(argv).not.toBeNull();
  const args = argv as unknown as string[];
  const at = args.flatMap((a, i) => (a === "--settings" ? [i] : []));
  // The CLI keeps the LAST `--settings` only: a second one would drop the first.
  expect(at).toHaveLength(1);
  const settings = JSON.parse(args[at[0]! + 1]!);
  const script = hookScriptPath();
  expect(script).toBe(join(tempRoot, "topics-home", "claude-hooks", "post-hook.sh"));
  for (const event of TOPICS_HOOK_EVENTS) {
    const commands = (settings.hooks[event] as Array<{ matcher?: string; hooks: Array<{ command: string }> }>)
      .filter((m) => !m.matcher)
      .flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toEqual([topicsHookCommand(script, event)]);
  }
});
