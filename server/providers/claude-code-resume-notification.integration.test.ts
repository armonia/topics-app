/**
 * THE PERSON'S TURN SURVIVES A RESUME THAT OPENS WITH A LEFTOVER NOTIFICATION,
 * proved by spawning a real (fake) CLI process.
 *
 * The unit test (`claude-code-resume-notification.test.ts`) pins the decision.
 * This one proves the chain: sendChat, spawn, stdout NDJSON, readline,
 * handleStreamEvent, onDone. The fake CLI prints the notification's empty
 * result BEFORE it reads stdin, as the real one did on 24/09 (topic 33966f4e):
 * the person's `sendChat` must end with the answer to their message, not with
 * that empty result.
 * @covers CCLI-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "resume-notif-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  const src = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-resume-notification.ts");
  const fake = join(tempDir, "fake-claude-resume-notification.ts");
  cpSync(src, fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});

afterAll(async () => {
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("resume with a leftover notification (whole chain, real child)", () => {
  test("the person's turn ends with the answer to their message, not the notification's empty result", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-rn", "rn", "rn", "topic:resume-notif-test", now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    const results: string[] = [];
    const texts: string[] = [];
    const errors: string[] = [];
    const turn = (message: string) => new Promise<void>((resolve, reject) => {
      void provider.sendChat("topic:resume-notif-test", message, {
        onTextDelta: (t: string) => { texts.push(t); },
        onToolStart: () => {},
        onToolResult: () => {},
        onSubAgentUpdate: () => {},
        onUserInputRequired: () => {},
        onAborted: () => {},
        onCompaction: () => {},
        onDone: (m?: { result?: string }) => { results.push(m?.result ?? ""); resolve(); },
        onError: (e: string) => { errors.push(e); reject(new Error(e)); },
      } as never).catch(reject);
    });

    await turn("tutto ok?");
    expect(errors).toEqual([]);
    expect(results).toEqual(["ricevuto: tutto ok?"]);

    // And the next message still has its own turn: nothing is left queued.
    await turn("e adesso?");
    expect(results).toEqual(["ricevuto: tutto ok?", "ricevuto: e adesso?"]);

    await provider.stop();
  }, 30_000);
});
