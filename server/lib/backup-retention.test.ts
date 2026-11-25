/**
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { backupKeepCount, expiredBackupEntries } from "./backup-retention";

const e = (name: string, mtimeMs: number) => ({ id: name, name, mtimeMs });

describe("backup retention", () => {
  test("keeps the newest N copies and drops the rest", () => {
    const out = expiredBackupEntries([e("a.db", 1), e("b.db", 2), e("c.db", 3), e("d.db", 4)], 2);
    expect(out.sort()).toEqual(["a.db", "b.db"]);
  });
  test("a database and its wal/shm siblings are one copy", () => {
    const out = expiredBackupEntries([e("a.db", 1), e("a.db-wal", 1), e("b.db", 5), e("b.db-shm", 5)], 1);
    expect(out.sort()).toEqual(["a.db", "a.db-wal"]);
  });
  test("zero disables pruning", () => {
    expect(expiredBackupEntries([e("a", 1), e("b", 2)], 0)).toEqual([]);
  });
  test("env: default 3, override, bad value falls back", () => {
    expect(backupKeepCount({})).toBe(3);
    expect(backupKeepCount({ TOPICS_BACKUP_KEEP: "5" })).toBe(5);
    expect(backupKeepCount({ TOPICS_BACKUP_KEEP: "x" })).toBe(3);
  });
});
