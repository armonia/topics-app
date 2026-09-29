/** @covers CODEX-02 */
/**
 * A forked Codex chat's first turn, through `sendChat` and a fake `codex`
 * binary: the argv it spawns, the prompt it writes, and what happens to the
 * fork afterwards.
 *
 *  - Parent unchanged since the click: `codex exec fork <parent> … -`, with
 *    ONLY the new message on stdin, and the fork consumed by its thread.started.
 *  - The fork dies before its thread.started: one fresh retry with the copied
 *    history, and the fork consumed, so the next turn does not retry it.
 *  - Parent moved on: fresh with the history at once, and the fork consumed.
 *
 * The fake reports the mode it saw, its last argument and the prompt it read,
 * as the turn's text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { _resetCodexBinCache } from "../lib/codex-bin";
import { insertChatFork, readForkOrigin } from "../lib/chat-fork-store";
import { CodexProvider } from "./codex";

let tempRoot: string;
let rollout: string;
const previous = { CODEX_BIN: process.env.CODEX_BIN, CODEX_HOME: process.env.CODEX_HOME };
const PARENT = "parent-thread-0001";
const HISTORY = [{ role: "user" as const, content: "copied prompt" }, { role: "assistant" as const, content: "copied answer" }];

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "topics-codex-fork-turn-")));
  initDatabase(join(import.meta.dir, "..", ".."), tempRoot);
  const day = join(tempRoot, "codex-home", "sessions", "2026", "09", "28");
  mkdirSync(day, { recursive: true });
  rollout = join(day, `rollout-2026-09-28T10-00-00-${PARENT}.jsonl`);
  writeFileSync(rollout, "{\"type\":\"session_meta\"}\n");
  process.env.CODEX_HOME = join(tempRoot, "codex-home");

  const binary = join(tempRoot, "fake-codex");
  writeFileSync(binary, `#!${process.execPath}
const argv = process.argv.slice(2);
const input = await Bun.stdin.text();
const mode = argv[1] === "fork" ? "fork" : argv[1] === "resume" ? "resume" : "fresh";
if (mode === "fork" && input.includes("FAILFORK")) { console.error("simulated fork failure"); process.exit(1); }
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + mode + "-" + Math.random().toString(36).slice(2) }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: mode + "|last=" + argv[argv.length - 1] + "|" + input } }));
`, { mode: 0o700 });
  process.env.CODEX_BIN = binary;
  _resetCodexBinCache();
});

afterAll(() => {
  for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetCodexBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

function branch(sessionKey: string, parentAt: string): void {
  const db = getDatabase();
  db.prepare("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')").run(sessionKey, sessionKey, sessionKey, sessionKey);
  insertChatFork(db, { sessionKey, parentTopicId: "p", parentName: "Parent", forkPointMessageId: "m", runtime: "codex-cli", parentRef: PARENT, parentAt, branchRef: null, createdAt: "now" });
}

function turn(sessionKey: string, message: string): Promise<{ text: string; errors: string[] }> {
  const provider = new CodexProvider({ type: "codex", defaultWorkspace: tempRoot });
  const errors: string[] = [];
  return new Promise((resolve, reject) => {
    void provider.sendChat(sessionKey, message, {
      onTextDelta() {}, onToolStart() {}, onToolResult() {},
      onError: (m) => { errors.push(m); },
      onDone: (done) => resolve({ text: done?.result ?? "", errors }),
    }, { model: "gpt-test-fixture", history: HISTORY }).catch(reject);
  });
}

const size = () => String(Bun.file(rollout).size);

describe("a forked Codex chat's first turn", () => {
  test("parent unchanged: `exec fork … -` with only the new message, and the fork consumed", async () => {
    branch("topic:cxturn1", size());
    const { text, errors } = await turn("topic:cxturn1", "the branch's first message");
    expect(errors).toEqual([]);
    expect(text).toBe("fork|last=-|the branch's first message");
    expect(readForkOrigin(getDatabase(), "topic:cxturn1")).toMatchObject({ parentRef: null, parentAt: null });
    // Never the parent again: the fake writes no rollout for the branch's own
    // thread, so the next turn is the fresh fallback, on the branch's history.
    const next = (await turn("topic:cxturn1", "second")).text;
    expect(next).toStartWith("fresh|");
    expect(next).not.toContain(PARENT);
  });

  test("a fork that dies before its thread: one fresh retry with the copied history, and the fork consumed", async () => {
    branch("topic:cxturn2", size());
    const { text, errors } = await turn("topic:cxturn2", "FAILFORK please");
    expect(errors).toEqual([]);
    expect(text).toStartWith("fresh|");
    expect(text).toContain("copied answer");
    expect(readForkOrigin(getDatabase(), "topic:cxturn2")).toMatchObject({ parentRef: null });
  });

  test("the parent moved on since the click: fresh with the copied history, and the fork consumed", async () => {
    branch("topic:cxturn3", size());
    appendFileSync(rollout, "{\"type\":\"turn\"}\n");
    const { text } = await turn("topic:cxturn3", "hello");
    expect(text).toStartWith("fresh|");
    expect(text).toContain("copied answer");
    expect(readForkOrigin(getDatabase(), "topic:cxturn3")).toMatchObject({ parentRef: null });
  });
});
