#!/usr/bin/env bun
/**
 * THE BENCH TABLE.
 *
 * This file is PURE: no fs, no process, no clock, no network. Everything it
 * prints arrives as data. That is not tidiness for its own sake: the rules a
 * published benchmark has to obey are exactly the things that quietly stop
 * being true (a number loses the machine it was taken on, a missing measurement
 * starts printing as `0`, two harnesses start sharing a column with different
 * units). Written here, each of those rules is a function a test can call
 * without spawning a server.
 *
 * THE RULES, and they are the difference between a benchmark and an advert:
 *
 *  1. A number nobody has measured prints as "not measured", with the reason
 *     next to it. Never a blank, never a zero. `renderValue` has exactly one
 *     way to produce a numeral and it needs a finite number to do it.
 *  2. Every number carries its machine and its day. `judge` exits non-zero when
 *     a row lost either. The string "not recorded" is allowed, because four of
 *     this repo's older baselines genuinely never wrote one down, but it is
 *     counted and named in the footer instead of passing as a machine.
 *  3. Units are named per row and never mixed inside a comparison. A section
 *     header may name the metric (phys_footprint, PSS) once for the rows under
 *     it; the row still carries its own unit.
 *  4. A value that is a CONSTANT by construction is marked `constant`, not
 *     `measured`. The 320 ms curtain on the first open of a chat is the case
 *     this exists for: it is a decision, and reading it as a stopwatch invites
 *     someone to "optimise" it.
 *  5. A value this suite computed from two other rows is `derived`, so nobody
 *     goes looking for the harness that measured it.
 */

/** measured: a harness read it. derived: computed here from measured rows.
 *  constant: a decision in the source, not a stopwatch. not-measured: absent,
 *  and `reason` says why. */
export type RowKind = "measured" | "derived" | "constant" | "not-measured";

export interface BenchRow {
  /** What is being measured, in the words a reader would use. */
  axis: string;
  /** null means "not measured". A number here is always finite: see rule 1. */
  value: number | null;
  /** Named per row: "MB", "ms", "us/chunk", "bytes", "x". */
  unit: string;
  kind: RowKind;
  /** Tag of the source in `sources`, so the reader can re-run this row. */
  source: string;
  /** The box the number came from, or the literal "not recorded". */
  machine: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Why it is worth what it says, or what it is not. One line. */
  note?: string;
  /** Required when kind is "not-measured": why nobody has this number. */
  reason?: string;
}

export interface BenchSection {
  title: string;
  /** Named once for the whole section when every row shares it. */
  metric?: string;
  /** One line under the title: what the section is claiming. */
  blurb?: string;
  rows: BenchRow[];
}

export interface SourceRef {
  tag: string;
  /** Repo-relative path of the artefact this suite read. */
  file: string;
  /** The command that writes that artefact. */
  rerun: string;
  /** "report" (numbers published) or "gate" (a baseline a check compares against). */
  kind: "report" | "gate";
  present: boolean;
  /** Set when the file exists but could not be trusted. */
  error?: string;
}

export interface BenchReport {
  /** ISO instant the collection ran. */
  collected_at: string;
  /** The box that ran the collection, which is NOT the box each row came from. */
  host: string;
  sections: BenchSection[];
  sources: SourceRef[];
}

export const MACHINE_NOT_RECORDED = "not recorded";

/** Rule 1 lives here: the only path to a numeral needs a finite number. */
export function renderValue(row: BenchRow): string {
  if (row.value === null || !Number.isFinite(row.value)) return "not measured";
  const n = row.value;
  const shown = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  return row.unit ? `${shown} ${row.unit}` : shown;
}

/** The marker a `kind` puts in front of a row. Empty for a plain measurement. */
export function kindMark(kind: RowKind): string {
  if (kind === "constant") return "const";
  if (kind === "derived") return "derived";
  if (kind === "not-measured") return "";
  return "";
}

export function allRows(report: BenchReport): BenchRow[] {
  return report.sections.flatMap((s) => s.rows);
}

/** Days between two YYYY-MM-DD days. Returns null when either is unusable, so a
 *  malformed date becomes a problem instead of a silent 0. */
export function ageDays(date: string, today: string): number | null {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export interface JudgeOptions {
  /** YYYY-MM-DD. */
  today: string;
  /** When set, a measured row older than this many days makes the run exit 1. */
  maxAgeDays?: number;
  /** When true, a declared source that is absent makes the run exit 1. */
  requireAll?: boolean;
}

export interface Verdict {
  /** 0 report produced · 1 the report cannot be trusted · 2 nothing measurable. */
  code: 0 | 1 | 2;
  problems: string[];
  /** Rows that carry a number: the reason exit 2 exists. */
  numbered: number;
  missing: number;
  /** Rows whose machine was never written down. Named, not fatal. */
  unattributed: number;
}

/**
 * THE THREE EXITS.
 *   0  the report was produced
 *   1  it cannot be trusted: an artefact is malformed, a number lost its
 *      machine or its day, a row is older than the age the caller asked for,
 *      or a declared source is missing under --require-all
 *   2  nothing measurable: not one source produced a number. A table of nine
 *      "not measured" rows is not a benchmark, and printing it green would say
 *      the opposite of what happened.
 */
export function judge(report: BenchReport, opts: JudgeOptions): Verdict {
  const problems: string[] = [];
  const rows = allRows(report);
  const numbered = rows.filter((r) => r.value !== null && Number.isFinite(r.value));
  const missing = rows.filter((r) => r.value === null || !Number.isFinite(r.value));
  let unattributed = 0;

  for (const src of report.sources) {
    if (src.error) problems.push(`${src.tag}: ${src.file} could not be read: ${src.error}`);
    if (opts.requireAll && !src.present && !src.error) {
      problems.push(`${src.tag}: ${src.file} is absent, and --require-all was asked for. Re-run it with: ${src.rerun}`);
    }
  }

  for (const row of numbered) {
    if (row.kind === "not-measured") {
      problems.push(`${row.axis}: carries a number but is marked "not-measured". One of the two is wrong.`);
    }
    if (!row.machine.trim()) {
      problems.push(`${row.axis}: a number with no machine. Rule 2: every number says where it was taken.`);
    } else if (row.machine === MACHINE_NOT_RECORDED) {
      unattributed += 1;
    }
    if (!row.date.trim()) {
      problems.push(`${row.axis}: a number with no day. Rule 2: every number says when it was taken.`);
      continue;
    }
    const age = ageDays(row.date, opts.today);
    if (age === null) {
      problems.push(`${row.axis}: "${row.date}" is not a YYYY-MM-DD day.`);
      continue;
    }
    if (opts.maxAgeDays !== undefined && age > opts.maxAgeDays) {
      problems.push(
        `${row.axis}: measured ${age} day(s) ago (${row.date}), older than the ${opts.maxAgeDays} day(s) asked for. Re-run: ${rerunFor(report, row.source)}`,
      );
    }
  }

  for (const row of missing) {
    if (row.kind !== "not-measured") {
      problems.push(`${row.axis}: no number, but it is not marked "not-measured". A gap has to say it is a gap.`);
    } else if (!row.reason?.trim()) {
      problems.push(`${row.axis}: "not measured" with no reason. A gap without a reason reads as an excuse.`);
    }
  }

  if (numbered.length === 0) {
    return { code: 2, problems, numbered: 0, missing: missing.length, unattributed };
  }
  return {
    code: problems.length > 0 ? 1 : 0,
    problems,
    numbered: numbered.length,
    missing: missing.length,
    unattributed,
  };
}

function rerunFor(report: BenchReport, tag: string): string {
  return report.sources.find((s) => s.tag === tag)?.rerun ?? "see bench/README.md";
}

/** Pads, and when a cell overflows its column it still keeps one space after
 *  it: two columns that touch read as one wrong value. */
function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}

const AXIS_W = 46;
const VALUE_W = 16;
const MACHINE_W = 38;

/** The terminal table. Fixed columns so two runs diff by eye. */
export function renderTable(report: BenchReport): string {
  const out: string[] = [];
  out.push(`TOPICS BENCH, collected ${report.collected_at.slice(0, 19).replace("T", " ")}Z on ${report.host}`);
  out.push(
    "  Nothing here is re-measured. This command COLLECTS what each harness wrote,",
    "  and every row carries the machine and the day its number came from.",
  );

  for (const section of report.sections) {
    out.push("");
    out.push(section.metric ? `${section.title}   [unit: ${section.metric}]` : section.title);
    if (section.blurb) out.push(`  ${section.blurb}`);
    for (const row of section.rows) {
      const mark = kindMark(row.kind);
      const axis = mark ? `${row.axis} (${mark})` : row.axis;
      out.push(
        `  ${pad(axis, AXIS_W)}${pad(renderValue(row), VALUE_W)}${pad(row.machine, MACHINE_W)}${pad(row.date || "-", 12)}[${row.source}]`,
      );
      const tail = row.value === null ? row.reason : row.note;
      if (tail) out.push(`      ${tail}`);
    }
  }

  out.push("");
  out.push("SOURCES  (every row above is a read of one of these files)");
  for (const src of report.sources) {
    const state = src.error ? `UNREADABLE: ${src.error}` : src.present ? "present" : "ABSENT, its rows print as not measured";
    out.push(`  [${src.tag}] ${src.file}  (${src.kind}, ${state})`);
    out.push(`      ${src.rerun}`);
  }
  return out.join("\n");
}

/**
 * Prose going into a markdown cell. Two of these bite in practice: a path like
 * /proc/<pid>/smaps_rollup is swallowed as an HTML tag by every renderer, and a
 * single pipe splits the row into two columns.
 */
export function escapeCell(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
}

/** The README table. Same rows, same rules, one file that a human reads. */
export function renderMarkdown(report: BenchReport): string {
  const out: string[] = [];
  out.push(`_Collected ${report.collected_at.slice(0, 10)} by \`bun run bench\`, which reads the artefacts below and re-measures nothing._`);
  for (const section of report.sections) {
    out.push("");
    out.push(`### ${section.title}${section.metric ? ` (${section.metric})` : ""}`);
    if (section.blurb) out.push("", section.blurb);
    out.push("");
    out.push("| what | value | machine | measured | source |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const row of section.rows) {
      const mark = kindMark(row.kind);
      const axis = mark ? `${escapeCell(row.axis)} _(${mark})_` : escapeCell(row.axis);
      const value = row.value === null ? "**not measured**" : `\`${renderValue(row)}\``;
      const note = row.value === null ? row.reason : row.note;
      out.push(
        `| ${axis}${note ? `<br>${escapeCell(note)}` : ""} | ${value} | ${escapeCell(row.machine)} | ${row.date || "-"} | \`${row.source}\` |`,
      );
    }
  }
  out.push("");
  out.push("### Where these come from");
  out.push("");
  out.push("| source | file | kind | re-run |");
  out.push("| --- | --- | --- | --- |");
  for (const src of report.sources) {
    out.push(`| \`${src.tag}\` | \`${src.file}\` | ${src.kind} | \`${src.rerun}\` |`);
  }
  return out.join("\n");
}

export const README_BEGIN = "<!-- BENCH:TABLE -->";
export const README_END = "<!-- /BENCH:TABLE -->";

/**
 * Replace the generated block inside the README and leave every hand-written
 * line alone. Returns null when the markers are missing or crossed, so the
 * runner refuses to write rather than appending a second table nobody notices.
 */
export function spliceReadme(readme: string, block: string): string | null {
  const start = readme.indexOf(README_BEGIN);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < 0 || end < start) return null;
  return `${readme.slice(0, start + README_BEGIN.length)}\n\n${block}\n\n${readme.slice(end)}`;
}
