/**
 * «#50»: the number of each prompt the person typed, stamped by `/api/history`
 * on the WHOLE thread. The chat opens on a tail page, so a number counted by
 * the client on what it holds would say «3» on the fiftieth prompt; and a goal
 * continuation or a board envelope is a `user` row nobody typed, so it must not
 * move the count.
 * @covers CHAT-04
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { StoredMessage } from "../../server/types";

const TEST_DATA = testTmpDir("history-prompt-number-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

describe("/api/history stamps promptNumber on the whole thread", () => {
  test("a tail page carries the thread-wide number, machine rows do not count", async () => {
    const { createHistoryRouter } = await import("../../server/routes/history");
    const ctx = await createTestAppContext();
    const sessionKey = "topic:prompt-number";
    const msgs: StoredMessage[] = [];
    let parentId: string | null = null;
    const push = (id: string, role: "user" | "assistant", content: string, blocks?: StoredMessage["blocks"]) => {
      msgs.push({ id, role, content, timestamp: new Date(Date.now() + msgs.length * 1000).toISOString(), parentId, ...(blocks ? { blocks } : {}) });
      parentId = id;
    };
    for (let i = 1; i <= 50; i++) {
      push(`pn-u${i}`, "user", `domanda ${i}`);
      push(`pn-a${i}`, "assistant", `risposta ${i}`);
      if (i === 10) {
        push("pn-nudge", "user", "Objective still open: x", [{ kind: "goal-nudge", attempt: 1 }]);
        push("pn-a-nudge", "assistant", "continuo");
      }
    }
    ctx.saveLocalMessages(sessionKey, msgs);

    const router = createHistoryRouter(ctx, {
      matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
      providerForSessionKey: () => { throw new Error("local only"); },
    });
    const path = `/api/history/${encodeURIComponent(sessionKey)}`;
    const url = new URL(`http://h${path}`);
    const resp = (await router(
      new Request(url, { method: "POST", body: JSON.stringify({ limit: 6 }), headers: { "content-type": "application/json" } }),
      url, path, "POST",
    ))!;
    const { messages } = (await resp.json()) as { messages: Array<StoredMessage & { promptNumber?: number }> };

    const users = messages.filter((m) => m.role === "user");
    expect(users.map((m) => [m.id, m.promptNumber])).toEqual([
      ["pn-u48", 48], ["pn-u49", 49], ["pn-u50", 50],
    ]);
    expect(messages.filter((m) => m.role === "assistant").every((m) => m.promptNumber === undefined)).toBe(true);
  });
});
