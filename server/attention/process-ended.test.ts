/**
 * The end of a subject's process closes the work in flight, and says so once
 * (ATTN-15, T16).
 *
 * The reaper that closes a chat idle for fifteen minutes is housekeeping and
 * lights nothing; a lifetime cap that kills a chat waiting on its Agent, a PTY
 * that crashes mid-turn, or a restart that finds a chat's process gone with a
 * task in flight leave a wait that will never be answered, and that is an
 * error the person must see.
 * @covers ATTN-15
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  configureAttentionStore,
  getAttention,
  markAttentionSeen,
  processEnded,
  recomposeAttentionOnBoot,
  resetAttentionStore,
  turnEnded,
  turnStarted,
} from "./store";
import { createClaudeSessionTracker } from "../lib/claude-session-tracker";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

const pushes: unknown[] = [];
const rows: string[] = [];
beforeEach(() => {
  resetAttentionStore();
  pushes.length = 0;
  rows.length = 0;
  configureAttentionStore({ db: () => null, sendPush: (p) => { pushes.push(p); }, recordRow: (i) => { rows.push(i.kind); return null; } });
});

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const migDir = join(import.meta.dir, "..", "db", "migrations");
  for (const prefix of ["027-", "096-"]) {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    const sql = readFileSync(join(migDir, file), "utf-8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) db.run(statement);
  }
  return db;
}

describe("the end of a process", () => {
  it("the reaper closing a chat already seen, with nothing in flight, makes no epoch", () => {
    turnStarted("topic:quiet");
    turnEnded("topic:quiet", { turnId: "m1", outcome: "done" });
    const a = getAttention("topic:quiet");
    markAttentionSeen([{ subject: "topic:quiet", epoch: a.epoch, turnAt: a.lastTurnAt }]);
    rows.length = 0; pushes.length = 0;
    processEnded("topic:quiet", { cause: "reaper" });
    expect(getAttention("topic:quiet")).toMatchObject({ state: "idle", epoch: 1, lit: false });
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("the lifetime cap closing a chat that waits on an Agent is finished(error), with a new epoch", () => {
    turnStarted("topic:capped");
    turnEnded("topic:capped", { turnId: "m1", outcome: "done", background: { a1: { kind: "agent", label: "verify render", startedAt: new Date().toISOString() } } });
    expect(getAttention("topic:capped").state).toBe("working");
    processEnded("topic:capped", { cause: "lifetime-cap" });
    const a = getAttention("topic:capped");
    expect(a).toMatchObject({ state: "finished", outcome: "error", epoch: 1, lit: true });
    expect(a.background).toEqual([]);
    expect(a.detail).toContain("1");
    expect(rows).toEqual(["chat-error"]);
  });

  it("the reaper closing a chat that waits on its run_command lights nothing: the command runs on and its wake will come", () => {
    turnStarted("topic:cmd");
    turnEnded("topic:cmd", { turnId: "m1", outcome: "done", background: { command: { kind: "command", label: "run_command", startedAt: new Date().toISOString() } } });
    expect(getAttention("topic:cmd").state).toBe("working");
    rows.length = 0; pushes.length = 0;
    processEnded("topic:cmd", { cause: "reaper", turnClosedByRoute: true });
    const a = getAttention("topic:cmd");
    expect(a.state).toBe("working");
    expect(a.background.map((t) => t.kind)).toEqual(["command"]);
    expect(rows).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("a CLI that dies waiting on an Agent and a run_command is one error, for the Agent only", () => {
    turnStarted("topic:both");
    turnEnded("topic:both", { turnId: "m1", outcome: "done", background: {
      a1: { kind: "agent", label: "verify", startedAt: new Date().toISOString() },
      command: { kind: "command", label: "run_command", startedAt: new Date().toISOString() },
    } });
    processEnded("topic:both", { cause: "cli-exit", turnClosedByRoute: true });
    const a = getAttention("topic:both");
    expect(a).toMatchObject({ state: "finished", outcome: "error", lit: true });
    expect(a.detail).toContain("1 compito");
    expect(rows).toEqual(["chat-error"]);
  });

  it("markPtyCrash on a terminal in working is finished(error)", () => {
    const tracker = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50,
      attentionSubject: (s) => `terminal:${s.claudeSessionId}` });
    tracker.registerTerminalSession("cli-crash", { now: 1_700_000_000_000 });
    tracker.ingestHook({ hook_event_name: "UserPromptSubmit", session_id: "cli-crash" } as never, 1_700_000_000_200);
    expect(getAttention("terminal:cli-crash").state).toBe("working");
    tracker.notePtyCrash("cli-crash", 137, 1_700_000_000_400);
    expect(getAttention("terminal:cli-crash")).toMatchObject({ state: "finished", outcome: "error", lit: true });
  });

  it("a stop the person asked for is not an error", () => {
    turnStarted("topic:stopped");
    processEnded("topic:stopped", { cause: "pty-exit", byPerson: true });
    expect(getAttention("topic:stopped")).toMatchObject({ state: "idle", lit: false, epoch: 0 });
  });

  it("a restart with no process left and a task in flight is finished(error), live: false, with no push and no row", () => {
    const frames: Array<Record<string, any>> = [];
    configureAttentionStore({ broadcast: (f) => { frames.push(f as Record<string, any>); } });
    turnStarted("topic:orphan");
    turnEnded("topic:orphan", { turnId: "m1", outcome: "done", background: { b1: { kind: "bash", label: "sleep 600", startedAt: new Date().toISOString() } } });
    resetAttentionStore({ keepRows: true });
    configureAttentionStore({ db: () => null, sendPush: (p) => { pushes.push(p); }, recordRow: (i) => { rows.push(i.kind); return null; }, broadcast: (f) => { frames.push(f as Record<string, any>); } });
    frames.length = 0; rows.length = 0; pushes.length = 0;
    recomposeAttentionOnBoot({ liveProcess: () => false });
    expect(getAttention("topic:orphan")).toMatchObject({ state: "finished", outcome: "error", lit: true });
    expect(pushes).toHaveLength(0);
    expect(rows).toHaveLength(0);
    expect(frames.filter((f) => f.type === "attention:updated" && f.live === true)).toHaveLength(0);
  });
});
