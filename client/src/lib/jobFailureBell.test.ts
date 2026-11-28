/**
 * The failure of a scheduled job (R24) is counted by the number the person sees:
 * the bell, the Dock and the tray all say `bellTotal` of the groups, and the
 * subjects behind it are `chromeAttentionSubjects`. A system row is not counted.
 *
 * @covers SCHED-07, ATTN-08
 */
import { describe, expect, test } from "bun:test";
import { chromeAttentionSubjects } from "../state/attentionTotal";
import { inboxModel } from "./inboxModel";
import { NO_HUB, bellGroups, bellTotal } from "./bellGroups";
import type { AttentionSnapshot } from "../../../shared/attention";

const snap = (subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  subject, state: "idle", reason: null, outcome: null, detail: null, since: "2026-11-26T10:00:00.000Z",
  epoch: 1, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
});
const failed = (id: string) => snap(`job:${id}`, { state: "finished", outcome: "error", lit: true, detail: "Sync has failed 3 times in a row" });
const rowsOf = (...rows: AttentionSnapshot[]) => new Map(rows.map((r) => [r.subject, r]));

describe("a job failure on the number the person sees", () => {
  test("the lit job subject is one of the chrome subjects and one row of the bell, in the failures group", () => {
    const rows = rowsOf(failed("j1"));
    expect(chromeAttentionSubjects(rows, {}, []).map((s) => s.key)).toEqual(["job:j1"]);
    const groups = bellGroups(inboxModel(rows, {}, [], []), NO_HUB);
    expect(bellTotal(groups)).toBe(1);
    expect(groups.map((g) => g.key)).toEqual(["broken"]);
    expect(groups[0].entries[0]).toMatchObject({ source: "topics", item: { title: "Sync has failed 3 times in a row", url: null } });
  });

  test("a system row, or a job seen already, does not count", () => {
    const rows = rowsOf(snap("system:notice", { state: "finished", outcome: "error", lit: true }), { ...failed("j2"), lit: false, seenEpoch: 1 });
    expect(chromeAttentionSubjects(rows, {}, [])).toEqual([]);
    expect(bellTotal(bellGroups(inboxModel(rows, {}, [], []), NO_HUB))).toBe(0);
  });
});
