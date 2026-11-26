/**
 * When a card title says "I am one of a series".
 *
 * Agents open work in numbered batches: "Scheduled jobs 3/8: ship the report ...",
 * "Two repos T5: generic hub ...". Left alone, every batch fills the board with
 * N sibling cards and no card that says what the batch is. The board groups them
 * under one milestone card, and the first step is recognising the title: this
 * module. Pure on purpose: text in, verdict out, no database and no clock, so
 * the rule is the same for every caller and testable with real titles.
 *
 * Two schemas are recognised, and the schema is part of the series identity:
 *
 *   "<prefix> N/M"   a fraction, N <= M, M >= 2 ("Scheduled jobs 3/8: ...")
 *   "<prefix> T<n>"  a tag, capital T and a number ("Two repos T5: ...")
 *
 * The prefix is the text BEFORE the counter, with trailing spaces and colons
 * removed. It is deterministic: the same title always gives the same prefix, and
 * the milestone card is named with exactly that text.
 *
 * What is deliberately NOT a series: a date ("Meeting 12/11": N > M), a lone
 * number ("Fix 24/7": N > M), a title with no prefix ("3/8: ship it"), and a
 * prefix with no letters. A false positive here is cheap (a series needs a
 * sibling before anything is grouped) but a missed series is the whole defect,
 * so the shapes accepted are the two the agents really write.
 */

export type SeriesSchema = "fraction" | "tag";

export interface TaskSeries {
  /** The text before the counter, trailing spaces and colons removed: the name of the milestone card. */
  prefix: string;
  schema: SeriesSchema;
  /** The counter as written ("3/8", "T5"): two members of one series differ here. */
  counter: string;
  /** Prefix and schema in a comparable form: two titles are in the same series when this is equal. */
  key: string;
}

/** What may follow a counter: the end, a space or punctuation, never a letter or digit ("3/8x", "T5b"). */
const AFTER = String.raw`(?=$|[\s:.,;!?)\]\u2014\u2013-])`;
/** The prefix is lazy so the FIRST valid counter wins; it must end on a non-space character. */
const FRACTION = new RegExp(String.raw`^(.*?\S)\s+(\d{1,3})/(\d{1,3})${AFTER}`, "u");
const TAG = new RegExp(String.raw`^(.*?\S)\s+T(\d{1,3})${AFTER}`, "u");

/** A prefix as a comparable string: case, accents and runs of spaces do not tell two milestones apart. */
export function normalizeSeriesPrefix(prefix: string): string {
  return prefix
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The prefix as the milestone card is named: trailing spaces and colons removed, nothing else touched. */
function cleanPrefix(raw: string): string {
  return raw.replace(/[\s:]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Long enough to name something, and made of words: "-" or "12" is not a series name. */
function nameable(prefix: string): boolean {
  return prefix.length >= 3 && /\p{L}/u.test(prefix);
}

/** The series a title belongs to, or `null` when it is not numbered like one. */
export function parseTaskSeries(title: string | null | undefined): TaskSeries | null {
  const text = (title ?? "").trim();
  if (!text) return null;
  const fraction = FRACTION.exec(text);
  if (fraction) {
    const n = Number(fraction[2]);
    const m = Number(fraction[3]);
    const prefix = cleanPrefix(fraction[1]!);
    if (n >= 1 && m >= 2 && n <= m && nameable(prefix)) return make(prefix, "fraction", `${n}/${m}`);
  }
  const tag = TAG.exec(text);
  if (tag) {
    const prefix = cleanPrefix(tag[1]!);
    if (nameable(prefix)) return make(prefix, "tag", `T${Number(tag[2])}`);
  }
  return null;
}

function make(prefix: string, schema: SeriesSchema, counter: string): TaskSeries {
  return { prefix, schema, counter, key: `${schema}:${normalizeSeriesPrefix(prefix)}` };
}

/** Same series, different member: the pair a duplicate gate must never merge ("3/8" and "4/8" are two jobs). */
export function areSiblingsInSeries(a: string, b: string): boolean {
  const x = parseTaskSeries(a);
  const y = parseTaskSeries(b);
  return !!x && !!y && x.key === y.key && x.counter !== y.counter;
}

/** Is this title the name of the series itself (the milestone card): the same prefix, no counter. */
export function isSeriesName(title: string, series: TaskSeries): boolean {
  return parseTaskSeries(title) === null && normalizeSeriesPrefix(title) === normalizeSeriesPrefix(series.prefix);
}
