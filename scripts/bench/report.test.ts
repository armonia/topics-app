/**
 * The rules the published table has to obey, as tests.
 *
 * A benchmark rots in ways a screenshot never shows: a number loses the machine
 * it was taken on, an absent measurement starts printing as `0`, a stale row
 * keeps being republished because nobody looks at the date. Each of those is a
 * function in report.ts, and each of them is here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MACHINE_NOT_RECORDED,
  README_BEGIN,
  README_END,
  ageDays,
  judge,
  renderMarkdown,
  renderTable,
  renderValue,
  spliceReadme,
  type BenchReport,
  type BenchRow,
} from "./report";
import { collect, perCard } from "./run";

function row(over: Partial<BenchRow> = {}): BenchRow {
  return {
    axis: "the Nth topic",
    value: 0.3,
    unit: "MB",
    kind: "measured",
    source: "memory",
    machine: "Mac14,6, 12 cores, 32 GB",
    date: "2026-08-15",
    ...over,
  };
}

function report(rows: BenchRow[], sources: BenchReport["sources"] = []): BenchReport {
  return {
    collected_at: "2026-08-15T10:00:00.000Z",
    host: "test host",
    sections: [{ title: "SECTION", rows }],
    sources,
  };
}

describe("renderValue: a gap never prints as a number", () => {
  test("null is words, not a zero", () => {
    expect(renderValue(row({ value: null, kind: "not-measured", reason: "no artefact" }))).toBe("not measured");
  });

  test("a measured zero is a zero, because it was measured", () => {
    expect(renderValue(row({ value: 0, unit: "count" }))).toBe("0 count");
  });

  test("NaN and Infinity are gaps, not numbers", () => {
    expect(renderValue(row({ value: Number.NaN }))).toBe("not measured");
    expect(renderValue(row({ value: Number.POSITIVE_INFINITY }))).toBe("not measured");
  });

  test("two decimals at most, and no trailing zeros", () => {
    expect(renderValue(row({ value: 1.10499, unit: "x" }))).toBe("1.1 x");
    expect(renderValue(row({ value: 416, unit: "us" }))).toBe("416 us");
  });
});

describe("ageDays", () => {
  test("counts whole days", () => {
    expect(ageDays("2026-08-01", "2026-08-15")).toBe(14);
    expect(ageDays("2026-08-15", "2026-08-15")).toBe(0);
  });

  test("a day it cannot read is null, never 0", () => {
    expect(ageDays("yesterday", "2026-08-15")).toBeNull();
    expect(ageDays("2026-08-15", "")).toBeNull();
  });
});

describe("judge: the three exits", () => {
  const today = "2026-08-15";

  test("0 when every number carries its machine and its day", () => {
    const verdict = judge(report([row()]), { today });
    expect(verdict.code).toBe(0);
    expect(verdict.problems).toEqual([]);
    expect(verdict.numbered).toBe(1);
  });

  test("2 when not one source produced a number", () => {
    const verdict = judge(report([row({ value: null, kind: "not-measured", reason: "never run here" })]), { today });
    expect(verdict.code).toBe(2);
    expect(verdict.missing).toBe(1);
  });

  test("1 when a number lost the machine it came from", () => {
    const verdict = judge(report([row({ machine: "  " })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("no machine");
  });

  test("1 when a number lost its day", () => {
    const verdict = judge(report([row({ date: "" })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("no day");
  });

  test("1 when a day is not a day", () => {
    const verdict = judge(report([row({ date: "14 agosto" })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("not a YYYY-MM-DD");
  });

  test("'not recorded' is counted, not fatal: four older baselines really are in that state", () => {
    const verdict = judge(report([row({ machine: MACHINE_NOT_RECORDED })]), { today });
    expect(verdict.code).toBe(0);
    expect(verdict.unattributed).toBe(1);
  });

  test("1 when a row is staler than the caller asked for, and the fix is in the message", () => {
    const verdict = judge(
      report([row({ date: "2026-07-01" })], [{ tag: "memory", file: "f.json", kind: "report", rerun: "bun run x", present: true }]),
      { today, maxAgeDays: 7 },
    );
    expect(verdict.code).toBe(1);
    expect(verdict.problems[0]).toContain("45 day(s) ago");
    expect(verdict.problems[0]).toContain("bun run x");
  });

  test("a fresh row survives the same age check", () => {
    expect(judge(report([row({ date: "2026-08-14" })]), { today, maxAgeDays: 7 }).code).toBe(0);
  });

  test("1 when an artefact exists but could not be parsed", () => {
    const verdict = judge(
      report([row()], [{ tag: "latency", file: "b.json", kind: "report", rerun: "r", present: true, error: "Unexpected token" }]),
      { today },
    );
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("could not be read");
  });

  test("an absent source is a gap by default and a failure under --require-all", () => {
    const src = [{ tag: "latency", file: "b.json", kind: "report" as const, rerun: "r", present: false }];
    expect(judge(report([row()], src), { today }).code).toBe(0);
    expect(judge(report([row()], src), { today, requireAll: true }).code).toBe(1);
  });

  test("1 when a gap has no reason: a gap without a reason reads as an excuse", () => {
    const verdict = judge(report([row(), row({ value: null, kind: "not-measured", reason: "" })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("no reason");
  });

  test("1 when a row has no number and does not admit it", () => {
    const verdict = judge(report([row(), row({ value: null })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("has to say it is a gap");
  });

  test("1 when a row is marked as a gap and carries a number anyway", () => {
    const verdict = judge(report([row({ kind: "not-measured", reason: "r" })]), { today });
    expect(verdict.code).toBe(1);
    expect(verdict.problems.join(" ")).toContain("One of the two is wrong");
  });
});

describe("the printed table", () => {
  const built = report(
    [
      row(),
      row({ axis: "the 320 ms curtain", value: 320, unit: "ms", kind: "constant", note: "a decision, not a stopwatch" }),
      row({ axis: "Linux", value: null, kind: "not-measured", reason: "this box is macOS" }),
    ],
    [{ tag: "memory", file: "bench/results/memory-latest.json", kind: "report", rerun: "bun run scripts/bench/memory.ts", present: true }],
  );

  test("carries the machine, the day and the source tag on the row itself", () => {
    const table = renderTable(built);
    expect(table).toContain("Mac14,6, 12 cores, 32 GB");
    expect(table).toContain("2026-08-15");
    expect(table).toContain("[memory]");
  });

  test("marks a constant as a constant, so nobody optimises a decision", () => {
    expect(renderTable(built)).toContain("the 320 ms curtain (const)");
  });

  test("prints the reason under a gap and never a bare blank", () => {
    const table = renderTable(built);
    expect(table).toContain("not measured");
    expect(table).toContain("this box is macOS");
  });

  test("names the re-run command of every source", () => {
    expect(renderTable(built)).toContain("bun run scripts/bench/memory.ts");
  });

  test("markdown does not let a path or a pipe eat the row", () => {
    const md = renderMarkdown(
      report([row({ axis: "Pss | RSS", value: null, kind: "not-measured", reason: "reads /proc/<pid>/smaps_rollup" })]),
    );
    expect(md).toContain("Pss \\| RSS");
    expect(md).toContain("/proc/&lt;pid&gt;/smaps_rollup");
    expect(md).not.toContain("<pid>");
  });

  test("markdown carries the same facts", () => {
    const md = renderMarkdown(built);
    expect(md).toContain("| what | value | machine | measured | source |");
    expect(md).toContain("**not measured**");
    expect(md).toContain("`0.3 MB`");
  });
});

describe("spliceReadme", () => {
  const readme = `# Bench\n\nprose above\n\n${README_BEGIN}\nold table\n${README_END}\n\nprose below\n`;

  test("replaces the block and leaves the prose alone", () => {
    const next = spliceReadme(readme, "new table");
    expect(next).toContain("prose above");
    expect(next).toContain("prose below");
    expect(next).toContain("new table");
    expect(next).not.toContain("old table");
  });

  test("refuses when the markers are missing or crossed", () => {
    expect(spliceReadme("# Bench\nno markers\n", "t")).toBeNull();
    expect(spliceReadme(`${README_END}\n${README_BEGIN}\n`, "t")).toBeNull();
  });
});

describe("perCard: the marginal card", () => {
  test("is the slope between the 50-card and the 500-card paint", () => {
    const lat = { gestures: { board_paint_50: { medianMs: 435.5 }, board_paint_500: { medianMs: 487.1 } } };
    expect(perCard(lat)).toBe(0.11);
  });

  test("is null, not 0, when either paint is missing", () => {
    expect(perCard({ gestures: { board_paint_50: { medianMs: 435.5 } } })).toBeNull();
    expect(perCard(null)).toBeNull();
  });
});

describe("collect: reading real artefacts off a checkout", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "topics-bench-collect-"));
  }

  test("an empty checkout yields a table of declared gaps and exit 2, never a green nothing", () => {
    const built = collect(scratch());
    const verdict = judge({ collected_at: "2026-08-15T00:00:00.000Z", host: "h", ...built }, { today: "2026-08-15" });
    expect(verdict.code).toBe(2);
    expect(verdict.numbered).toBe(0);
    expect(renderTable({ collected_at: "2026-08-15T00:00:00.000Z", host: "h", ...built })).toContain("has not run on this machine");
  });

  test("a malformed artefact is named, not skipped", () => {
    const root = scratch();
    mkdirSync(join(root, "bench/results"), { recursive: true });
    writeFileSync(join(root, "bench/results/memory-latest.json"), "{ this is not json");
    const built = collect(root);
    const memory = built.sources.find((s) => s.tag === "memory");
    expect(memory?.present).toBe(true);
    expect(memory?.error).toBeTruthy();
  });

  test("a real memory artefact lands on the rows that carry its machine and its day", () => {
    const root = scratch();
    mkdirSync(join(root, "bench/results"), { recursive: true });
    writeFileSync(
      join(root, "bench/results/memory-latest.json"),
      JSON.stringify({
        measured_at: "2026-08-15T15:00:36.564Z",
        machine: "Mac14,6, 12 cores, 32 GB",
        marginal: { shell_idle_mb: 208.6, per_topic_mb: 0.3, per_agent_topics_mb: 219.2 },
        scenarios: [{ label: "Topics idle", mb: 208.6, processCount: 8 }],
      }),
    );
    const rows = collect(root).sections.flatMap((s) => s.rows);
    const shell = rows.find((r) => r.axis === "the shell, before any topic");
    expect(shell?.value).toBe(208.6);
    expect(shell?.machine).toBe("Mac14,6, 12 cores, 32 GB");
    expect(shell?.date).toBe("2026-08-15");
    expect(rows.find((r) => r.axis === "Topics idle")?.note).toContain("8 processes");
  });

  test("the axes nobody measured are declared even when every artefact is present", () => {
    const rows = collect(scratch()).sections.flatMap((s) => s.rows);
    const linux = rows.find((r) => r.axis.includes("Linux"));
    expect(linux?.kind).toBe("not-measured");
    expect(linux?.reason).toContain("Pss");
    expect(rows.find((r) => r.axis.includes("board feed"))?.reason).toContain("never writes a number out");
  });
});
