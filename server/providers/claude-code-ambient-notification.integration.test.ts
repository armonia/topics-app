/**
 * A NOTIFICATION FROM AN IDLE MOMENT DOES NOT SWALLOW THE NEXT TURN'S END.
 *
 * The notification skip (`claude-code-resume-notification.test.ts`) arms on a
 * `task_notification` and spends itself on the next result. Raised by the
 * adversarial check on 24/09: a notification seen while the session is idle
 * may never get a result of its own (the CLI marks some ambient), so the flag
 * stayed armed, and the person's next turn ending on an empty zero-turn result
 * (`/reset`, `/new`, `/compact` on an empty session) was skipped: the send hung
 * until the 30-minute watchdog. Proved with a real (fake) CLI child.
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

beforeAll(async () => {
  // The ai-bridge client is a process-wide singleton bound to the data dir it
  // first saw: reset it so this file never inherits another file's dead store.
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "ambient-notif-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  const src = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-ambient-notification.ts");
  const fake = join(tempDir, "fake-claude-ambient-notification.ts");
  cpSync(src, fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("an idle notification with no turn of its own (whole chain, real child)", () => {
  test("the next /reset still ends on its empty result instead of hanging", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-an", "an", "an", "topic:ambient-notif-test", now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    const results: string[] = [];
    const turn = (message: string) => new Promise<"done" | "hung">((resolve) => {
      const hung = setTimeout(() => resolve("hung"), 5_000);
      void provider.sendChat("topic:ambient-notif-test", message, {
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolResult: () => {},
        onSubAgentUpdate: () => {},
        onUserInputRequired: () => {},
        onAborted: () => {},
        onCompaction: () => {},
        onDone: (m?: { result?: string }) => { clearTimeout(hung); results.push(m?.result ?? ""); resolve("done"); },
        onError: (e: string) => { clearTimeout(hung); results.push(`error:${e}`); resolve("done"); },
      } as never);
    });

    expect(await turn("ciao")).toBe("done");
    // Give the idle notification time to land before the next send.
    await new Promise((r) => setTimeout(r, 100));
    expect(await turn("/reset")).toBe("done");

    // Same trap, other shape: `/compact` with nothing to compact ends on an
    // empty zero-turn result and no boundary.
    expect(await turn("di nuovo")).toBe("done");
    await new Promise((r) => setTimeout(r, 100));
    expect(await turn("/compact")).toBe("done");

    expect(results).toEqual(["ricevuto: ciao", "", "ricevuto: di nuovo", ""]);

    await provider.stop();
  }, 30_000);
});
