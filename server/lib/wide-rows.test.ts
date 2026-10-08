/**
 * `allWideRows` returns what `.all()` returns: same keys, same order, same
 * values, on a projection wider than bun:sqlite's fast object path, with the
 * names the caller wrote and whatever order `columnNames` lists them in.
 * @covers FEEDCOST-01
 */
import { describe, expect, it } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import { allWideRows } from "./wide-rows";

const COLUMNS = 80;
const WIDE_SQL = `SELECT *, substr(c2, 1, 5) AS preview FROM t WHERE id >= ? ORDER BY id DESC`;
/** The result columns of WIDE_SQL in SELECT order, as its writer knows them. */
const WIDE_NAMES = ["id", ...Array.from({ length: COLUMNS }, (_, i) => `c${i}`), "preview"];

function wideDb(): Database {
  const db = new Database(":memory:");
  const cols = Array.from({ length: COLUMNS }, (_, i) => {
    const type = ["INTEGER", "REAL", "TEXT", "BLOB", "TEXT"][i % 5];
    return `c${i} ${type}`;
  });
  db.run(`CREATE TABLE t (id TEXT PRIMARY KEY, ${cols.join(", ")})`);
  const insert = db.query(`INSERT INTO t VALUES (?, ${Array.from({ length: COLUMNS }, () => "?").join(", ")})`);
  for (let r = 0; r < 40; r++) {
    const values = Array.from({ length: COLUMNS }, (_, i) => {
      if ((r + i) % 7 === 0) return null;
      switch (i % 5) {
        case 0: return r * 1_000_003 + i - 20;
        case 1: return r / 3 + i;
        case 2: return `riga ${r} colonna ${i} è 😀`;
        case 3: return new Uint8Array([r, i, 255]);
        default: return "";
      }
    });
    insert.run(`id-${String(r).padStart(2, "0")}`, ...values);
  }
  return db;
}

describe("allWideRows", () => {
  it("returns the rows of .all(), keys in the same order, on every SQLite type", () => {
    const db = wideDb();
    const statement = db.query(WIDE_SQL);
    expect(statement.columnNames.length).toBeGreaterThan(62);
    const fast = allWideRows(statement, WIDE_NAMES, "id-05");
    const slow = statement.all("id-05") as Array<Record<string, unknown>>;
    expect(fast.length).toBe(35);
    expect(fast).toEqual(slow);
    for (let i = 0; i < fast.length; i++) expect(Object.keys(fast[i]!)).toEqual(Object.keys(slow[i]!));
  });

  it("does not take the order from columnNames, which Bun 1.3.8 lists backwards past 62", () => {
    const db = wideDb();
    const real = db.query(WIDE_SQL);
    // What Bun 1.3.8 hands out: the same names, reversed; `.values()` and `.all()` in SELECT order.
    const reversed = {
      columnNames: [...real.columnNames].reverse(),
      values: (...p: unknown[]) => real.values(...(p as [string])),
      all: (...p: unknown[]) => real.all(...(p as [string])),
    } as unknown as Statement;
    const fast = allWideRows(reversed, WIDE_NAMES, "id-05");
    const slow = real.all("id-05") as Array<Record<string, unknown>>;
    expect(fast).toEqual(slow);
    for (let i = 0; i < fast.length; i++) expect(Object.keys(fast[i]!)).toEqual(Object.keys(slow[i]!));
  });

  it("falls back to .all() without names, or with names that are not the statement's columns", () => {
    const db = wideDb();
    const statement = db.query(WIDE_SQL);
    const slow = statement.all("id-05") as Array<Record<string, unknown>>;
    for (const names of [null, WIDE_NAMES.slice(1), [...WIDE_NAMES.slice(0, -1), "preview_x"]]) {
      const rows = allWideRows(statement, names, "id-05");
      expect(rows).toEqual(slow);
      for (let i = 0; i < rows.length; i++) expect(Object.keys(rows[i]!)).toEqual(Object.keys(slow[i]!));
    }
  });

  it("answers an empty result with an empty list", () => {
    const db = wideDb();
    expect(allWideRows(db.query("SELECT * FROM t WHERE id = ?"), ["id", ...WIDE_NAMES.slice(1, -1)], "none")).toEqual([]);
  });

  it("falls back to .all() for a column list that is not plain identifiers", () => {
    const db = wideDb();
    for (const [sql, names] of [
      [`SELECT c0, c0 FROM t ORDER BY id`, ["c0", "c0"]],
      [`SELECT c0 AS "a name", c2 AS "it's" FROM t ORDER BY id`, ["a name", "it's"]],
      [`SELECT c0 AS "__proto__", c2 FROM t ORDER BY id`, ["__proto__", "c2"]],
    ] as const) {
      const statement = db.query(sql);
      const fast = allWideRows(statement, names);
      expect(fast).toEqual(statement.all() as Array<Record<string, unknown>>);
      expect(Object.getPrototypeOf(fast[0])).toBe(Object.prototype);
    }
  });
});
