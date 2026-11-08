import type { SQLQueryBindings, Statement } from "bun:sqlite";

/**
 * THE ROWS OF A WIDE SELECT, AS OBJECTS, AT THE PRICE OF ARRAYS.
 *
 * `bun:sqlite` builds the objects of `.all()` about four times slower once a
 * SELECT has more than 62 columns. Measured on Bun 1.4.2 (2026-10-08), 150 rows
 * of short text: 62 columns 1.09 ms, 63 columns 3.61 ms, and flat after that.
 * The board feed projects 75 (`listColumns` in `services/tasks.ts`, which asks
 * the table for its columns on purpose), so on 150 cards the objects cost
 * 3.55 ms where `.values()` costs 0.82 ms for the same values.
 *
 * So the values travel as arrays and each row becomes ONE object literal,
 * written once per column list: same keys, same order, same values as `.all()`
 * returns (checked by the test against `.all()` on every SQLite type). The
 * literal is also a fixed shape, which is what the mapper reading 70 fields off
 * every row wants. 1.12 ms on the same 150 rows; a loop that assigns the keys
 * one by one costs 1.52 ms.
 *
 * THE NAMES COME FROM WHOEVER WROTE THE SELECT, NOT FROM `columnNames`. On Bun
 * 1.3.8 (the production server, 2026-10-08) `statement.columnNames` lists a
 * SELECT of more than 62 columns BACKWARDS (`c74, c73, ..., c0`) while
 * `.values()` keeps the SELECT order: rows built from it put the description in
 * `id`. Later Bun lists them in order. The count is right on both, the order
 * is not, so `columnNames` is only asked how many columns there are and which
 * ones, never in what order. A caller that does not know its names in SELECT
 * order (a `*` projection) passes `null` and gets `.all()`.
 *
 * The literal is generated code, and only from names that are plain
 * identifiers: a column list that is not (a duplicate, `__proto__`, anything
 * with a quote or a space) falls back to `.all()`, which is slower and right.
 * So does a list that is not the statement's columns (another count, another
 * name): a stale list would otherwise label values with the wrong keys.
 */
type Row = Record<string, unknown>;
type Build = (values: unknown[]) => Row;

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One builder per column list. `null` = this list is read with `.all()`. */
const builders = new Map<string, Build | null>();

function builderFor(names: readonly string[]): Build | null {
  const key = names.join("\u0000");
  const hit = builders.get(key);
  if (hit !== undefined) return hit;
  let build: Build | null = null;
  const plain = names.length > 0
    && new Set(names).size === names.length
    && names.every((n) => PLAIN_NAME.test(n) && n !== "__proto__");
  if (plain) {
    // The body is built only from names that passed PLAIN_NAME, never from row data.
    build = new Function("v", `return {${names.map((n, i) => `${n}: v[${i}]`).join(", ")}};`) as Build;
  }
  builders.set(key, build);
  return build;
}

/** The builder this statement may use with these names, checked once per pair. */
const checked = new WeakMap<Statement, { names: readonly string[]; build: Build | null }>();

function builderForStatement(statement: Statement, names: readonly string[]): Build | null {
  const hit = checked.get(statement);
  if (hit && hit.names === names) return hit.build;
  const columns = statement.columnNames;
  // Same columns as a set, in any order: the order of `columnNames` is the very thing not to trust.
  const sorted = [...names].sort();
  const same = columns.length === names.length && [...columns].sort().every((c, i) => c === sorted[i]);
  const build = same ? builderFor(names) : null;
  checked.set(statement, { names, build });
  return build;
}

/**
 * `statement.all(...params)`, same rows, without the per-column cost of a wide
 * row. `names` are the statement's result columns in SELECT order, as the
 * caller wrote them; `null` when it does not know them (then it is `.all()`).
 */
export function allWideRows(statement: Statement, names: readonly string[] | null, ...params: SQLQueryBindings[]): Row[] {
  const build = names ? builderForStatement(statement, names) : null;
  if (!build) return statement.all(...params) as Row[];
  return (statement.values(...params) as unknown[][]).map(build);
}
