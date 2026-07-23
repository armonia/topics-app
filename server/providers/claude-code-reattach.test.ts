/**
 * Reattach correctness: a turn that survives a server restart in the ai-bridge
 * daemon is ADOPTED and completed in place, not re-run. Two ClaudeCodeProvider
 * instances share the module-singleton bridge client (= "restart": provider A
 * dies, provider B reconnects to the surviving daemon session).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-reattach-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

let ProviderCtor: any;
let seedTopic: (sessionKey: string, id: string) => void;

function makeHandler() {
  let text = "";
  let doneResult: string | null = null;
  let doneErr: string | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const handler: any = {
    onTextDelta: (_delta: string, full: string) => { text = full; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {},
    onUserInputRequired: () => {}, onAborted: () => resolveDone(),
    onDone: (d: any) => { doneResult = d.result; resolveDone(); },
    onError: (e: string) => { doneErr = e; resolveDone(); },
  };
  return { handler, done, get text() { return text; }, get result() { return doneResult; }, get err() { return doneErr; } };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-reattach-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", SOCK);

  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  seedTopic = (sessionKey, id) => {
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT OR IGNORE INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(id, id, id, sessionKey, now, now);
  };
  ProviderCtor = (await import("./claude-code")).ClaudeCodeProvider;
  // Drop any singleton a prior broker test file created with a different socket.
  (await import("../lib/ai-bridge-client")).__resetAiBridgeClientForTests();
});

afterAll(async () => {
  // Dispose the client FIRST so killing the daemon doesn't trigger auto-reconnect.
  (await import("../lib/ai-bridge-client")).__resetAiBridgeClientForTests();
  try { (await import("../db")).closeDatabase(); } catch {}
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch {}
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function writeFakeCli(name: string, body: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Poll `pred` until true or `timeoutMs` elapses — a deterministic replacement
 *  for fixed sleeps that raced against a real subprocess on loaded machines. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("claude-code provider · reattach", () => {
  test("mid-generation: provider B adopts the live turn and completes it (partial replayed, not re-run)", async () => {
    // Fake CLI: emit an assistant partial, sleep, then the result. The reattach
    // happens during the sleep window.
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-midgen.sh",
      `read line
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"partial-answer"}]}}\\n'
sleep 2
printf '{"type":"result","result":"final-answer","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}\\n'`));
    const sessionKey = "topic:reattach-midgen";
    seedTopic(sessionKey, "t-midgen");

    // Provider A starts the turn; abandon it mid-flight (simulated restart).
    const provA = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const hA = makeHandler();
    provA.sendChat(sessionKey, "hello", hA.handler).catch(() => { /* A dies at restart */ });

    // Deterministic sync instead of a fixed sleep: wait until the partial NDJSON
    // has actually landed in the daemon store (endOffset grows past 0). The CLI
    // sleeps 2s before the result, so this poll resolves well inside the
    // mid-generation window on any machine — no reliance on wall-clock timing.
    const bridge = (await import("../lib/ai-bridge-client")).getAiBridgeClient();
    await waitFor(async () => ((await bridge.list()).find((s) => s.id === sessionKey)?.endOffset ?? 0) > 0, 8000);

    // "Restart": provider B reattaches to the surviving daemon session.
    const provB = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    expect(await provB.hasLiveSession(sessionKey)).toBe(true);
    const hB = makeHandler();
    const outcome = await provB.reattach(sessionKey, hB.handler);
    // reattach ADOPTS the live turn and returns immediately with its state; wait
    // for the turn to actually finish (onDone/onError/onAborted) before asserting.
    expect(["live", "awaiting-input"]).toContain(outcome);
    await hB.done;

    expect(hB.err).toBeNull();
    expect(hB.result as string | null).toBe("final-answer");
    expect(hB.text).toContain("partial-answer"); // replay rebuilt the partial
  }, 20000);

  test("completed-while-down: replay carries the result → onDone fires, outcome 'completed', no re-run", async () => {
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-done.sh",
      `read line
printf '{"type":"result","result":"already-done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}\\n'`));
    const sessionKey = "topic:reattach-done";
    seedTopic(sessionKey, "t-done");

    const provA = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const hA = makeHandler();
    await provA.sendChat(sessionKey, "hello", hA.handler).catch(() => {});
    // A's turn finished; the store still holds the result event for a late attach.
    await new Promise((r) => setTimeout(r, 150));

    const provB = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const hB = makeHandler();
    const outcome = await provB.reattach(sessionKey, hB.handler);
    expect(outcome).toBe("completed");
    expect(hB.result as string | null).toBe("already-done");
  }, 20000);
});
