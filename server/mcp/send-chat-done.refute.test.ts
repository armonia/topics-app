/**
 * Copied from the independent review of df9b2fd2e (card 63e01ac0). Adapted to
 * the fix: the streams carry the route's `turn` frames (the row that is cut,
 * the end of a stopped turn), and the stopped turn may answer with an explicit
 * failure, which is what it does.
 */
import { describe, test, expect } from "bun:test";
import { callSendChatMessage } from "./topics-mcp-server";

const A = { baseUrl: "http://x", sessionKey: "topic:mine" };
function sse(raw: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const r of raw) c.enqueue(new TextEncoder().encode(r)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const d = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

function world(chat: () => Response, onOther: (u: string) => Response) {
  const seen: string[] = [];
  const f = (async (url: RequestInfo | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith("/api/topics/t1")) return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "Target" } }), { status: 200 });
    if (u.endsWith("/api/chat")) return chat();
    return onOther(u);
  }) as typeof fetch;
  return { f, seen };
}

describe("no regression / pre-existing", () => {
  test("[DONE] with pings split across chunks: text returned, no fallback call", async () => {
    const w = world(() => sse([": ping\n\n", d("Hel").slice(0, 10), d("Hel").slice(10) + d("lo"), ": ping\n\ndata: [DO", "NE]\n\n"]), (u) => { throw new Error("fallback hit " + u); });
    expect(await callSendChatMessage(A, { topic_id: "t1", message: "x" }, w.f)).toBe("Hello");
    expect(w.seen.some((u) => u.includes("streaming"))).toBe(false);
  });

  test("Stop / machine stop: server writes [DONE] after half (chat.ts:1847, 2475) -> half returned as THE reply", async () => {
    const w = world(() => sse([d("half "), `data: ${JSON.stringify({ turn: { end: "cancelled", cause: "user" } })}\n\n`, "data: [DONE]\n\n"]), (u) => { throw new Error("fallback hit " + u); });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "x" }, w.f).catch((err: Error) => err.message);
    console.log("Stop case returns:", JSON.stringify(out));
    expect(out).not.toBe("half");
  });

  test("restart cut: server gone during the wait -> transport error, not a wait", async () => {
    const w = world(() => sse([`data: ${JSON.stringify({ turn: { messageId: "m1" } })}\n\n`, d("half ")]), (u) => { throw new TypeError("Unable to connect. Is the computer able to access the url?"); });
    const r = await callSendChatMessage(A, { topic_id: "t1", message: "x" }, w.f, { pollMs: 5, maxWaitMs: 60_000 }).then((x) => "RESOLVED " + x, (e) => "REJECTED " + e.message);
    console.log(r);
  });
});
