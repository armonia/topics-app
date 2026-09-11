/**
 * A GRANT ROW WRITTEN BY A SCALE THAT NO LONGER EXISTS.
 *
 * `run` and `manage` sat above `edit` for one day on this branch, and the
 * CHECK that allowed them was applied by anybody who ran that branch. Those
 * rows can therefore still be in a database, and "the level is gone from the
 * type" is not an answer to what happens when one is read back: a parser that
 * accepted the string would hand a guest exactly the two capabilities that
 * were removed for being dangerous.
 *
 * The declared behaviour is DEMOTION to `read` - the least power on the scale,
 * not `edit`, which would keep the write half of a level nobody may hold. This
 * file is what makes that a fact instead of a comment.
 *
 * @covers GUEST-09
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceP, grantRowsFor, levelFor, meetsLevel, subjectsOf, grantedResourceIds, isAssignableGrantLevel } from "./grants-query";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATION = "20260909180634-grant-levels-write-scope.sql";

/**
 * The table AS THE WIDE SCALE LEFT IT. Built from the real migration with the
 * CHECK widened back to what it briefly said, so the fixture cannot drift into
 * a shape the schema never had: everything else - columns, indexes, the copy -
 * is the file itself.
 */
function dbWithWideCheck(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY)");
  db.run(`CREATE TABLE grants (
    id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, level TEXT NOT NULL,
    granted_at INTEGER NOT NULL, granted_by_person_id TEXT, via_type TEXT, via_id TEXT,
    UNIQUE (subject_type, subject_id, resource_type, resource_id))`);
  const sql = readFileSync(join(ROOT, "server/db/migrations", MIGRATION), "utf8");
  const wide = sql.replace(
    "CHECK (level IN ('read', 'comment', 'edit', 'deny'))",
    "CHECK (level IN ('read', 'comment', 'edit', 'run', 'manage', 'deny'))",
  );
  expect(wide, "the migration must still carry the narrow CHECK to widen").not.toBe(sql);
  db.run(wide);
  return db;
}

function writeLegacy(db: Database, level: string, resourceId: string): void {
  db.run(
    "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES (?,?,?,?,?,?,?)",
    [`row-${level}-${resourceId}`, "device", "g1", "task", resourceId, level, Date.now()],
  );
}

describe("un livello che la scala non conosce piu'", () => {
  test("`run` e `manage` si leggono come `read`, non come cio' che dicono", () => {
    const db = dbWithWideCheck();
    writeLegacy(db, "run", "t-run");
    writeLegacy(db, "manage", "t-manage");

    for (const id of ["t-run", "t-manage"]) {
      expect(levelFor(db, deviceP("g1"), "task", id)).toBe("read");
      expect(grantRowsFor(db, deviceP("g1"), "task", id)[0]?.level).toBe("read");
      // The sharing panel reads through this one, so the owner is shown the
      // level that is actually in force, not the word in the column.
      expect(subjectsOf(db, "task", id)[0]?.level).toBe("read");
    }
  });

  test("declassato vuol dire che non copre nulla oltre la lettura", () => {
    const db = dbWithWideCheck();
    writeLegacy(db, "manage", "t1");
    const level = levelFor(db, deviceP("g1"), "task", "t1")!;
    expect(meetsLevel(level, "read")).toBe(true);
    expect(meetsLevel(level, "comment")).toBe(false);
    expect(meetsLevel(level, "edit")).toBe(false);
  });

  test("declassato, non revocato: la risorsa resta visibile", () => {
    // The safe direction is LESS power, not a resource that silently vanishes
    // from a guest's inventory - that would read as "the owner unshared it".
    const db = dbWithWideCheck();
    writeLegacy(db, "run", "t1");
    expect(grantedResourceIds(db, deviceP("g1"), "task")).toEqual(["t1"]);
  });

  test("e non si puo' riassegnare: la parola non e' piu' un livello", () => {
    for (const level of ["run", "manage"]) expect(isAssignableGrantLevel(level)).toBe(false);
    for (const level of ["read", "comment", "edit"]) expect(isAssignableGrantLevel(level)).toBe(true);
  });
});
