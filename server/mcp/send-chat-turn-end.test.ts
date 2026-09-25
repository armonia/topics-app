/**
 * A STREAM THAT CLOSES WITHOUT [DONE] IS NOT A REPLY, AND NEITHER IS HALF OF ONE.
 * @covers CHAT-STREAM-01, CHAT-INT-01
 *
 * On 2026-09-24 the chat's SSE response closed after 255 s of a silent tool
 * (Bun's idle timeout) with HTTP 200 and no `data: [DONE]`, while the turn went
 * on. `send_chat_message` read until the close and returned what it had: half
 * an answer, handed to a coordinating agent as the answer. A close without
 * `[DONE]` now means "incomplete": wait on the turn's own row, named by the
 * route's first `turn` frame, until it is no longer partial. And a `[DONE]`
 * after a `turn` frame with an end is a turn stopped or failed halfway.
 */
import { describe, test, expect } from "bun:test";
import { callSendChatMessage } from "./topics-mcp-server";

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return impl as typeof fetch;
}

describe("callSendChatMessage when the turn does not finish on the stream", () => {
  const A = { baseUrl: "http://x", sessionKey: "topic:mine" };
  const FAST = { pollMs: 5, maxWaitMs: 200 };
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const delta = (c: string) => frame({ choices: [{ delta: { content: c } }] });

  function sseResponse(raw: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  /** The idle close: the row named, a ping, half a reply, no [DONE]. */
  const cut = frame({ turn: { messageId: "m1" } }) + ": ping\n\n" + delta("half ");

  function world(opts: {
    chat?: string;
    streaming: () => Array<{ sessionKey: string; state: string }>;
    messages: () => Array<Record<string, unknown>>;
  }) {
    return stubFetch(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/topics/t1")) return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "Target" } }), { status: 200 });
      if (u.endsWith("/api/chat")) return sseResponse(opts.chat ?? cut);
      if (u.endsWith("/api/topics/streaming")) return new Response(JSON.stringify({ sessions: opts.streaming() }), { status: 200 });
      // The routes as the server serves them: one row by id, partial and empty
      // included, or 404; the list without a partial row that has no text yet.
      const one = u.match(/\/api\/topics\/t1\/messages\/([^/?]+)$/);
      if (one) {
        const row = opts.messages().find((m) => m.id === one[1]);
        return row
          ? new Response(JSON.stringify({ message: row }), { status: 200 })
          : new Response(JSON.stringify({ error: "Message not found" }), { status: 404 });
      }
      if (u.includes("/api/topics/t1/messages?")) {
        const listed = opts.messages().filter((m) => !m.partial || String(m.content ?? "").trim());
        return new Response(JSON.stringify({ messages: listed }), { status: 200 });
      }
      throw new Error(`unexpected url ${u}`);
    });
  }
  const LIVE = [{ sessionKey: "topic:target", state: "streaming" }];

  test("waits on its own row and returns it once final, not the half it read", async () => {
    let polls = 0;
    const fetchImpl = world({
      streaming: () => LIVE,
      messages: () => [
        { id: "u0", role: "user", content: "ping" },
        { id: "m0", role: "assistant", content: "an earlier answer to the same words" },
        { id: "u1", role: "user", content: "ping" },
        ++polls < 3
          ? { id: "m1", role: "assistant", content: "half ", partial: true }
          : { id: "m1", role: "assistant", content: "half an answer, and then the rest of it" },
      ],
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST);
    expect(out).toBe("half an answer, and then the rest of it");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("a turn still running past the wait is an explicit failure, never half an answer", async () => {
    const fetchImpl = world({ streaming: () => LIVE, messages: () => [{ id: "m1", role: "assistant", content: "half ", partial: true }] });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/stream interrupted.*still running/i);
  });

  test("a turn waiting for a person's answer says so at once", async () => {
    const fetchImpl = world({
      streaming: () => [{ sessionKey: "topic:target", state: "waiting" }],
      messages: () => [{ id: "m1", role: "assistant", content: "", partial: true }],
    });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/stream interrupted.*waiting for a person/i);
  });

  /**
   * THE CASE OF C7, WITHOUT A CLOCK TO LOSE TO. The row of a turn silent in a
   * tool usually has no text yet (content is saved every 10 deltas), so the
   * list hides it, and past 3 min of silence the streaming registry hides the
   * turn until the next sweep. Waiting on those two was a race against a 45 s
   * margin that a loaded Mac loses (the loop stalled 7-87 s on 14/09). Here
   * both stay blind for 1.5 s while the turn is alive: the reply still comes.
   */
  test("a live turn invisible to the list and to the registry is still waited on, by its row", async () => {
    const t0 = Date.now();
    const fetchImpl = world({
      streaming: () => [],
      messages: () => [
        { id: "u1", role: "user", content: "ping" },
        Date.now() - t0 < 1_500
          ? { id: "m1", role: "assistant", content: "", partial: true }
          : { id: "m1", role: "assistant", content: "the whole answer" },
      ],
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, { pollMs: 5, maxWaitMs: 5_000 });
    expect(out).toBe("the whole answer");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
  }, 10_000);

  test("a row that is gone says the turn ended without a reply, at once", async () => {
    const fetchImpl = world({ streaming: () => LIVE, messages: () => [{ id: "u1", role: "user", content: "ping" }] });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/stream interrupted.*ended without leaving a reply/i);
  });

  test("a cut turn that then closed with an error verdict is not handed back as the reply", async () => {
    const fetchImpl = world({
      streaming: () => [],
      messages: () => [{ id: "m1", role: "assistant", content: "half", blocks: [{ kind: "error", text: "Risposta interrotta" }] }],
    });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/ended badly: Risposta interrotta.*"half"/);
  });

  test("a stream cut before it named the row fails at once instead of guessing", async () => {
    const fetchImpl = world({ chat: delta("half "), streaming: () => LIVE, messages: () => [] });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/stream interrupted before the turn named its reply/);
  });

  test("a turn stopped by a person says so, with what it had written", async () => {
    const chat = frame({ turn: { messageId: "m1" } }) + delta("half") + frame({ turn: { end: "cancelled", cause: "user" } }) + "data: [DONE]\n\n";
    const fetchImpl = world({ chat, streaming: () => [], messages: () => [] });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/the turn was stopped by a person before finishing its reply\. What it had written: "half"/);
  });

  test("a turn stopped by the machine or ended in an error says which", async () => {
    const stopped = frame({ turn: { messageId: "m1" } }) + frame({ turn: { end: "cancelled", cause: "watchdog" } }) + "data: [DONE]\n\n";
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, world({ chat: stopped, streaming: () => [], messages: () => [] }), FAST))
      .rejects.toThrow(/was stopped \(watchdog\).*It had written nothing/);
    const failed = frame({ turn: { messageId: "m1" } }) + delta("Non sono riuscito") + frame({ turn: { end: "error" } }) + "data: [DONE]\n\n";
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, world({ chat: failed, streaming: () => [], messages: () => [] }), FAST))
      .rejects.toThrow(/ended in an error/);
  });

  test("a finished turn with the row frame and no end frame is the reply, with no extra request", async () => {
    let extra = 0;
    const chat = frame({ turn: { messageId: "m1" } }) + delta("Hello") + "data: [DONE]\n\n";
    const fetchImpl = world({ chat, streaming: () => { extra++; return []; }, messages: () => { extra++; return []; } });
    expect(await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST)).toBe("Hello");
    expect(extra).toBe(0);
  });
});
