/**
 * What the agent is told when the project pause holds its message: the tool
 * answers (it does not fail, it does not wait for a stream that will not come),
 * and says not to send it again. @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { callSendChatMessage, callSendToAgent } from "./topics-mcp-server";

const A = { baseUrl: "http://x", sessionKey: "topic:mine" };
const stub = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => impl as typeof fetch;
const heldBody = { held: true, code: "project_paused" };

describe("send_chat_message into a paused project", () => {
  test("a 202 held answer is reported as held, not as a cut stream", async () => {
    const posted: string[] = [];
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "hi" }, stub(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/topics/t1")) return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "Target" } }), { status: 200 });
      if (u.endsWith("/api/chat")) { posted.push(String(init?.body)); return new Response(JSON.stringify(heldBody), { status: 202 }); }
      throw new Error(`unexpected ${u}`);
    }));
    expect(posted).toHaveLength(1);
    expect(out).toContain("is paused");
    expect(out).toContain("do not send it again");
  });
});

describe("send_to_agent into a paused project", () => {
  test("a held answer says so and promises delivery on resume", async () => {
    const out = await callSendToAgent(A, { agent_id: "child-1", input: "go on" }, stub(async () => new Response(JSON.stringify({ ok: true, held: true, sent: 0 }), { status: 202 })));
    expect(out).toContain("held for child-1");
    expect(out).toContain("do not send it again");
  });
});
