/**
 * THE ONE-TIME CONVERSION TO `auto_vacuum = INCREMENTAL`, RUN BY start-prod.sh.
 *
 * A database born with `auto_vacuum = NONE` only changes mode through a full
 * `VACUUM`, which holds the write lock for minutes on a multi-GB file. So it
 * runs once, before the supervisor starts the server, and every way it can go
 * wrong must end with the server starting on an untouched database.
 *
 * The process-level cases run the REAL step: the lines of `start-prod.sh` that
 * call the script, through bash, against a synthetic database in a temp data
 * dir (`DATA_DIR`). Nothing here opens the live database. The two cases that
 * need a condition a test cannot produce for real (a full disk, a VACUUM that
 * throws) call the exported function with that dependency injected.
 *
 * @covers DBMAINT-02
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { enableIncrementalVacuum, BACKUP_SUFFIX, FAILED_MARKER_SUFFIX } from "./enable-incremental-vacuum";

const REPO_ROOT = resolve(import.meta.dir, "..");
const START_PROD = readFileSync(join(REPO_ROOT, "scripts", "start-prod.sh"), "utf8").split("\n");

/** The step as start-prod.sh runs it: the call line and its continuations. */
function stepLines(): { from: number; text: string } {
  const from = START_PROD.findIndex((l) => l.includes("scripts/enable-incremental-vacuum.ts"));
  if (from < 0) throw new Error("start-prod.sh does not call scripts/enable-incremental-vacuum.ts");
  const lines = [START_PROD[from]];
  for (let i = from; START_PROD[i].trimEnd().endsWith("\\"); i++) lines.push(START_PROD[i + 1]);
  return { from, text: lines.join("\n") };
}

let root: string;
let dataDir: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "enable-incremental-vacuum-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  dbPath = join(dataDir, "topics.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Reads one value through a statement finalized at once. A cached statement
 * (`db.query`, `db.transaction`) outlives `close()` and keeps the connection,
 * and its lock, alive: the script would then see the database "open in another
 * process", which here is this one.
 */
function one(db: Database, sql: string): number {
  const stmt = db.prepare(sql);
  try {
    return Object.values(stmt.get() as object)[0] as number;
  } finally {
    stmt.finalize();
  }
}

/** A database shaped like one born before this change: NONE, WAL, free pages. */
function makeLegacyDb(): number {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, body BLOB)");
  const insert = db.prepare("INSERT INTO messages (body) VALUES (?)");
  db.run("BEGIN");
  for (let i = 0; i < 1500; i++) insert.run(new Uint8Array(3000));
  db.run("COMMIT");
  insert.finalize();
  db.run("DELETE FROM messages WHERE id % 2 = 0");
  const left = one(db, "SELECT count(*) FROM messages");
  db.close();
  return left;
}

function inspect(path: string): { mode: number; free: number; rows: number } {
  // Not readonly: a WAL-mode file with no -shm beside it (the backup) cannot open readonly.
  const db = new Database(path);
  try {
    return {
      mode: one(db, "PRAGMA auto_vacuum"),
      free: one(db, "PRAGMA freelist_count"),
      rows: one(db, "SELECT count(*) FROM messages"),
    };
  } finally {
    db.close();
  }
}

function runStep(): { code: number; out: string } {
  const res = Bun.spawnSync(["bash", "-c", stepLines().text], {
    env: { ...process.env, APP_DIR: REPO_ROOT, BUN: process.execPath, DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode ?? -1, out: res.stdout.toString() + res.stderr.toString() };
}

describe("the start-prod.sh step", () => {
  test("runs before the supervisor loop starts the server, and its failure does not stop the script", () => {
    const { from, text } = stepLines();
    const loop = START_PROD.findIndex((l) => l.includes('while [ "$SHUTTING_DOWN" != 1 ]'));
    expect(loop).toBeGreaterThan(from);
    expect(text).toContain("||");
  });

  test("converts a NONE database: INCREMENTAL, no free pages, smaller file, backup of the old one", () => {
    const rows = makeLegacyDb();
    const before = inspect(dbPath);
    expect(before.mode).toBe(0);
    expect(before.free).toBeGreaterThan(0);
    const sizeBefore = statSync(dbPath).size;

    const { code, out } = runStep();

    expect(code, out).toBe(0);
    const after = inspect(dbPath);
    expect(after).toEqual({ mode: 2, free: 0, rows });
    expect(statSync(dbPath).size).toBeLessThan(sizeBefore);
    const backup = inspect(dbPath + BACKUP_SUFFIX);
    expect(backup.mode).toBe(0);
    expect(backup.rows).toBe(rows);
  });

  test("a second start does nothing: already INCREMENTAL", () => {
    makeLegacyDb();
    expect(runStep().code).toBe(0);
    rmSync(dbPath + BACKUP_SUFFIX);
    const { code, out } = runStep();
    expect(code, out).toBe(0);
    expect(existsSync(dbPath + BACKUP_SUFFIX)).toBe(false);
    expect(out).toContain("already");
  });

  test("a database another process holds open is left alone, and the step still exits 0", () => {
    makeLegacyDb();
    const live = new Database(dbPath);
    try {
      one(live, "SELECT count(*) FROM messages");
      const { code, out } = runStep();
      expect(code, out).toBe(0);
      expect(out).toContain("open in another process");
    } finally {
      live.close();
    }
    expect(inspect(dbPath).mode).toBe(0);
    expect(existsSync(dbPath + BACKUP_SUFFIX)).toBe(false);
  });

  test("the failure marker stops every later attempt", () => {
    makeLegacyDb();
    writeFileSync(dbPath + FAILED_MARKER_SUFFIX, "VACUUM failed: disk I/O error\n");
    const { code, out } = runStep();
    expect(code, out).toBe(0);
    expect(inspect(dbPath).mode).toBe(0);
    expect(existsSync(dbPath + BACKUP_SUFFIX)).toBe(false);
    expect(out).toContain(FAILED_MARKER_SUFFIX);
  });

  test("no database yet: nothing is created", () => {
    const { code } = runStep();
    expect(code).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("a file that is not a database fails the script, and the step still exits 0", () => {
    writeFileSync(dbPath, "not a database, just bytes ".repeat(400));
    const { code, out } = runStep();
    expect(code, out).toBe(0);
    expect(out).toContain("starting the server anyway");
  });
});

describe("enableIncrementalVacuum, conditions a test cannot produce for real", () => {
  test("free disk under 2x the database: skipped before the backup", () => {
    makeLegacyDb();
    const size = statSync(dbPath).size;
    const outcome = enableIncrementalVacuum({ dbPath, freeBytes: () => size * 2 - 1, log: () => {} });
    expect(outcome.action).toBe("skipped");
    expect(inspect(dbPath).mode).toBe(0);
    expect(existsSync(dbPath + BACKUP_SUFFIX)).toBe(false);
  });

  test("room for the backup but not for the VACUUM after it: the backup is removed", () => {
    makeLegacyDb();
    const size = statSync(dbPath).size;
    const reads = [size * 4, size];
    const outcome = enableIncrementalVacuum({ dbPath, freeBytes: () => reads.shift() ?? 0, log: () => {} });
    expect(outcome.action).toBe("skipped");
    expect(inspect(dbPath).mode).toBe(0);
    expect(existsSync(dbPath + BACKUP_SUFFIX)).toBe(false);
  });

  test("a VACUUM that throws leaves the data intact and writes the marker", () => {
    const rows = makeLegacyDb();
    const outcome = enableIncrementalVacuum({
      dbPath,
      vacuum: () => { throw new Error("disk I/O error"); },
      log: () => {},
    });
    expect(outcome.action).toBe("failed");
    expect(inspect(dbPath)).toMatchObject({ mode: 0, rows });
    expect(readFileSync(dbPath + FAILED_MARKER_SUFFIX, "utf8")).toContain("disk I/O error");
  });
});
