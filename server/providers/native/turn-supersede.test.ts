/**
 * ONE TURN PER SESSION, IN THE RUNTIME AND NOT ONLY AT THE FRONT DOOR.
 *
 * ── The defect (2026-08-27 and 2026-08-29) ─────────────────────────────────
 * `sendChat` had no in-flight guard. A second call on a session whose turn was
 * still running overwrote `session.abort` with its own controller, both loops
 * pushed into the SAME `history`, and when the first turn ended its `finally`
 * cleared the handle unconditionally: `isTurnProcessAlive` then said "dead" of
 * the second turn, which was alive, and the sweeper killed it. Meanwhile the
 * first turn (a zombie the sweeper had already declared over without aborting
 * it) kept running tools and writing its blocks onto the second turn's row,
 * and the shared history ended with a `tool_use` without a `tool_result`, which
 * the API refuses on every call after that.
 *
 * The CLI cannot do this: one child process, one stdin, turns serialize by
 * construction. This is the parity gap, and these tests are red against the
 * code as it was: the second call started while the first was still inside its
 * tool.
 *
 * No network: a fake fresh token under a scratch HOME, and `fetch` answering
 * with canned SSE rounds. The first turn is parked inside a `sleep 30`, which
 * is where a real agent turn spends its time.
 * @covers RT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A round that parks the turn inside a long command. */
const roundWithLongTool = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first turn" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_long", name: "bash", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"sleep 30"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
]);

const finalRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second turn" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
]);

interface Spy extends StreamHandler {
  events: string[];
  ends: TurnEndInfo[];
}

function spy(): Spy {
  const events: string[] = [];
  const ends: TurnEndInfo[] = [];
  return {
    events,
    ends,
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => { events.push("done"); if (m?.turnEnd) ends.push(m.turnEnd); },
    onError: () => { events.push("error"); },
    onAborted: (m) => { events.push("aborted"); if (m?.turnEnd) ends.push(m.turnEnd); },
  };
}

type ApiMessage = { role: string; content: string | Array<{ type: string; id?: string; tool_use_id?: string }> };

/** Every `tool_use` the model wrote must be answered by a `tool_result` in the next message. */
function danglingToolUses(messages: ApiMessage[]): string[] {
  const dangling: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const next = messages[i + 1];
    const answered = new Set(
      next && typeof next.content !== "string"
        ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
        : [],
    );
    for (const b of m.content) if (b.type === "tool_use" && !answered.has(b.id)) dangling.push(b.id ?? "?");
  });
  return dangling;
}

describe("a second sendChat on a session with a live turn", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "native-supersede-home-"));
    workspace = mkdtempSync(join(tmpdir(), "native-supersede-ws-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("supersedes the first turn, waits for it, and only then starts on a repaired history", async () => {
    const SK = "topic:supersede";
    const timeline: string[] = [];
    const bodies: ApiMessage[][] = [];
    let toolStarted!: () => void;
    const toolRunning = new Promise<void>((r) => { toolStarted = r; });
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body ?? "{}")).messages as ApiMessage[]);
      timeline.push(`fetch#${calls}`);
      if (calls === 1) return new Response(roundWithLongTool, { status: 200 });
      return new Response(finalRound, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    const first = spy();
    first.onToolExecStart = () => { toolStarted(); };
    const started = Date.now();
    const firstTurn = provider.sendChat(SK, "start something long", first).then((r) => { timeline.push("first-ended"); return r; });
    await toolRunning;
    expect(provider.isTurnProcessAlive(SK)).toBe(true);

    // The follow-up arrives while the first turn sits inside `sleep 30`.
    const second = spy();
    const secondTurn = provider.sendChat(SK, "and now this", second).then((r) => { timeline.push("second-ended"); return r; });
    await Promise.all([firstTurn, secondTurn]);

    // 1. The first turn was stopped, and told WHY: not "user", not a watchdog.
    expect(first.events).toEqual(["aborted"]);
    expect(first.ends[0]).toEqual({ end: "cancelled", cause: "superseded" });
    // 2. It did not wait for the command: the sleep would have taken 30s.
    expect(Date.now() - started).toBeLessThan(5000);
    // 3. ORDER: the second turn did not call the model until the first was over.
    expect(timeline).toEqual(["fetch#1", "first-ended", "fetch#2", "second-ended"]);
    // 4. The second turn ran to completion, alone, and the session is free now.
    expect(second.events).toEqual(["done"]);
    expect(provider.isTurnProcessAlive(SK)).toBe(false);
    // 5. The history the second call sent is one the API accepts: the first
    //    turn's unanswered `tool_use` was repaired before the request, not
    //    shared with a loop still writing into it.
    expect(danglingToolUses(bodies[1] ?? [])).toEqual([]);
    const last = bodies[1]?.[bodies[1].length - 1];
    expect(last?.role).toBe("user");
    expect(JSON.stringify(last?.content)).toContain("and now this");
  });

  test("the abort handle belongs to the turn that set it: an older turn's end does not free a newer one", async () => {
    const SK = "topic:handle-owner";
    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    const sessions = (provider as unknown as { sessions: Map<string, unknown> }).sessions;
    // A session assembled the way the provider keeps it: a live handle with no
    // turn promise behind it (no `finally` will ever clear it).
    const stale = new AbortController();
    sessions.set(SK, { history: [], workspace, abort: stale, lastUsedAt: Date.now() });

    globalThis.fetch = (async () => new Response(finalRound, { status: 200 })) as unknown as typeof fetch;
    const h = spy();
    await provider.sendChat(SK, "go", h);

    // The stale handle was aborted with a declared cause, the new turn ran and
    // released ITS handle: the session is free, not stuck behind a controller
    // nobody owns.
    expect(stale.signal.aborted).toBe(true);
    expect(stale.signal.reason).toBe("superseded");
    expect(h.events).toEqual(["done"]);
    expect(provider.isTurnProcessAlive(SK)).toBe(false);
  });
});
