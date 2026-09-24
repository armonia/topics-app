/**
 * STOP, THEN A MESSAGE AT ONCE: the message reaches a live child and gets its
 * answer. Proved by spawning a real (fake) CLI that dies on SIGINT the way
 * Claude Code 2.1.280 does (see `tests/e2e/helpers/fake-claude-sigint-exit.ts`).
 *
 * Before the fix the second `sendChat` reused the stopping child: it ended on
 * the stopped turn's error result, and its text died with the process
 * (topic d6158ec6, 22/09: «no reply» in 5 and 38 ms, two task updates lost).
 * @covers CCLI-01
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
  tempDir = mkdtempSync(join(tmpdir(), "abort-send-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  const src = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-sigint-exit.ts");
  const fake = join(tempDir, "fake-claude-sigint-exit.ts");
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

describe("stop then send at once (whole chain, real child)", () => {
  test("the message sent right after a stop gets its own answer", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-as", "as", "as", "topic:abort-send-test", now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    const log: string[] = [];
    const handler = (tag: string, settle: () => void) => ({
      onTextDelta: () => {},
      onToolStart: () => { log.push(`${tag}:tool`); },
      onToolResult: () => {},
      onSubAgentUpdate: () => {},
      onUserInputRequired: () => {},
      onAborted: () => { log.push(`${tag}:aborted`); settle(); },
      onCompaction: () => {},
      onDone: (m?: { result?: string }) => { log.push(`${tag}:done:${m?.result ?? ""}`); settle(); },
      onError: (e: string) => { log.push(`${tag}:error:${e}`); settle(); },
    }) as never;

    // 1) A turn that works until stopped.
    let toolSeen!: () => void;
    const toolStarted = new Promise<void>((r) => { toolSeen = r; });
    const first = new Promise<void>((settle) => {
      const h = handler("first", settle) as Record<string, unknown>;
      const onToolStart = h.onToolStart as () => void;
      h.onToolStart = () => { onToolStart(); toolSeen(); };
      void provider.sendChat("topic:abort-send-test", "do some work", h as never);
    });
    await toolStarted;

    // 2) Stop it, and send the next message in the same tick, as the
    //    dispatcher does with a task update.
    await provider.abort("topic:abort-send-test", undefined, "user");
    const second = new Promise<void>((settle) => {
      void provider.sendChat("topic:abort-send-test", "tutto ok?", handler("second", settle));
    });
    await Promise.all([first, second]);

    expect(log).toContain("first:aborted");
    expect(log.filter((l) => l.startsWith("second:"))).toEqual(["second:done:ricevuto: tutto ok?"]);

    await provider.stop();
  }, 30_000);
});
