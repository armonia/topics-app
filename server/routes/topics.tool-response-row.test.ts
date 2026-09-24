/**
 * THE ANSWER IS WRITTEN ON THE QUESTION'S ROW (card 1046df0b).
 *
 * A question asked by a turn the watchdog had already closed sits on that
 * turn's own row, above the resume sweep's notice. `/api/chat/tool-response`
 * patched the session's LAST row, i.e. the notice, which has no such tool: the
 * write found nothing, and the question's row kept `waiting_for_input` with no
 * answer on it. The route runs for real; only the DB rows and the writer are
 * fake, and the writer records which row it was aimed at.
 *
 * @covers ASK-10
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { createTopicsRouter } from "./topics";
import { cancelAsk } from "../lib/ask-user-bridge";

describe("POST /api/chat/tool-response: the answer goes where the question is", () => {
  test("a question under a newer notice gets its answer on its own row, not on the notice", async () => {
    const sk = "topic:answer-row";
    // Newest first, as the route reads them: the sweep's notice, then the
    // closed turn that asked.
    const rows = [
      { id: "notice-row", tool_calls: null, blocks: JSON.stringify([{ kind: "error", text: "Ripresa automatica sospesa" }]) },
      {
        id: "turn-row",
        tool_calls: null,
        blocks: JSON.stringify([{ kind: "tool", toolCall: { id: "toolu_ask", name: "mcp__topics__ask_user_question", status: "waiting_for_input" } }]),
      },
    ];
    const writes: Array<{ toolCallId: string; opts?: { rowId?: string } }> = [];
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const ctx = {
      OPENCLAW_DIR: tmpdir(),
      db: {
        prepare: () => ({ get: () => undefined, all: () => rows }),
        query: () => ({ get: () => null, all: () => [] }),
      },
      json,
      errorResponse: (status: number, error: string) => json({ error }, status),
      readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
      matchRoute: () => null,
      broadcastToAll: () => {},
      getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}`, sessionKey: key, autonomyLevel: "auto-apply" }),
      saveSingleTopic: () => {},
      updateToolCallFields: (_sk: string, toolCallId: string, _fields: unknown, opts?: { rowId?: string }) => {
        writes.push({ toolCallId, opts });
      },
    } as any;
    const router = createTopicsRouter(ctx);
    try {
      const url = new URL("http://topics.test/api/chat/tool-response");
      const resp = await router(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: sk, toolCallId: "toolu_ask", response: { kind: "questions", answers: { "Quale ramo?": "sito" } } }),
      }), url, url.pathname, "POST") as Response;
      expect(resp.status).toBe(200);
      expect(writes).toEqual([{ toolCallId: "toolu_ask", opts: { rowId: "turn-row" } }]);
    } finally {
      cancelAsk(sk);
    }
  });
});
