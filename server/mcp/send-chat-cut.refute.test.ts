/**
 * Refutation tests for the cut-stream fallback of send_chat_message.
 * @covers CHAT-STREAM-01
 * Each test models a behaviour of the REAL server, cited next to it.
 *
 * Copied from the independent review of df9b2fd2e (card 63e01ac0). Adapted to
 * the fix in two ways only: the cut stream opens with the route's `turn` frame
 * naming the row (and the rows carry ids, read one by one as the server serves
 * them since round 3), and the "never partial" test takes
 * an explicit failure as an answer too, since a turn still partial at the end
 * of the wait is one.
 */
import { describe, test, expect } from "bun:test";
import { callSendChatMessage } from "./topics-mcp-server";

const A = { baseUrl: "http://x", sessionKey: "topic:mine" };
const FAST = { pollMs: 5, maxWaitMs: 500 };

function cutSse(deltas: string[]): Response {
  const lines = `data: ${JSON.stringify({ turn: { messageId: "m1" } })}\n\n` + deltas.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function world(opts: {
  streaming: (poll: number) => Array<{ sessionKey: string; state: string }>;
  messages: (poll: number) => Array<Record<string, unknown>>;
}) {
  let polls = 0;
  const f = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith("/api/topics/t1")) return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "Target" } }), { status: 200 });
    if (u.endsWith("/api/chat")) return cutSse(["half "]);
    if (u.endsWith("/api/topics/streaming")) return new Response(JSON.stringify({ sessions: opts.streaming(++polls) }), { status: 200 });
    const one = u.match(/\/api\/topics\/t1\/messages\/([^/?]+)$/);
    if (one) {
      const row = opts.messages(polls).find((m) => m.id === one[1]);
      return new Response(JSON.stringify(row ? { message: row } : { error: "Message not found" }), { status: row ? 200 : 404 });
    }
    if (u.includes("/api/topics/t1/messages")) return new Response(JSON.stringify({ messages: opts.messages(polls) }), { status: 200 });
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;
  return f;
}

const LIVE = [{ sessionKey: "topic:target", state: "streaming" }];

describe("REFUTE: cut stream fallback", () => {
  /**
   * server/utils.ts:2115-2130 isStreaming() says "not streaming" once lastActivity
   * is > 3 min old, WITHOUT removing the entry; GET /api/topics/streaming
   * (server/routes/topics.ts:1123) skips it. During a silent tool the soft timer
   * is suspended (chat.ts:1495-1499) and only the StaleStream sweeper (every 30 s,
   * server.ts:4885) bumps lastActivity, and only once silence > 3 min
   * (stale-stream-verdict.ts: silentMs <= timeoutMs -> "ok"). So a LIVE turn in
   * a silent tool vanishes from /api/topics/streaming for up to 30 s every ~3 min.
   * The poll (every 2 s) sees that gap and treats it as the end of the turn.
   */
  test("a live turn briefly missing from /api/topics/streaming (stale gap) is not the end", async () => {
    const fetchImpl = world({
      // poll 1: live; poll 2: stale gap (turn still running); poll 3: live again; poll 4+: really over
      streaming: (p) => (p === 2 ? [] : p < 4 ? LIVE : []),
      messages: (p) => [
        { id: "u1", role: "user", content: "ping" },
        p < 4
          ? { id: "m1", role: "assistant", content: "half ", partial: true }
          : { id: "m1", role: "assistant", content: "half an answer, and then the rest of it", latencyMs: 1200 },
      ],
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST);
    expect(out).toBe("half an answer, and then the rest of it");
  });

  /** Even without a gap: at df9b2fd2e the fallback never looked at `partial` (kept on the wire, shared/lean-tool-call.ts:124). */
  test("a row still partial=true is never returned as the reply", async () => {
    const fetchImpl = world({
      streaming: () => [],
      messages: () => [
        { id: "u1", role: "user", content: "ping" },
        { id: "m1", role: "assistant", content: "half ", partial: true },
      ],
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST)
      .catch((err: Error) => err.message);
    expect(out).not.toContain("half");
  });

  /**
   * A queued message (UI queue drains on stream:end) or a goal-loop
   * continuation (chat.ts:2384, setTimeout 0 after endStream) starts a NEW turn
   * on the same sessionKey. /api/topics/streaming cannot tell it from ours.
   */
  test("the NEXT turn's reply is not appended to ours", async () => {
    const fetchImpl = world({
      streaming: (p) => (p <= 3 ? LIVE : []),
      messages: () => [
        { id: "u1", role: "user", content: "ping" },
        { id: "m1", role: "assistant", content: "our full answer", latencyMs: 1200 },
        { id: "u2", role: "user", content: "queued follow-up from the person" },
        { id: "m2", role: "assistant", content: "someone else's answer", latencyMs: 1200 },
      ],
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST);
    expect(out).toBe("our full answer");
  });

  test("a chain of later turns past the cap is not reported as OUR turn still running", async () => {
    const fetchImpl = world({
      streaming: () => LIVE, // goal loop keeps going; our turn ended at once
      messages: () => [
        { id: "u1", role: "user", content: "ping" },
        { id: "m1", role: "assistant", content: "our full answer", latencyMs: 1200 },
        { id: "u2", role: "user", content: "Objective still open: continue" },
      ],
    });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST)).resolves.toContain("our full answer");
  });
});
