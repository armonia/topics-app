/**
 * THE ANSWER OF A COMMAND IS NOT A REPLY (CMDUI-04), with a real CLI child in
 * the broker that replays lines Claude Code 2.1.288 wrote
 * (`tests/e2e/helpers/fake-claude-replay.ts`).
 *
 * `/output-style` answers with a `<synthetic>` message and a `result` with
 * `num_turns: 0` and no cost: the provider hands that text to
 * `onCommandAnswer`, never to `onTextDelta`, and the turn ends with an empty
 * result, so the route saves nothing. `/compact` on an empty session gives its
 * reported outcome with the CLI's reason. An ordinary message is a reply.
 *
 * @covers CMDUI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stopOwnAiBridges } from "../../scripts/stray-ai-bridges";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CommandAnswerPayload, StreamHandler } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SESSION = "topic:command-answer";
let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "command-answer-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  // bun by absolute path (this process is bun): the CLI's environment is trimmed.
  const script = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-replay.ts");
  const wrapper = join(tempDir, "fake-claude");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", wrapper);
});

afterAll(async () => {
  await stopOwnAiBridges();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function recorder() {
  let resolveDone!: (r: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });
  const deltas: string[] = [];
  const answers: CommandAnswerPayload[] = [];
  const handler: StreamHandler = {
    onTextDelta: (d: string) => { deltas.push(d); },
    onToolStart: () => {},
    onToolResult: () => {},
    onCommandAnswer: (a) => { answers.push(a); },
    onDone: (m) => resolveDone(m?.result ?? ""),
    onError: (e: string) => resolveDone(`error:${e}`),
    onAborted: () => resolveDone("aborted"),
  } as StreamHandler;
  return { handler, done, deltas, answers };
}

describe.skipIf(process.platform === "win32")("a command's answer from a real CLI child (replayed lines)", () => {
  test("/compact on an empty session, /output-style and an ordinary message", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-cmdans", "cmdans", "cmdans", SESSION, now, now);
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    const compact = recorder();
    void provider.sendChat(SESSION, "/compact", compact.handler);
    expect(await compact.done).toBe("");
    expect(compact.answers).toEqual([{ command: "compact", text: "Not enough messages to compact.", outcome: { ok: false, error: "Not enough messages to compact." } }]);
    expect(compact.deltas).toEqual([]);

    const style = recorder();
    void provider.sendChat(SESSION, "/output-style", style.handler);
    expect(await style.done).toBe("");
    expect(style.answers).toHaveLength(1);
    expect(style.answers[0]!.command).toBe("output-style");
    expect(style.answers[0]!.text).toContain("Output style:");
    expect(style.deltas.join("")).not.toContain("Output style:");

    const plain = recorder();
    void provider.sendChat(SESSION, "ciao", plain.handler);
    expect(await plain.done).toBe("got: ciao");
    expect(plain.answers).toEqual([]);
    expect(plain.deltas.join("")).toBe("got: ciao");

    await provider.stop();
  }, 60_000);
});
