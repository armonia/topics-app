import { describe, expect, test } from "bun:test";
import { buildAttentionDigest, type SessionStateRow } from "./session-digest";

const row = (p: Partial<SessionStateRow> & { topicId: string; name: string }): SessionStateRow =>
  ({ state: "idle", unread: 0, ...p });

describe("buildAttentionDigest", () => {
  test("empty input → no attention, empty summary", () => {
    const d = buildAttentionDigest([]);
    expect(d.count).toBe(0);
    expect(d.items).toEqual([]);
    expect(d.summary).toBe("");
  });

  test("flags state=update as unread reply", () => {
    const d = buildAttentionDigest([row({ topicId: "t1", name: "Auth", state: "update", unread: 1 })]);
    expect(d.count).toBe(1);
    expect(d.items[0]).toEqual({ topicId: "t1", name: "Auth", reason: "nuova risposta non letta" });
    expect(d.summary).toBe("1 sessione richiede attenzione: Auth (nuova risposta non letta).");
  });

  test("flags unread>0 even when state isn't update", () => {
    const d = buildAttentionDigest([row({ topicId: "t1", name: "Billing", state: "idle", unread: 3 })]);
    expect(d.count).toBe(1);
    expect(d.items[0].reason).toBe("3 non letti");
  });

  test("ignores streaming, waiting, idle, empty with no unread", () => {
    const d = buildAttentionDigest([
      row({ topicId: "a", name: "A", state: "streaming" }),
      row({ topicId: "b", name: "B", state: "waiting" }),
      row({ topicId: "c", name: "C", state: "idle" }),
      row({ topicId: "d", name: "D", state: "empty" }),
    ]);
    expect(d.count).toBe(0);
  });

  test("multi-session summary lists up to 3 names then +N", () => {
    const d = buildAttentionDigest([
      row({ topicId: "1", name: "Uno", state: "update", unread: 1 }),
      row({ topicId: "2", name: "Due", state: "update", unread: 1 }),
      row({ topicId: "3", name: "Tre", state: "update", unread: 1 }),
      row({ topicId: "4", name: "Quattro", state: "update", unread: 1 }),
      row({ topicId: "5", name: "Cinque", state: "update", unread: 1 }),
    ]);
    expect(d.count).toBe(5);
    expect(d.summary).toBe("5 sessioni richiedono attenzione: Uno, Due, Tre +2.");
  });
});
