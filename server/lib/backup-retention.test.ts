/**
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupKeepCount, expiredBackupEntries } from "./backup-retention";

const e = (name: string, mtimeMs: number) => ({ id: name, name, mtimeMs });
const auto = (hash: string, day: string) => `topics-pre-${hash}-${day}.db`;

describe("backup retention", () => {
  test("keeps the newest N copies and drops the rest", () => {
    const out = expiredBackupEntries([e(auto("aaaaaaa", "20261101"), 1), e(auto("bbbbbbb", "20261102"), 2), e(auto("ccccccc", "20261103"), 3), e(auto("ddddddd", "20261104"), 4)], 2);
    expect(out.sort()).toEqual([auto("aaaaaaa", "20261101"), auto("bbbbbbb", "20261102")]);
  });
  test("a database and its wal/shm siblings are one copy", () => {
    const out = expiredBackupEntries([e(auto("aaaaaaa", "20261101"), 1), e(`${auto("aaaaaaa", "20261101")}-wal`, 1), e(auto("bbbbbbb", "20261102"), 5), e(`${auto("bbbbbbb", "20261102")}-shm`, 5)], 1);
    expect(out.sort()).toEqual([auto("aaaaaaa", "20261101"), `${auto("aaaaaaa", "20261101")}-wal`]);
  });
  test("zero disables pruning", () => {
    expect(expiredBackupEntries([e(auto("aaaaaaa", "20261101"), 1), e(auto("bbbbbbb", "20261102"), 2)], 0)).toEqual([]);
  });
  test("env: default 3, override, bad value falls back", () => {
    expect(backupKeepCount({})).toBe(3);
    expect(backupKeepCount({ TOPICS_BACKUP_KEEP: "5" })).toBe(5);
    expect(backupKeepCount({ TOPICS_BACKUP_KEEP: "x" })).toBe(3);
  });
  test("named copies, branch lists and recovery folders are never expired", () => {
    const names = [
      "pre-merge-20261117.db",
      "topics-pre-reasoning-translations.db",
      "pre-openclaw-migration.db",
      "branches-deleted-20261101.txt",
      "origin-branches-archived-20261101.json",
      "pre-filter-repo",
      "canonical-share-recovery-1",
    ];
    const out = expiredBackupEntries([...names.map((n, i) => e(n, i)), e(auto("aaaaaaa", "20261101"), 100), e(auto("bbbbbbb", "20261102"), 200)], 1);
    expect(out).toEqual([auto("aaaaaaa", "20261101")]);
  });
  test("a fake folder: only the old automatic copy is a candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-retention-"));
    try {
      writeFileSync(join(dir, "pre-merge-20261117.db"), "x");
      writeFileSync(join(dir, "branches-deleted-1.txt"), "x");
      mkdirSync(join(dir, "pre-filter-repo"));
      writeFileSync(join(dir, auto("aaaaaaa", "20261101")), "x");
      writeFileSync(join(dir, auto("bbbbbbb", "20261102")), "x");
      const entries = ["pre-merge-20261117.db", "branches-deleted-1.txt", "pre-filter-repo", auto("aaaaaaa", "20261101"), auto("bbbbbbb", "20261102")]
        .map((name, i) => ({ id: join(dir, name), name, mtimeMs: i }));
      const expired = expiredBackupEntries(entries, 1);
      for (const p of expired) rmSync(p, { force: true });
      expect(existsSync(join(dir, auto("aaaaaaa", "20261101")))).toBe(false);
      for (const kept of ["pre-merge-20261117.db", "branches-deleted-1.txt", "pre-filter-repo", auto("bbbbbbb", "20261102")]) {
        expect(existsSync(join(dir, kept))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
