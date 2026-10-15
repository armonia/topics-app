/**
 * @covers KANBAN-96
 */
import { describe, expect, test } from "bun:test";
import { lastMessageLines, selectTaskSessionPeek } from "./task-session-peek";

describe("lastMessageLines", () => {
  test("keeps at most the last three non-empty lines", () => {
    expect(lastMessageLines("prima\n\nseconda\nterza\nquarta")).toEqual(["seconda", "terza", "quarta"]);
  });

  test("limits each line and returns nothing for blank content", () => {
    expect(lastMessageLines("x".repeat(300))).toEqual(["x".repeat(240)]);
    expect(lastMessageLines(" \n ")).toEqual([]);
  });

  test("selects the live card fields and omits cards without a session", () => {
    expect(selectTaskSessionPeek({ assignedTopicId: "topic-1", dispatchState: "working", inProgressAt: "2026-10-15T09:00:00Z", agentTokens: 12, agentCostCents: 3 }, [
      { content: "primo messaggio", timestamp: "2026-10-15T08:00:00Z" },
      { content: "ultima\nriga", timestamp: null },
    ], "Bash")).toEqual({
      state: "working", since: "2026-10-15T09:00:00Z", lines: ["ultima", "riga"], tool: "Bash", tokens: 12, costCents: 3,
    });
    expect(selectTaskSessionPeek({ assignedTopicId: null, dispatchState: "working" }, [])).toBeNull();
  });

  test("prefers the growing active turn over the latest stored message", () => {
    const task = { assignedTopicId: "topic-1", dispatchState: "working", inProgressAt: "old-start" };
    const messages = [{ content: "messaggio già salvato", timestamp: "old-time" }];
    const stream = { content: "riga uno", startedAt: "turn-start" };

    expect(selectTaskSessionPeek(task, messages, null, stream)).toMatchObject({
      since: "turn-start", lines: ["riga uno"],
    });
    stream.content += "\nriga due";
    expect(selectTaskSessionPeek(task, messages, null, stream)?.lines).toEqual(["riga uno", "riga due"]);
  });
});
