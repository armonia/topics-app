/**
 * A MESSAGE WRITTEN WHILE THE TURN RUNS REACHES THE MODEL AT THE NEXT ROUND.
 *
 * On 2026-11-11 Attilio wrote a second message in a Discord thread while
 * Jarvis worked on the first, and it waited for the end of the turn. Here the
 * loop runs against a fake model (scripted SSE through a fake `fetch`): round
 * one asks for a `bash` call, and while that command runs a message is offered
 * to the session (`lib/turn-steer.ts`). The request of round two must carry
 * it, after the tool result; a message offered during the last round, which
 * asks for no tool, is handed back for a turn of its own.
 * @covers CHAT-QUEUE-08
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";
import {
  offerSteer, openSteerTarget, resetTurnSteer, setSteerSink, steerLeftByHost, steerOpen, steerState, steerTaken,
  type SteerItem, type SteerMeta,
} from "../../lib/turn-steer";

const REAL_HOME = process.env.HOME;
const REAL_KEYCHAIN = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
const realFetch = globalThis.fetch;
let homeDir: string;
let ws: string;

const FAST: RetryPolicy = { maxAttempts: 2, baseMs: 1, capMs: 2, jitter: () => 1 };
const SK = "topic:steer0001";
const META: SteerMeta = { key: null, dispatched: false, dispatchedFor: [], author: null, into: "row-a" };

/** What the sink was told, in order. */
let told: Array<[string, string]> = [];
function recordSink() {
  told = [];
  setSteerSink({
    taken: (_sk, item) => { told.push(["taken", item.text]); },
    returned: (_sk, item) => { told.push(["returned", item.text]); },
  });
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const bashRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 0.2; echo ok" }) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
]);

const lastRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

function scriptFetch(answers: string[], bodies: string[], onRequest?: (n: number) => void) {
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    onRequest?.(n);
    const body = answers[Math.min(n++, answers.length - 1)]!;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function handler(onToolExecStart?: () => void): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolExecStart,
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
    onAborted: () => {},
  };
}

/** The last user message of a request body, as the model would read it. */
function lastUserContent(body: string): Array<{ type: string; text?: string; tool_use_id?: string }> {
  const msgs = (JSON.parse(body) as { messages: AgentMessage[] }).messages;
  const last = msgs[msgs.length - 1]!;
  expect(last.role).toBe("user");
  return last.content as Array<{ type: string; text?: string; tool_use_id?: string }>;
}

describe("steering a running native turn", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-steer-home-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
    delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
  });

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "native-steer-ws-"));
    resetTurnSteer();
    recordSink();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    if (REAL_KEYCHAIN === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    else process.env.TOPICS_CREDENTIALS_KEYCHAIN = REAL_KEYCHAIN;
    resetTurnSteer();
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("a message offered while a tool runs is in the request of the next round, after the tool result", async () => {
    const bodies: string[] = [];
    scriptFetch([bashRound, lastRound], bodies);
    const steer = openSteerTarget(SK);
    let offered: SteerItem | null = null;
    const history: AgentMessage[] = [{ role: "user", content: "fai il lavoro" }];
    const out = await runAgentTurn({
      model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply",
      retryPolicy: FAST, sessionId: SK, reminder: "rispondi in italiano",
      takeSteer: () => steer.take(),
    }, handler(() => { offered = offerSteer(SK, "e poi controlla anche i log", META); }));
    steer.close();

    expect(out.turnEnd.end).toBe("end_turn");
    expect(bodies).toHaveLength(2);
    // Round one never saw it: it was written after the request left.
    expect(bodies[0]).not.toContain("controlla anche i log");
    const content = lastUserContent(bodies[1]!);
    expect(content.map((b) => b.type)).toEqual(["tool_result", "text", "text"]);
    expect(content[0]!.tool_use_id).toBe("t1");
    expect(content[1]!.text).toBe("e poi controlla anche i log");
    // The language reminder stays the last thing the model reads.
    expect(content[2]!.text).toBe("rispondi in italiano");
    expect(steerState(SK, offered!.id)).toEqual({ state: "taken" });
    expect(told).toEqual([["taken", "e poi controlla anche i log"]]);
  });

  test("a message offered during the last round, which asks for no tool, is handed back", async () => {
    const bodies: string[] = [];
    const steer = openSteerTarget(SK);
    let offered: SteerItem | null = null;
    scriptFetch([lastRound], bodies, () => { offered = offerSteer(SK, "un'altra cosa", META); });
    await runAgentTurn({
      model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "ciao" }],
      toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST, takeSteer: () => steer.take(),
    }, handler());
    expect(steerState(SK, offered!.id)).toEqual({ state: "pending" });
    steer.close();
    expect(steerState(SK, offered!.id)).toEqual({ state: "returned" });
    expect(told).toEqual([["returned", "un'altra cosa"]]);
    expect(steerOpen(SK)).toBe(false);
  });

});

describe("the steer queue", () => {
  beforeEach(() => { resetTurnSteer(); recordSink(); });

  test("no running turn, no steer: the caller goes the usual way", () => {
    expect(offerSteer("topic:none", "ciao", META)).toBeNull();
  });

  test("a detached turn gets every message waiting and every later one, and only what it names is taken", () => {
    const steer = openSteerTarget(SK);
    const early = offerSteer(SK, "prima", META)!;
    const sent: string[] = [];
    steer.forwardTo((item) => sent.push(item.text));
    offerSteer(SK, "dopo", META);
    expect(sent).toEqual(["prima", "dopo"]);
    steerTaken(SK, [early]);
    steer.close();
    expect(told).toEqual([["taken", "prima"], ["returned", "dopo"]]);
  });

  test("Stop stops: what is left is held, not sent on", () => {
    const steer = openSteerTarget(SK);
    const item = offerSteer(SK, "fai anche X", META)!;
    steer.close({ stoppedByPerson: true });
    expect(steerState(SK, item.id)).toEqual({ state: "held" });
    expect(told).toEqual([]);
  });

  test("a detached host whose journal was cut: what it was sent is unknown, what it never got is returned", () => {
    const steer = openSteerTarget(SK);
    const sentToHost = offerSteer(SK, "inoltrato", META)!;
    steer.forwardTo(() => {});
    steer.close({ journalLost: true });
    expect(steerState(SK, sentToHost.id)).toEqual({ state: "unknown" });
    expect(told).toEqual([]);
  });

  test("after a restart the journal still writes the row of a message the host took, and sends on one it left", () => {
    // Nothing in this process offered them: the host's journal carries them whole.
    const took: SteerItem = { id: "steer-before-restart-1", text: "presa", meta: META };
    const left: SteerItem = { id: "steer-before-restart-2", text: "lasciata", meta: META };
    steerTaken(SK, [took]);
    steerLeftByHost(SK, [left]);
    expect(told).toEqual([["taken", "presa"], ["returned", "lasciata"]]);
  });

  test("after a restart, what a host left on a person's Stop is held, not sent", () => {
    const left: SteerItem = { id: "steer-before-restart-3", text: "dopo lo stop", meta: META };
    steerLeftByHost(SK, [left], true);
    expect(told).toEqual([]);
    expect(steerState(SK, left.id)).toEqual({ state: "held" });
  });

  test("a turn that replaced another one keeps the session open when the old one closes", () => {
    const old = openSteerTarget(SK);
    const current = openSteerTarget(SK);
    old.close();
    expect(steerOpen(SK)).toBe(true);
    expect(offerSteer(SK, "x", META)).not.toBeNull();
    expect(current.take()).toEqual(["x"]);
  });
});
