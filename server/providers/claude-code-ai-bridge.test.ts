/**
 * Broker-path integration test: drives a full provider turn with
 * TOPICS_AI_BRIDGE=1, so the `claude` child runs in the detached ai-bridge
 * daemon instead of as a direct server child. A fake stream-json CLI reads the
 * user message from stdin and emits a `result` event; we assert onDone fires
 * through the whole chain: sendChat → daemon spawn → stdin write → stdout `data`
 * frame → PassThrough → readline → handleStreamEvent → onDone.
  * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-provider-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-provider-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", SOCK);

  // Fake stream-json CLI: read one stdin line (the user message), emit a result.
  const fake = join(tempDir, "fake-claude.sh");
  writeFileSync(fake, `#!/bin/sh
read line
printf '{"type":"result","result":"pong","usage":{"input_tokens":3,"output_tokens":5},"duration_ms":2,"total_cost_usd":0}\\n'
`);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
  // Drop any singleton a prior broker test file created with a different socket.
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
});

afterAll(async () => {
  // Dispose the client FIRST so killing the daemon below doesn't trigger the
  // auto-reconnect (which would respawn a daemon and hang the process).
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* not opened */ }
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("claude-code provider · ai-bridge broker path", () => {
  test("a full turn completes through the detached daemon (onDone fires)", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    // claude_code_sessions.session_key has an FK to topics(session_key) — seed a topic.
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-brk", "brk", "brk", "topic:brk-test", now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    let doneResult: string | null = null;
    let errored: string | null = null;
    const done = new Promise<void>((resolve, reject) => {
      const handler: any = {
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolResult: () => {},
        onSubAgentUpdate: () => {},
        onUserInputRequired: () => {},
        onAborted: () => {},
        onDone: (d: any) => { doneResult = d.result; resolve(); },
        onError: (e: string) => { errored = e; reject(new Error(e)); },
      };
      provider.sendChat("topic:brk-test", "hello", handler).catch(reject);
    });

    await done;
    expect(errored).toBeNull();
    expect(doneResult as string | null).toBe("pong");

    await provider.stop();
  }, 20000);
});
