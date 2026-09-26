/**
 * Which lines of a broker store are a row's own turn (card 98ce88d1, second
 * review of PR #145), on the store shapes the review recorded.
 *
 * @covers RESUME-02
 */
import { describe, expect, test } from "bun:test";
import { foldRowTurns, rowTurn, wakeMark, type RowTurns } from "./row-turn";

const mark = (row: string) => ({ type: "topics_delivered", mark: row });
const init = { type: "system", subtype: "init" };
const text = (t: string, agent = false) => ({ type: "assistant", parent_tool_use_id: agent ? "toolu_agent" : null, message: { content: [{ type: "text", text: t }] } });
const result = (r: string, turns = 2) => ({ type: "result", subtype: "success", is_error: false, num_turns: turns, result: r });
const notification = { type: "system", subtype: "task_notification", task_id: "b1" };

/** The store's lines folded in order; returns the fold and where each line ends. */
function scan(lines: unknown[]): { turns: RowTurns | undefined; ends: number[] } {
  let turns: RowTurns | undefined;
  let offset = 0;
  const ends: number[] = [];
  for (const line of lines) {
    offset += JSON.stringify(line).length + 1;
    ends.push(offset);
    turns = foldRowTurns(turns, line, offset);
  }
  return { turns, ends };
}

describe("a row's own turn in the broker store", () => {
  test("the turn ends, then its background command wakes the CLI: the woken turn is nobody's row", () => {
    const { turns, ends } = scan([mark("R"), init, text("T1-FIRST"), result("T1-FINAL", 3), notification, init, text("W2"), result("W2", 1)]);
    expect(rowTurn(turns, "R")).toEqual({ from: ends[0], end: ends[3] });
  });

  test("a background Agent keeps printing after the result: the turn still ends on it", () => {
    const { turns, ends } = scan([mark("R"), init, text("Launched."), result("Launched."), text("agent working", true), { type: "system", subtype: "task_started" }]);
    expect(rowTurn(turns, "R")).toEqual({ from: ends[0], end: ends[3] });
  });

  test("a leftover notification's own empty turn before the answer is skipped, as live (24/09, topic 33966f4e)", () => {
    const { turns, ends } = scan([mark("R"), notification, init, result("", 0), init, text("the answer"), result("the answer")]);
    expect(rowTurn(turns, "R")?.end).toBe(ends[6]);
  });

  test("a /compact is a turn of its own, closed by its empty result even after a notification", () => {
    const compact = { type: "system", subtype: "compact_boundary" };
    const { turns, ends } = scan([mark("C"), notification, init, compact, result("", 0), mark("R"), init, text("AC-FINAL"), result("AC-FINAL report.")]);
    expect(rowTurn(turns, "C")).toEqual({ from: ends[0], end: ends[4] });
    expect(rowTurn(turns, "R")).toEqual({ from: ends[5], end: ends[8] });
  });

  test("no mark for the row, no turn: a daemon older than protocol 3, a wake, a turn still running", () => {
    expect(rowTurn(scan([init, text("old"), result("old")]).turns, "R")).toBeUndefined();
    expect(rowTurn(scan([mark("OTHER"), init, result("x")]).turns, "R")).toBeUndefined();
    expect(rowTurn(scan([mark("R"), init, text("half")]).turns, "R")?.end).toBeUndefined();
    expect(rowTurn(scan([mark("R")]).turns, undefined)).toBeUndefined();
  });

  // A wake has no stdin write: its adopter marks it after it began, with the offset where it did.
  describe("a wake's row", () => {
    const wake = (row: string, at: number) => ({ type: "topics_delivered", mark: wakeMark(row, at) });

    test("marked while it runs: from its first line to its own result, and the next wake is not its", () => {
      const head = scan([mark("R"), init, text("T1"), result("T1"), notification, init]);
      const at = head.ends.at(-1)!;
      const { turns, ends } = scan([mark("R"), init, text("T1"), result("T1"), notification, init, text("W1-FIRST"), wake("W1", at), result("W1-FINAL"), notification, init, text("W2"), result("W2")]);
      expect(rowTurn(turns, "W1")).toEqual({ from: at, end: ends[8] });
    });

    test("a short wake is over before its row exists: the mark finds the result already folded", () => {
      const head = scan([result("old"), notification, init]);
      const at = head.ends.at(-1)!;
      const { turns, ends } = scan([result("old"), notification, init, text("W1"), result("W1"), wake("W1", at)]);
      expect(rowTurn(turns, "W1")).toEqual({ from: at, end: ends[4] });
    });

    test("a wake's mark opens nothing for a person's row, and a mark that is not an offset is a person's", () => {
      const { turns, ends } = scan([mark("R"), init, text("R"), wake("W1", 0), result("R")]);
      expect(rowTurn(turns, "R")).toEqual({ from: ends[0], end: ends[4] });
      expect(rowTurn(scan([{ type: "topics_delivered", mark: "odd@row@x" }, result("x")]).turns, "odd@row@x")?.end).toBeGreaterThan(0);
    });
  });
});
