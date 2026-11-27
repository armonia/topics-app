/**
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { topicsHome } from "../services/daemon-state";
import { pruneOldBackups, purgeTrash } from "./backup-prune";
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
      "pre-legacy-migration.db",
      "branches-deleted-20261101.txt",
      "origin-branches-archived-20261101.json",
      "pre-filter-repo",
      "canonical-share-recovery-1",
    ];
    const out = expiredBackupEntries([...names.map((n, i) => e(n, i)), e(auto("aaaaaaa", "20261101"), 100), e(auto("bbbbbbb", "20261102"), 200)], 1);
    expect(out).toEqual([auto("aaaaaaa", "20261101")]);
  });
  test("the two-hash name Topics writes is recognised and ordered by the date in the name", () => {
    const old = "topics-pre-6242e44e-266a3e1e-20261120-0947.db";
    const mid = auto("bbbbbbb", "20261121");
    const fresh = auto("ccccccc", "20261122");
    // a sibling touched later must not make the oldest copy look recent
    const out = expiredBackupEntries([e(old, 999), e(`${old}-shm`, 999), e(mid, 1), e(fresh, 2)], 2, Date.UTC(2026, 10, 30));
    expect(out.sort()).toEqual([old, `${old}-shm`]);
  });
  test("copies younger than the minimum age never expire", () => {
    const out = expiredBackupEntries([e(auto("aaaaaaa", "20261125"), 1), e(auto("bbbbbbb", "20261126"), 2)], 1, Date.UTC(2026, 10, 27));
    expect(out).toEqual([]);
  });
});

describe("pruneOldBackups on a fake home", () => {
  test("moves only the old automatic copy to the trash, named copies and lists stay", () => {
    const home = mkdtempSync(join(tmpdir(), "backup-prune-"));
    const prevHome = process.env.TOPICS_HOME;
    try {
      process.env.TOPICS_HOME = home;
      const dir = join(home, "db-backups");
      mkdirSync(join(dir, "pre-filter-repo"), { recursive: true });
      for (const name of ["pre-merge-20261117.db", "branches-deleted-1.txt", auto("aaaaaaa", "20261101"), auto("bbbbbbb", "20261102")]) {
        writeFileSync(join(dir, name), "x");
      }
      const now = Date.UTC(2026, 10, 30);
      const moved = pruneOldBackups(topicsHome(), { TOPICS_BACKUP_KEEP: "1" }, now);
      expect(moved).toEqual([join(dir, auto("aaaaaaa", "20261101"))]);
      expect(existsSync(join(dir, auto("aaaaaaa", "20261101")))).toBe(false);
      expect(existsSync(join(home, "trash", "20261130", auto("aaaaaaa", "20261101")))).toBe(true);
      for (const kept of ["pre-merge-20261117.db", "branches-deleted-1.txt", "pre-filter-repo", auto("bbbbbbb", "20261102")]) {
        expect(existsSync(join(dir, kept))).toBe(true);
      }
      expect(purgeTrash(home, now)).toEqual([]);
      expect(purgeTrash(home, now + 8 * 86_400_000)).toEqual(["20261130"]);
    } finally {
      if (prevHome === undefined) delete process.env.TOPICS_HOME;
      else process.env.TOPICS_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("does nothing when a kept copy is empty", () => {
    const home = mkdtempSync(join(tmpdir(), "backup-prune-"));
    try {
      const dir = join(home, "db-backups");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, auto("aaaaaaa", "20261101")), "x");
      writeFileSync(join(dir, auto("bbbbbbb", "20261102")), "");
      expect(pruneOldBackups(home, { TOPICS_BACKUP_KEEP: "1" }, Date.UTC(2026, 10, 30))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
