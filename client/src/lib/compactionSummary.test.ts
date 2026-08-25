/**
 * `splitCompactionSummary` is the interface-level guard that keeps the CLI's
 * ~24 KB auto-compaction recap from dumping into the visible chat: it slices a
 * message body into the real prose (`before`) and the foldable summary
 * (`summary`). Pin the split points and the no-op cases.
  * @covers CHAT-COMPACT-02
 */
import { describe, test, expect } from "bun:test";
import { splitCompactionSummary, COMPACTION_PREAMBLE } from "./compactionSummary";

describe("splitCompactionSummary", () => {
  test("whole message is the summary → before empty, summary is the text", () => {
    const text = `${COMPACTION_PREAMBLE}. The summary below covers…\n\nSummary: 1. Primary Request…`;
    const { before, summary } = splitCompactionSummary(text);
    expect(before).toBe("");
    expect(summary).toBe(text);
  });

  test("real prose THEN the summary → before is the prose, summary is the recap", () => {
    const prose = "Ora esaminiamo il modello dati Employee.";
    const text = `${prose}\n\n${COMPACTION_PREAMBLE}. Summary: …`;
    const { before, summary } = splitCompactionSummary(text);
    expect(before).toBe(prose);
    expect(summary).toBe(`${COMPACTION_PREAMBLE}. Summary: …`);
  });

  test("no preamble → text passes through untouched, summary null", () => {
    const text = "Un messaggio normale, nessuna compaction.";
    const { before, summary } = splitCompactionSummary(text);
    expect(before).toBe(text);
    expect(summary).toBeNull();
  });

  test("empty text → no summary", () => {
    expect(splitCompactionSummary("")).toEqual({ before: "", summary: null });
  });
});
