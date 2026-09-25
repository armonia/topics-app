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
import { describe, test, expect, setSystemTime } from "bun:test";
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
   * margin that a loaded Mac loses (the loop stalled 7-87 s on 14/09). Here the
   * registry stays blind while the clock jumps 10 min at every look: any rule
   * that calls a turn gone after some time fails, and the list is never read.
   */
  test("a live turn invisible to the list and to the registry is still waited on, by its row, however long", async () => {
    let clock = Date.now();
    let looks = 0;
    let listReads = 0;
    const inner = world({
      streaming: () => {
        looks++;
        clock += 10 * 60_000;
        setSystemTime(new Date(clock));
        return [];
      },
      messages: () => [
        { id: "u1", role: "user", content: "ping" },
        looks < 5
          ? { id: "m1", role: "assistant", content: "", partial: true }
          : { id: "m1", role: "assistant", content: "the whole answer" },
      ],
    });
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/messages?")) listReads++;
      return inner(url, init);
    }) as typeof fetch;
    try {
      const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, { pollMs: 5, maxWaitMs: 2 * 60 * 60_000 });
      expect(out).toBe("the whole answer");
      expect(looks).toBe(5);
      expect(listReads).toBe(0);
    } finally {
      setSystemTime();
    }
  });

  test("a stream that names two turns is waited on for the first, its own", async () => {
    const chat = frame({ turn: { messageId: "m1" } }) + delta("half ") + frame({ turn: { messageId: "m2" } });
    const fetchImpl = world({
      chat,
      streaming: () => [],
      messages: () => [
        { id: "m1", role: "assistant", content: "our answer" },
        { id: "m2", role: "assistant", content: "someone else's answer" },
      ],
    });
    expect(await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST)).toBe("our answer");
  });

  test("a server that reloads during the wait is waited through, and one that stays down is said to be", async () => {
    let reads = 0;
    const reloading = world({ streaming: () => [], messages: () => [{ id: "m1", role: "assistant", content: "the whole answer" }] });
    const flaky = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/messages/") && ++reads <= 3) throw new TypeError("Unable to connect. Is the computer able to access the url?");
      return reloading(url, init);
    }) as typeof fetch;
    expect(await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, flaky, { ...FAST, maxWaitMs: 5_000, unreachableMs: 2_000 })).toBe("the whole answer");

    const down = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/messages/")) throw new TypeError("Unable to connect. Is the computer able to access the url?");
      return reloading(url, init);
    }) as typeof fetch;
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, down, { ...FAST, maxWaitMs: 5_000, unreachableMs: 100 }))
      .rejects.toThrow(/stream interrupted, and topics-app stayed unreachable/);
  });

  test("a real error with nothing written names its cause, and does not say the answer may still come", async () => {
    for (const cause of ["rate-limit", "process-died", "provider-error"]) {
      const chat = frame({ turn: { messageId: "m1" } }) + frame({ turn: { end: "error", cause } }) + "data: [DONE]\n\n";
      const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, world({ chat, streaming: () => [], messages: () => [] }), FAST)
        .then((reply) => `RESOLVED ${reply}`, (err: Error) => err.message);
      expect(out).toContain(`ended in an error (${cause}) before finishing its reply. It had written nothing.`);
      expect(out).not.toContain("can still land");
      // A saturated API is resent by the resume sweep: resending by hand runs it twice.
      expect(out).toContain("Before sending it again, check read_chat_messages");
      expect(out).toContain("Topics resends some interrupted turns by itself");
    }
  });

  test("a turn that closed with nothing written says so, and warns against sending again", async () => {
    const chat = frame({ turn: { messageId: "m1" } }) + frame({ turn: { end: "error" } }) + "data: [DONE]\n\n";
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, world({ chat, streaming: () => [], messages: () => [] }), FAST))
      .rejects.toThrow(/closed without writing a reply\. Before sending again, check read_chat_messages/);
  });

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

  test("a turn stopped by a person says so, with what it had written, and nothing about resending", async () => {
    const chat = frame({ turn: { messageId: "m1" } }) + delta("half") + frame({ turn: { end: "cancelled", cause: "user" } }) + "data: [DONE]\n\n";
    const fetchImpl = world({ chat, streaming: () => [], messages: () => [] });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST).catch((err: Error) => err.message);
    expect(out).toMatch(/the turn was stopped by a person before finishing its reply\. What it had written: "half"/);
    expect(out).not.toContain("Topics resends");
  });

  test("a cut turn whose row closed with nothing in it ended without a reply", async () => {
    const fetchImpl = world({ streaming: () => [], messages: () => [{ id: "m1", role: "assistant", content: "" }] });
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl, FAST))
      .rejects.toThrow(/stream interrupted, and the turn ended without leaving a reply\. Before sending it again/);
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

/**
 * ONE SEND IS ONE POST, EVEN WHEN THE SERVER CUTS THE STREAM.
 *
 * Bun 1.3.8's fetch sends a POST again, on its own, when the server closes a
 * reused keep-alive socket halfway through the response, and glues the second
 * response onto the same body (review of 4b1e2a1d1). send_chat_message reads
 * the topic first and then POSTs on the same socket: behind a cut, the message
 * reached the chat twice, and with the turn hidden from the busy gate a second
 * turn ran it again.
 */
describe("callSendChatMessage against a server that cuts the stream", () => {
  test("the chat is POSTed once, and the wait follows the first turn it named", async () => {
    let posts = 0;
    let rowReads = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 8,
      fetch: async (req) => {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/topics/t1") return Response.json({ topic: { sessionKey: "topic:target", name: "Target" } });
        if (pathname === "/api/chat") {
          await req.json();
          posts++;
          const turn = `m${posts}`;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ turn: { messageId: turn } })}\n\n`));
              // Then silence: the idle timeout cuts the response.
            },
          });
          return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (pathname === "/api/topics/streaming") return Response.json({ sessions: [] });
        const row = pathname.match(/^\/api\/topics\/t1\/messages\/([^/]+)$/);
        if (row) {
          rowReads++;
          return Response.json({ message: { id: row[1], role: "assistant", content: `answer of ${row[1]}` } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const out = await callSendChatMessage(
        { baseUrl: `http://127.0.0.1:${server.port}`, sessionKey: "topic:mine" },
        { topic_id: "t1", message: "ping" },
        fetch,
        { pollMs: 50, maxWaitMs: 30_000 },
      );
      expect(posts).toBe(1);
      expect(out).toBe("answer of m1");
      expect(rowReads).toBeGreaterThanOrEqual(1);
    } finally {
      server.stop(true);
    }
  }, 40_000);
});
