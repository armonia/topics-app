/**
 * The `table` and `timeline` contracts (GENUI-06, GENUI-07), on the real trip
 * of topic:64095902.
 *
 * @covers GENUI-06, GENUI-07
 */
import { describe, expect, test } from "bun:test";
import { normalizeViewSpec, parseViewSpec, viewSummary } from "./views";
import { rankColumns, type TableViewSpec } from "./views-table";
import { groupStepsByDay, type TimelineViewSpec } from "./views-timeline";
import { doorToDoorTimeline, trainsTable } from "../tests/e2e/fixtures/trip-views";

const errorsOf = (input: unknown): string[] => {
  const r = normalizeViewSpec(input);
  return r.ok ? [] : r.errors;
};

describe("table", () => {
  test("the trains normalize, round-trip, and the fastest and cheapest are marked", () => {
    const r = normalizeViewSpec(trainsTable());
    expect(r.ok).toBe(true);
    const spec = (r as { spec: TableViewSpec }).spec;
    expect(parseViewSpec(spec)).toEqual(spec);
    expect(viewSummary(spec)).toEqual({ kind: "table", count: 3, unit: "rows" });
    const ranks = rankColumns(spec);
    // Durata: 180 best (via Zaragoza), 230 worst (bus). Prezzo: 12,70 best, 22,30 worst; the AVE has none.
    expect(ranks.map((r) => r[3])).toEqual([undefined, "best", "worst"]);
    expect(ranks.map((r) => r[4])).toEqual([undefined, "worst", "best"]);
    // An all-number column aligns to the end by itself; text columns do not.
    expect(spec.columns.map((c) => c.align)).toEqual([undefined, undefined, undefined, "end", "end"]);
  });

  test("short rows are padded, long rows are refused, bare forms are accepted", () => {
    const r = normalizeViewSpec({ view: "table", title: "T", columns: ["A", "B"], rows: [["x"]] });
    expect(r.ok && r.spec.view === "table" ? r.spec.rows[0].cells : null).toEqual(["x", null]);
    expect(errorsOf({ view: "table", title: "T", columns: ["A"], rows: [["x", "y"]] })).toEqual(["rows[0] has 2 cells for 1 columns"]);
    expect(errorsOf({ view: "table", title: "T", columns: [], rows: [] })).toEqual([
      "'columns' must have 1-8 items (got 0)",
      "'rows' must have 1-40 items (got 0)",
    ]);
  });

  test("equal values rank nobody, and a link that is not https is dropped", () => {
    const spec = { columns: [{ label: "n", better: "lower" as const }], rows: [{ cells: [3] }, { cells: [3] }] };
    expect(rankColumns(spec)).toEqual([[undefined], [undefined]]);
    const r = normalizeViewSpec({ view: "table", title: "T", columns: ["A"], rows: [{ cells: ["x"], link: "javascript:alert(1)" }] });
    expect(r.ok && r.spec.view === "table" ? r.spec.rows[0].link : "x").toBeUndefined();
  });
});

describe("timeline", () => {
  test("the door-to-door plan normalizes and groups by day", () => {
    const r = normalizeViewSpec(doorToDoorTimeline());
    expect(r.ok).toBe(true);
    const spec = (r as { spec: TimelineViewSpec }).spec;
    expect(parseViewSpec(spec)).toEqual(spec);
    const groups = groupStepsByDay(spec.steps);
    expect(groups.map((g) => [g.day, g.steps.length])).toEqual([["Lunedì 19", 2], ["Mercoledì 21", 4]]);
    expect(spec.steps[1].alternatives).toEqual([{ title: "Taxi dal T1 alla porta", mode: "taxi", detail: "47-53 €" }]);
    expect(spec.steps[4].deadline).toBe(true);
  });

  test("times are HH:MM, written for the agent when they are not", () => {
    const r = normalizeViewSpec({ view: "timeline", title: "T", steps: [{ title: "a", time: "8.05" }] });
    expect(r.ok && r.spec.view === "timeline" ? r.spec.steps[0].time : null).toBe("08:05");
    expect(errorsOf({ view: "timeline", title: "T", steps: [{ title: "a", time: "dopo pranzo" }] })).toEqual([
      "steps[0].time must be HH:MM (got 'dopo pranzo')",
    ]);
    expect(errorsOf({ view: "timeline", title: "T", steps: [] })).toEqual(["'steps' must have 1-24 items (got 0)"]);
  });

  test("an unknown mode is dropped instead of failing the view", () => {
    const r = normalizeViewSpec({ view: "timeline", title: "T", steps: [{ title: "a", mode: "teleport" }] });
    expect(r.ok && r.spec.view === "timeline" ? r.spec.steps[0].mode : "x").toBeUndefined();
  });
});
