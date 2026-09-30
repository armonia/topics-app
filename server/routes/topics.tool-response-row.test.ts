/**
 * THE ANSWER IS WRITTEN ON THE QUESTION'S ROW (card 1046df0b).
 *
 * A question asked by a turn the watchdog had already closed sits on that
 * turn's own row, above the resume sweep's notice. `/api/chat/tool-response`
 * patched the session's LAST row, i.e. the notice, which has no such tool: the
 * write found nothing, and the question's row kept `waiting_for_input` with no
 * answer on it. The route runs for real; only the DB rows and the writer are
 * fake, and the writer records which row it was aimed at (`opts` absent = the
 * session's last row).
 *
 * The same holds for every other write of the route - the plan approval, the
 * provider resume and its two errors - and when no row carries the tool,
 * nothing is written: "not announced" is never read as "then the last row".
 *
 * @covers ASK-10
 */
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { createTopicsRouter } from "./topics";
import { beginAsk, cancelAsk } from "../lib/ask-user-bridge";
import { registerProvider, removeProvider } from "../providers";
import { PLAN_APPROVAL_QUESTION, PLAN_APPROVE_LABEL } from "../../shared/plan-decision";
import type { AnswerRelay } from "../lib/answer-relay";

// A REAL provider in the registry, as the route resolves it (`topic.provider`).
// Its two answers to a resume are switched per test on the instance, so no
// module mock outlives this file.
type ResumeOutcome = "unsupported" | "accepts" | "rejects";
let resume: ResumeOutcome = "unsupported";
const provider = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(provider, "connected", { configurable: true, get: () => resume !== "unsupported" });
provider.resumeWithToolResponse = async () => {
  if (resume === "rejects") throw new Error("no pending input for this tool call");
};
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

type Row = { id: string; tool_calls: string | null; blocks: string | null };

/** The resume sweep's notice: written after the turn, carries no tool. */
const NOTICE: Row = { id: "notice-row", tool_calls: null, blocks: JSON.stringify([{ kind: "error", text: "Ripresa automatica sospesa" }]) };

const toolRow = (toolCallId: string, name: string, extra: Record<string, unknown> = {}): Row => ({
  id: "turn-row",
  tool_calls: null,
  blocks: JSON.stringify([{ kind: "tool", toolCall: { id: toolCallId, name, status: "waiting_for_input", ...extra } }]),
});

interface Write { toolCallId: string; status: unknown; opts?: { rowId?: string } }

/** The route on a session whose recent rows (newest first) are `rows`. */
function harness(rows: Row[]) {
  const writes: Write[] = [];
  /** What `owed_answers` was told, in order: the index the boot loads (`lib/owed-answers.ts`). */
  const index: string[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const ctx = {
    OPENCLAW_DIR: tmpdir(),
    db: {
      prepare: (sql: string) => ({
        get: () => undefined,
        all: () => rows,
        run: (...args: unknown[]) => {
          if (/INSERT INTO owed_answers/.test(sql)) index.push(`owed ${String(args[1])}`);
          else if (/DELETE FROM owed_answers/.test(sql)) index.push(`not owed ${String(args[1])}`);
        },
      }),
      query: () => ({ get: () => null, all: () => [] }),
      transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
    },
    // Oldest first, as the active thread is: `rows` is given newest first.
    loadActiveThread: () => [...rows].reverse().map((r) => ({ id: r.id })),
    json,
    errorResponse: (status: number, error: string) => json({ error }, status),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: () => null,
    broadcastToAll: () => {},
    isStreaming: () => undefined,
    getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}`, sessionKey: key, autonomyLevel: "auto-apply", provider: "openai" }),
    saveSingleTopic: () => {},
    updateToolCallFields: (_sk: string, toolCallId: string, fields: { status?: unknown }, opts?: { rowId?: string }) => {
      writes.push({ toolCallId, status: fields.status, ...(opts ? { opts } : {}) });
    },
  } as any;
  const sent: Array<{ sessionKey: string; content: string }> = [];
  let relay: AnswerRelay | null = null;
  const router = createTopicsRouter(ctx, undefined, undefined, {
    exposeAnswerRelay: (r) => { relay = r; },
    // The chat route the relay posts the answer to: recorded, and taken the
    // way the real one takes it (claimed, then settled on its row once the
    // model hears the turn that carries it).
    answerRelayRoute: async (req) => {
      const body = await req.json() as { sessionKey: string; messages: Array<{ content: string }>; questionAnswer: { toolCallId: string } };
      sent.push({ sessionKey: body.sessionKey, content: body.messages[0]!.content });
      const claimed = relay!.claim(body.sessionKey, body.questionAnswer.toolCallId);
      if (claimed) { claimed.turnStarted = true; relay!.heard(claimed); }
      return new Response("{}", { status: 200 });
    },
  });
  const answer = async (sessionKey: string, toolCallId: string, response: unknown) => {
    const url = new URL("http://topics.test/api/chat/tool-response");
    return await router(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, toolCallId, response }),
    }), url, url.pathname, "POST") as Response;
  };
  return { answer, writes, sent, index };
}

const PLAN_YES = { kind: "questions", answers: { [PLAN_APPROVAL_QUESTION]: PLAN_APPROVE_LABEL } };
const NATIVE_ANSWER = { kind: "questions", answers: { "Quale ramo?": "sito" } };

describe("POST /api/chat/tool-response: the answer goes where the question is", () => {
  test("a question under a newer notice gets its answer on its own row, not on the notice", async () => {
    // The turn that asked was closed by the watchdog, which marked the question
    // `askerGone`: nobody polls for it any more, so the answer is recorded on
    // the question's row and goes to the model as the next message.
    const sk = "topic:answer-row";
    const h = harness([NOTICE, toolRow("toolu_ask", "mcp__topics__ask_user_question", { askerGone: true })]);
    try {
      const resp = await h.answer(sk, "toolu_ask", NATIVE_ANSWER);
      expect(resp.status).toBe(200);
      expect(h.writes[0]).toEqual({ toolCallId: "toolu_ask", status: "success", opts: { rowId: "turn-row" } });
      // The relay posts it on its own tick, then settles it on the same row.
      const until = Date.now() + 2000;
      while (h.writes.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
      expect(h.writes.slice(1)).toEqual([{ toolCallId: "toolu_ask", status: undefined, opts: { rowId: "turn-row" } }]);
      expect(h.sent.map((m) => m.sessionKey)).toEqual([sk]);
      expect(h.sent[0]!.content).toContain("sito");
      // Indexed with the `queued` mark, out of the index with the `sent` one.
      expect(h.index).toEqual(["owed toolu_ask", "not owed toolu_ask"]);
    } finally {
      cancelAsk(sk);
    }
  });

  test("with the asker still polling, the answer goes to the rendez-vous as before", async () => {
    const sk = "topic:answer-row-live";
    const h = harness([NOTICE, toolRow("toolu_ask_live", "mcp__topics__ask_user_question")]);
    beginAsk(sk);
    try {
      const resp = await h.answer(sk, "toolu_ask_live", NATIVE_ANSWER);
      expect(resp.status).toBe(200);
      expect(h.writes).toEqual([{ toolCallId: "toolu_ask_live", status: "running", opts: { rowId: "turn-row" } }]);
      expect(h.sent).toEqual([]);
    } finally {
      cancelAsk(sk);
    }
  });

  test("a send confirmation answered under a newer notice is recorded on the send's row", async () => {
    // The outbound gate paints its panel on the `send_mail` row itself: no
    // question tool there, so the ask lookup misses it, and the answer went on
    // the last row, i.e. the notice.
    const sk = "topic:send-answer-row";
    const h = harness([NOTICE, toolRow("toolu_send", "mcp__topics__send_mail")]);
    beginAsk(sk);
    try {
      const resp = await h.answer(sk, "toolu_send", { kind: "questions", answers: { "Confermi? (abcd1234)": "Conferma" } });
      expect(resp.status).toBe(200);
      expect(h.writes).toEqual([{ toolCallId: "toolu_send", status: "running", opts: { rowId: "turn-row" } }]);
    } finally {
      cancelAsk(sk);
    }
  });

  test("a plan approval under a newer notice is recorded on the plan's row", async () => {
    const h = harness([NOTICE, toolRow("toolu_plan", "ExitPlanMode")]);
    const resp = await h.answer("topic:plan-row", "toolu_plan", PLAN_YES);
    expect(resp.status).toBe(200);
    expect(h.writes).toEqual([{ toolCallId: "toolu_plan", status: "success", opts: { rowId: "turn-row" } }]);
  });

  test("a resume the provider accepted marks the tool's own row as running", async () => {
    resume = "accepts";
    try {
      const h = harness([NOTICE, toolRow("toolu_native", "AskUserQuestion")]);
      const resp = await h.answer("topic:resume-row", "toolu_native", NATIVE_ANSWER);
      expect(resp.status).toBe(200);
      expect(h.writes).toEqual([{ toolCallId: "toolu_native", status: "running", opts: { rowId: "turn-row" } }]);
    } finally {
      resume = "unsupported";
    }
  });

  test("a resume the provider rejected fails the tool on its own row", async () => {
    resume = "rejects";
    try {
      const h = harness([NOTICE, toolRow("toolu_native", "AskUserQuestion")]);
      const resp = await h.answer("topic:resume-rejected-row", "toolu_native", NATIVE_ANSWER);
      expect(resp.status).toBe(404);
      expect(h.writes).toEqual([{ toolCallId: "toolu_native", status: "error", opts: { rowId: "turn-row" } }]);
    } finally {
      resume = "unsupported";
    }
  });

  test("a provider that cannot resume fails the tool on its own row", async () => {
    const h = harness([NOTICE, toolRow("toolu_native", "AskUserQuestion")]);
    const resp = await h.answer("topic:no-resume-row", "toolu_native", NATIVE_ANSWER);
    expect(resp.status).toBe(503);
    expect(h.writes).toEqual([{ toolCallId: "toolu_native", status: "error", opts: { rowId: "turn-row" } }]);
  });

  test("no recent row carries the tool: nothing is written, least of all on the last row", async () => {
    const plan = harness([NOTICE]);
    expect((await plan.answer("topic:plan-nowhere", "toolu_plan", PLAN_YES)).status).toBe(200);
    expect(plan.writes).toEqual([]);

    const failed = harness([NOTICE]);
    expect((await failed.answer("topic:resume-nowhere", "toolu_native", NATIVE_ANSWER)).status).toBe(503);
    expect(failed.writes).toEqual([]);
  });
});
