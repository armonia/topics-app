/**
 * `allWideRows` returns what `.all()` returns: same keys, same order, same
 * values, on a projection wider than bun:sqlite's fast object path.
 * @covers FEEDCOST-01
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { allWideRows } from "./wide-rows";

const COLUMNS = 80;

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
    const statement = db.query(`SELECT *, substr(c2, 1, 5) AS preview FROM t WHERE id >= ? ORDER BY id DESC`);
    expect(statement.columnNames.length).toBeGreaterThan(62);
    const fast = allWideRows(statement, "id-05");
    const slow = statement.all("id-05") as Array<Record<string, unknown>>;
    expect(fast.length).toBe(35);
    expect(fast).toEqual(slow);
    for (let i = 0; i < fast.length; i++) expect(Object.keys(fast[i]!)).toEqual(Object.keys(slow[i]!));
  });

  it("answers an empty result with an empty list", () => {
    const db = wideDb();
    expect(allWideRows(db.query("SELECT * FROM t WHERE id = ?"), "none")).toEqual([]);
  });

  it("falls back to .all() for a column list that is not plain identifiers", () => {
    const db = wideDb();
    for (const sql of [
      `SELECT c0, c0 FROM t ORDER BY id`,
      `SELECT c0 AS "a name", c2 AS "it's" FROM t ORDER BY id`,
      `SELECT c0 AS "__proto__", c2 FROM t ORDER BY id`,
    ]) {
      const statement = db.query(sql);
      const fast = allWideRows(statement);
      expect(fast).toEqual(statement.all() as Array<Record<string, unknown>>);
      expect(Object.getPrototypeOf(fast[0])).toBe(Object.prototype);
    }
  });
});
