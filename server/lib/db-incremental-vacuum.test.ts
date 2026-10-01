/**
 * The idle server gives free pages back to the disk, a few at a time.
 *
 * A synthetic database, never the live one: INCREMENTAL mode, rows deleted to
 * fill the freelist, and the round's decision checked on the pages it released
 * and the steps it ran.
 *
 * @covers DBMAINT-03
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { runIncrementalVacuum } from "./db-incremental-vacuum";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function freePageCount(db: Database): number {
  return (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
}

/** A database with at least `freePages` pages on its freelist. */
function makeDb(mode: "INCREMENTAL" | "NONE", freePages: number): Database {
  const db = new Database(":memory:");
  open.push(db);
  db.run(`PRAGMA auto_vacuum = ${mode}`);
  db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, body BLOB)");
  const insert = db.prepare("INSERT INTO messages (body) VALUES (?)");
  db.run("BEGIN");
  for (let i = 0; i < freePages + 50; i++) insert.run(new Uint8Array(3000));
  db.run("COMMIT");
  db.run("DELETE FROM messages WHERE id > 50");
  expect(freePageCount(db)).toBeGreaterThanOrEqual(freePages);
  return db;
}

/** Counts the `incremental_vacuum` statements the round runs. */
function countSteps(db: Database): string[] {
  const steps: string[] = [];
  const run = db.run.bind(db);
  (db as unknown as { run: (sql: string) => unknown }).run = (sql: string) => {
    if (sql.includes("incremental_vacuum")) steps.push(sql);
    return run(sql);
  };
  return steps;
}

describe("runIncrementalVacuum", () => {
  test("idle, more free pages than the cap: releases exactly the cap, in steps", async () => {
    const db = makeDb("INCREMENTAL", 200);
    const before = freePageCount(db);
    const steps = countSteps(db);
    const outcome = await runIncrementalVacuum({ db, busy: () => null, stepPages: 16, maxPages: 64, log: () => {} });
    expect(outcome).toEqual({ action: "vacuumed", pages: 64, remaining: before - 64, stoppedBy: null });
    expect(steps).toEqual(Array(4).fill("PRAGMA incremental_vacuum(16)"));
    expect(freePageCount(db)).toBe(before - 64);
  });

  test("fewer free pages than the cap: empties the freelist and stops", async () => {
    const db = makeDb("INCREMENTAL", 20);
    const before = freePageCount(db);
    const outcome = await runIncrementalVacuum({ db, busy: () => null, stepPages: 16, maxPages: 1000, log: () => {} });
    expect(outcome).toEqual({ action: "vacuumed", pages: before, remaining: 0, stoppedBy: null });
  });

  test("a turn starts after the first step: the round stops there", async () => {
    const db = makeDb("INCREMENTAL", 200);
    const before = freePageCount(db);
    let asked = 0;
    const outcome = await runIncrementalVacuum({
      db,
      busy: async () => (asked++ === 0 ? null : "1 chat in streaming (topic:a)"),
      stepPages: 16,
      maxPages: 1000,
      log: () => {},
    });
    expect(outcome).toEqual({ action: "vacuumed", pages: 16, remaining: before - 16, stoppedBy: "1 chat in streaming (topic:a)" });
  });

  test("busy from the start: nothing runs", async () => {
    const db = makeDb("INCREMENTAL", 50);
    const steps = countSteps(db);
    const outcome = await runIncrementalVacuum({ db, busy: () => "2 turno/i di card della board", log: () => {} });
    expect(outcome).toEqual({ action: "skipped", reason: "2 turno/i di card della board" });
    expect(steps).toEqual([]);
  });

  test("a database still in NONE mode is not touched", async () => {
    const db = makeDb("NONE", 50);
    const steps = countSteps(db);
    const outcome = await runIncrementalVacuum({ db, busy: () => null, log: () => {} });
    expect(outcome.action).toBe("skipped");
    expect(steps).toEqual([]);
  });

  test("an empty freelist is not a round", async () => {
    const db = new Database(":memory:");
    open.push(db);
    db.run("PRAGMA auto_vacuum = INCREMENTAL");
    db.run("CREATE TABLE t (x)");
    const outcome = await runIncrementalVacuum({ db, busy: () => null, log: () => {} });
    expect(outcome).toEqual({ action: "skipped", reason: "no free pages" });
  });
});

describe("server.ts wiring", () => {
  // server.ts cannot boot in a unit test, so the wiring is read off the file:
  // the round runs on a timer, asks the restart gate's predicate, and the
  // timer stops with the server.
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "server.ts"), "utf8");

  test("a timer runs the round with whatIsStillWorking() as the busy predicate", () => {
    const call = SERVER.match(/setInterval\(\(\) => \{\s*runIncrementalVacuum\(\{[\s\S]*?\}, INCREMENTAL_VACUUM_EVERY_MS\)/);
    expect(call, "no setInterval running runIncrementalVacuum every INCREMENTAL_VACUUM_EVERY_MS").not.toBeNull();
    expect(call![0]).toContain("busy: async () => (await whatIsStillWorking()).busy");
  });

  test("graceful shutdown clears the timer", () => {
    expect(SERVER.includes("clearInterval(incrementalVacuumTimer);"), "the timer outlives shutdown").toBe(true);
  });
});
