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
 * The literal is generated code, and only from names that are plain
 * identifiers: a column list that is not (a duplicate, `__proto__`, anything
 * with a quote or a space) falls back to `.all()`, which is slower and right.
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

/** `statement.all(...params)`, same rows, without the per-column cost of a wide row. */
export function allWideRows(statement: Statement, ...params: SQLQueryBindings[]): Row[] {
  const build = builderFor(statement.columnNames);
  if (!build) return statement.all(...params) as Row[];
  return (statement.values(...params) as unknown[][]).map(build);
}
