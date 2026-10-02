/**
 * A NEW DATABASE IS BORN WITH `auto_vacuum = INCREMENTAL`.
 *
 * The mode can only be set for free before the first table exists. Later it
 * takes a full `VACUUM`, which on a multi-GB file means minutes with the server
 * down (`scripts/enable-incremental-vacuum.ts` pays that once for the databases
 * born before this line). A fresh install must never need it.
 *
 * @covers DBMAINT-01
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "./db";

let tmpRoot: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe("initDatabase on an empty data dir", () => {
  test("creates the file in INCREMENTAL auto-vacuum mode, with the migrations applied", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "db-auto-vacuum-"));
    // DATA_DIR wins over the root in `resolveDataDir`: pin it so the test
    // writes where it looks, whatever the preload exported.
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = join(tmpRoot, "data");
    try {
      const db = initDatabase(join(import.meta.dir, ".."), tmpRoot);
      expect((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
      const tables = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
      expect(tables.n).toBeGreaterThan(20);
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    }
  });
});
