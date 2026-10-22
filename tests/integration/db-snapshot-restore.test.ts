/**
 * The database's daily snapshot, and the proof that it restores.
 *
 * What counts here is not that `VACUUM INTO` runs, but that the bar's command
 * (`restoreCheck`) turns RED when the copy does not hold. Every red test is a
 * way a fake backup would pass for a good one:
 *  - one byte missing from the compressed file;
 *  - a DB page whose index and table disagree (decompression succeeds, the DB
 *    opens, only `integrity_check` sees it);
 *  - a schema with every migration registered and no work inside;
 *  - the last snapshot days old, which is the nightly job having stopped.
 * Retention is proven on the NAMES: the 15th day goes, a Monday beyond the
 * window stays, the ninth Monday goes.
 * @covers SCHEMA-07
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDatabase, initDatabase } from "../../server/db";
import { listSnapshots, pruneCandidates, pruneSnapshots, snapshotDb } from "../../scripts/db-snapshot";
import { restoreCheck } from "../../scripts/backup-restore-check";
import { PROJECT_ROOT, testTmpDir } from "./helpers";

const ROOT = testTmpDir("db-snapshot");
const SOURCE = path.join(ROOT, "source");
const prevDataDir = process.env.DATA_DIR;
let migrationFiles = 0;

beforeAll(() => {
  process.env.DATA_DIR = SOURCE;
  const db = initDatabase(PROJECT_ROOT);
  // A table with an index: its contents are what the corrupted-DB test alters.
  db.run("CREATE TABLE snapshot_probe (v TEXT)");
  db.run("CREATE INDEX snapshot_probe_v ON snapshot_probe (v)");
  for (let i = 0; i < 200; i++) db.run("INSERT INTO snapshot_probe (v) VALUES (?)", [`needle-${1000 + i}`]);
  // The work a backup of this machine must contain: without it the bar is red,
  // and the "schema with no work" test below is what proves it.
  db.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES ('t1','T','t','topic:t1','now','now')");
  db.run("INSERT INTO messages (id, session_key, role, content, timestamp) VALUES ('m1','topic:t1','user','ciao','now')");
  closeDatabase();
  migrationFiles = readdirSync(path.join(PROJECT_ROOT, "server/db/migrations")).filter((f) => /^\d+-.+\.sql$/.test(f)).length;
});

afterAll(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
});

const freshBackups = (label: string) => path.join(testTmpDir(label), "backups");
const sourceDb = () => path.join(SOURCE, "topics.db");

describe("snapshot e ripristino", () => {
  test("lo snapshot e' di oggi, integro, e arriva a tutte le migration", () => {
    const dir = freshBackups("snap-ok");
    const target = snapshotDb(sourceDb(), dir);
    expect(readdirSync(dir)).toEqual([path.basename(target)]); // no leftover temporary
    expect(Date.now() - statSync(target).mtimeMs).toBeLessThan(86_400_000);
    expect(migrationFiles).toBeGreaterThan(0);
    expect(restoreCheck(dir)).toEqual({ migrations: migrationFiles, topics: 1, messages: 1 });
  });

  test("un byte in meno nel file compresso: rosso", () => {
    const dir = freshBackups("snap-truncated");
    const target = snapshotDb(sourceDb(), dir);
    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, bytes.length - 1));
    expect(() => restoreCheck(dir)).toThrow();
  });

  test("tabella e indice che non concordano: rosso per integrity_check", () => {
    const dir = freshBackups("snap-mismatch");
    const target = snapshotDb(sourceDb(), dir);
    const raw = Buffer.from(Bun.zstdDecompressSync(readFileSync(target)));
    const at = raw.indexOf("needle-1100");
    expect(at).toBeGreaterThan(0);
    raw.write("needle-XXXX", at);
    writeFileSync(target, Bun.zstdCompressSync(raw));
    // The corrupted DB opens and answers: integrity_check alone sees it.
    expect(() => restoreCheck(dir)).toThrow(/integrity_check/);
  });

  test("registro con migration che questo codice non conosce: rosso", () => {
    const dir = freshBackups("snap-future");
    const target = snapshotDb(sourceDb(), dir);
    const file = path.join(dir, "future.db");
    writeFileSync(file, Bun.zstdDecompressSync(readFileSync(target)));
    const db = new Database(file);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, '9999-from-the-future.sql', 'x')");
    db.close();
    writeFileSync(target, Bun.zstdCompressSync(readFileSync(file)));
    expect(() => restoreCheck(dir)).toThrow(/migrations registered/);
  });

  test("l'ultimo snapshot vecchio di giorni: rosso", () => {
    const dir = freshBackups("snap-stale");
    snapshotDb(sourceDb(), dir, new Date(Date.now() - 5 * 86_400_000));
    expect(() => restoreCheck(dir)).toThrow(/days old/);
  });

  test("schema intatto ma senza lavoro dentro: rosso", () => {
    // The case the migration count does NOT see: `initDatabase` creates the
    // schema and registers every migration on any file, so a backup of an
    // empty DB passed exactly like a good one.
    const empty = testTmpDir("snap-empty-src");
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = empty;
    initDatabase(PROJECT_ROOT);
    closeDatabase();
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;

    const dir = freshBackups("snap-empty");
    snapshotDb(path.join(empty, "topics.db"), dir);
    expect(() => restoreCheck(dir)).toThrow(/no work/);
  });

  test("senza snapshot: rosso", () => {
    expect(() => restoreCheck(freshBackups("snap-none"))).toThrow(/no snapshot/);
  });
});

describe("retention", () => {
  const days = (count: number, startIso: string) =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.parse(`${startIso}T00:00:00Z`) + i * 86_400_000);
      return `topics-${d.toISOString().slice(0, 10)}.db.zst`;
    });

  test("il 15esimo giorno esce, i primi 14 restano", () => {
    // The oldest is a Tuesday (2026-09-08): not a Monday, so nothing saves it.
    const names = days(15, "2026-09-08").reverse();
    expect(pruneCandidates(names)).toEqual([names[14]]);
  });

  test("un lunedi' oltre la finestra resta, fino a otto; il nono esce", () => {
    const recent = days(14, "2026-09-08").reverse();
    // Ten weekly Mondays, newest first: 2026-08-31 and back.
    const mondays = Array.from({ length: 10 }, (_, i) => `topics-${new Date(Date.parse("2026-08-31T00:00:00Z") - i * 7 * 86_400_000).toISOString().slice(0, 10)}.db.zst`);
    const doomed = pruneCandidates([...recent, ...mondays]);
    expect(doomed).toEqual(mondays.slice(8));
  });

  test("la potatura toglie un file solo e lascia stare i nomi estranei", () => {
    const dir = freshBackups("snap-prune");
    mkdirSync(dir, { recursive: true });
    const names = days(15, "2026-09-08").reverse();
    for (const n of [...names, "attic-2026-09-08.json.zst", "topics.db.bak-pre-x"]) writeFileSync(path.join(dir, n), "x");
    // `remove` injected: in production the default is `trash` (see
    // `import.meta.main` in db-snapshot.ts), but calling it here would mean
    // filling the Trash on every run on the Mac, and a red on ubuntu-latest,
    // which has no `trash`. What is proven is WHICH files go.
    const removed: string[] = [];
    expect(pruneSnapshots(dir, (p) => { removed.push(path.basename(p)); unlinkSync(p); })).toEqual([names[14]]);
    expect(removed).toEqual([names[14]]);
    expect(existsSync(path.join(dir, names[14]))).toBe(false);
    expect(listSnapshots(dir)).toHaveLength(14);
    expect(readdirSync(dir)).toContain("attic-2026-09-08.json.zst");
    expect(readdirSync(dir)).toContain("topics.db.bak-pre-x");
  });
});
