/**
 * Which closed turn a reattach may replay into its row (card 98ce88d1, review
 * of PR #145), on the real incident's numbers: a bench replays a recorded store
 * in seconds, so its `duration_ms` cannot date anything there.
 *
 * @covers RESUME-02
 */
import { describe, expect, test } from "bun:test";
import { answersTheRow, foldResult, sealScan } from "./closed-turn";

// topic:7e9caa28 on 25/09: the person's message at 14:45:21.694Z, the turn's
// result, the store's last line, written at 15:27:58Z, `duration_ms` 2544641.
const ANSWERED_AT = Date.parse("2026-09-25T14:45:21.694Z");
const WRITTEN_AT = Date.parse("2026-09-25T15:27:58.000Z");
const INCIDENT = { result: "PR #142 aggiornata a `0ea0f9130`…", duration_ms: 2544641 };

describe("the store's last turn and the row being reattached", () => {
  test("the incident: the turn began 11.7 s after the person's message, so it is the row's", () => {
    const turn = sealScan(foldResult(undefined, 2751652, INCIDENT), { endOffset: 2751652, lastDataAt: WRITTEN_AT });
    expect(turn?.from).toBe(0);
    expect(answersTheRow(turn, ANSWERED_AT)).toBe(true);
  });

  test("a turn that began before the message is the previous row's (a SIGTERM before the new turn's init)", () => {
    const turn = sealScan(foldResult(undefined, 900, { result: "OLD-B", duration_ms: 90 }), { endOffset: 900, lastDataAt: ANSWERED_AT - 5_000 });
    expect(answersTheRow(turn, ANSWERED_AT)).toBe(false);
  });

  test("not known is no: lines after the result, no clock, no message time, an empty last result", () => {
    const turn = foldResult(undefined, 900, INCIDENT);
    expect(answersTheRow(sealScan(turn, { endOffset: 1200, lastDataAt: WRITTEN_AT }), ANSWERED_AT)).toBe(false);
    expect(answersTheRow(sealScan(turn, { endOffset: 900 }), ANSWERED_AT)).toBe(false);
    expect(answersTheRow(sealScan(turn, { endOffset: 900, lastDataAt: WRITTEN_AT }), Number.NaN)).toBe(false);
    const compacted = sealScan(foldResult(turn, 1500, { result: "", duration_ms: 120 }), { endOffset: 1500, lastDataAt: WRITTEN_AT });
    expect(answersTheRow(compacted, ANSWERED_AT)).toBe(false);
  });

  test("the turn after a /compact begins at the compaction's empty result", () => {
    let turn = foldResult(undefined, 100, { result: "OLD-B", duration_ms: 90 });
    turn = foldResult(turn, 250, { result: "", duration_ms: 120 });
    turn = foldResult(turn, 700, { result: "AC-FINAL report.", duration_ms: 1_000 });
    expect(turn.from).toBe(250);
  });
});
