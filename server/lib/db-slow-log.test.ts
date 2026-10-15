/** @covers DBSLOW-01 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { instrumentSlowStatements } from "./db-slow-log";
import { closeDatabase, initDatabase } from "../db";

/** A clock that moves `step` ms on every read, plus whatever `jump` adds. */
function steppingClock(step: number) {
  let t = 0;
  let reads = 0;
  return {
    now: () => {
      reads++;
      t += step;
      return t;
    },
    jump: (ms: number) => {
      t += ms;
    },
    reads: () => reads,
  };
}

function instrumented(step: number) {
  const db = new Database(":memory:");
  const lines: string[] = [];
  const clock = steppingClock(step);
  instrumentSlowStatements(db, { thresholdMs: 250, log: (line) => lines.push(line), now: clock.now });
  return { db, lines, clock };
}

describe("instrumentSlowStatements", () => {
  test("a statement slower than the threshold prints its time, method, rows and SQL", () => {
    const { db, lines } = instrumented(300);
    db.query("SELECT 1 AS x\n  UNION ALL SELECT 2").all();
    expect(lines).toEqual(["[DB-SLOW] 300ms all rows=2 SELECT 1 AS x UNION ALL SELECT 2"]);
  });

  test("a fast statement prints nothing", () => {
    const { db, lines } = instrumented(10);
    db.query("SELECT 1").get();
    db.prepare("SELECT 2").all();
    db.run("CREATE TABLE fast (x)");
    expect(lines).toEqual([]);
  });

  test("prepare and run on the database are timed too", () => {
    const { db, lines } = instrumented(300);
    db.run("CREATE TABLE t (x)");
    db.prepare("INSERT INTO t VALUES (?)").run(1);
    db.prepare("SELECT x FROM t").values();
    expect(lines).toEqual([
      "[DB-SLOW] 300ms run CREATE TABLE t (x)",
      "[DB-SLOW] 300ms run INSERT INTO t VALUES (?)",
      "[DB-SLOW] 300ms values rows=1 SELECT x FROM t",
    ]);
  });

  test("the same slow SQL prints once a minute, with the count of the calls in between", () => {
    const { db, lines, clock } = instrumented(300);
    const sql = "SELECT 42";
    db.query(sql).get();
    db.query(sql).get();
    clock.jump(60_000);
    db.query(sql).get();
    expect(lines).toEqual(["[DB-SLOW] 300ms get SELECT 42", "[DB-SLOW] 300ms get (+1 slow in the last minute) SELECT 42"]);
  });

  test("a cached statement is timed once per call, however many times query handed it out", () => {
    const { db, clock } = instrumented(1);
    for (let i = 0; i < 3; i++) db.query("SELECT 7").get();
    expect(clock.reads()).toBe(6);
  });
});

describe("initDatabase", () => {
  let tmpRoot = "";
  afterEach(() => {
    closeDatabase();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("the server's database comes out instrumented", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "db-slow-log-"));
    const db = initDatabase(join(import.meta.dir, "..", ".."), tmpRoot);
    expect(Object.hasOwn(db, "query")).toBe(true);
    expect(Object.hasOwn(db, "prepare")).toBe(true);
    expect(Object.hasOwn(db, "run")).toBe(true);
  });
});
