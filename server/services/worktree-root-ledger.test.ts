/**
 * The proof of ownership the GC asks before it moves a folder (the sentinel of a
 * root, the marker of a folder), the quarantine a ghost goes to instead of `rm`,
 * and the roots Topics used before, read off its rows and its database. Real
 * folders under `mkdtemp`.
 *
 * @covers WORKTREE-STD-08
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUARANTINE_DIR, folderOwned, hasRootSentinel, listQuarantine, markFolderOwned, pastRootsFromRows, purgeQuarantine,
  quarantineFolder, restoreQuarantined, writeRootSentinel,
} from "./worktree-root-ledger";
import { ownedWorktreeRoots } from "./worktree-root";
import { rootsOfDatabase } from "./worktree-root-check";

const DAY = 24 * 3600_000;

describe("the worktree root ledger", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wt-ledger-"));
    root = join(base, "wts");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const folder = (rel: string): string => {
    const p = join(root, rel);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "f.txt"), rel);
    return p;
  };

  test("the sentinel and the marker are written once, outside any checkout, and read back", () => {
    expect(hasRootSentinel(root)).toBe(false);
    expect(writeRootSentinel(root)).toBe(true);
    expect(hasRootSentinel(root)).toBe(true);
    const wt = folder("proj/one");
    expect(folderOwned(root, wt)).toBe(false);
    expect(markFolderOwned(root, wt, { worktreeId: "w1" })).toBe(true);
    expect(folderOwned(root, wt)).toBe(true);
    expect(existsSync(join(wt, ".topics-owned"))).toBe(false);
    // Only `{slug}/{name}` can be marked: the root, a slug folder and a deeper folder cannot.
    expect(markFolderOwned(root, join(root, "proj"))).toBe(false);
    expect(markFolderOwned(root, join(root, "proj", "one", "deep"))).toBe(false);
    expect(markFolderOwned(root, join(base, "elsewhere", "x"))).toBe(false);
  });

  test("a quarantined folder keeps its content, says where it came from, and can be moved back", () => {
    const wt = folder("proj/ghost");
    markFolderOwned(root, wt);
    const to = quarantineFolder(root, wt, new Date("2026-11-20T10:00:00Z"))!;
    expect(to).toBe(join(root, QUARANTINE_DIR, "2026-11-20", "proj", "ghost"));
    expect(existsSync(join(to, "f.txt"))).toBe(true);
    expect(folderOwned(root, wt)).toBe(false);
    expect(listQuarantine(root)).toEqual([{ path: to, from: wt, sinceMs: Date.parse("2026-11-20") }]);
    expect(restoreQuarantined(root, to)).toBe(wt);
    expect(existsSync(join(wt, "f.txt"))).toBe(true);
    expect(folderOwned(root, wt)).toBe(true);
    expect(listQuarantine(root)).toEqual([]);
  });

  test("the same name quarantined twice on one day does not overwrite the first", () => {
    const day = new Date("2026-11-20T10:00:00Z");
    const first = quarantineFolder(root, folder("proj/twice"), day)!;
    const second = quarantineFolder(root, folder("proj/twice"), new Date(day.getTime() + 1000))!;
    expect(second).not.toBe(first);
    expect(existsSync(first) && existsSync(second)).toBe(true);
  });

  test("the purge deletes only what is older than the setting, and only folders three levels under the quarantine", async () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const old = quarantineFolder(root, folder("proj/old"), new Date("2026-11-10T10:00:00Z"))!;
    const fresh = quarantineFolder(root, folder("proj/fresh"), new Date("2026-11-24T10:00:00Z"))!;
    // A stray file at the day level is not a quarantined folder.
    writeFileSync(join(root, QUARANTINE_DIR, "2026-11-10", "stray.txt"), "x");
    expect(await purgeQuarantine(root, 7, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(root, QUARANTINE_DIR, "2026-11-10", "stray.txt"))).toBe(true);
    expect(await purgeQuarantine(root, 1, now)).toBe(1);
    expect(existsSync(fresh)).toBe(false);
  });

  test("past roots come from Topics' rows, and only from a root that carries the sentinel", () => {
    const proven = join(base, "first-root");
    const unproven = join(base, "looks-like-a-root");
    writeRootSentinel(proven);
    mkdirSync(unproven, { recursive: true });
    const rows = [
      { absPath: join(proven, "proj", "a") },
      { absPath: join(unproven, "proj", "b") },
      { absPath: join(base, "adopted", "x") },
    ];
    expect(pastRootsFromRows(rows, new Set(["proj"]))).toEqual([proven]);
    expect(pastRootsFromRows(rows, new Set(["other"]))).toEqual([]);
  });

  test("the owned roots: current first, then the default, then the proven past ones, no duplicates", () => {
    const proven = join(base, "first-root");
    writeRootSentinel(proven);
    const env = { TOPICS_HOME: join(base, "home") } as NodeJS.ProcessEnv;
    const r = ownedWorktreeRoots([{ absPath: join(proven, "proj", "a") }], new Set(["proj"]), env);
    expect(r.root).toBe(join(base, "home", "worktrees"));
    expect(r.extraRoots).toEqual([proven]);
  });

  test("the scripts read the roots of the database they are pointed at, not the home of whoever runs them", () => {
    const dbPath = join(base, "topics.db");
    const db = new Database(dbPath);
    // Not under a temp area: the reader drops a root the resolver would refuse.
    const configured = "/data/configured-root";
    const proven = join(base, "first-root");
    writeRootSentinel(proven);
    db.run("CREATE TABLE worktrees (id TEXT, project_id TEXT, abs_path TEXT, status TEXT, created_at TEXT)");
    db.run("CREATE TABLE app_settings (id INTEGER PRIMARY KEY, worktree_root TEXT)");
    db.run("CREATE TABLE projects (id TEXT, slug TEXT, path TEXT)");
    db.run("INSERT INTO app_settings (id, worktree_root) VALUES (1, ?)", [configured]);
    db.run("INSERT INTO projects VALUES ('p1', 'proj', '/r/proj')");
    db.run("INSERT INTO worktrees VALUES ('w1', 'p1', ?, 'ready', '2026-11-01T00:00:00Z')", [join(proven, "proj", "a")]);
    db.close();
    const env = { TOPICS_HOME: join(base, "home") } as NodeJS.ProcessEnv;
    const r = rootsOfDatabase(dbPath, env);
    expect(r.root).toBe(configured);
    expect(r.extraRoots).toEqual([join(base, "home", "worktrees"), proven]);
    expect(r.projects).toEqual([{ slug: "proj", path: "/r/proj" }]);
  });

  test("a day folder renamed into the past is what makes a quarantined folder due", async () => {
    const q = quarantineFolder(root, folder("proj/aging"), new Date())!;
    const dayDir = join(q, "..", "..");
    renameSync(dayDir, join(root, QUARANTINE_DIR, "2000-01-01"));
    expect(await purgeQuarantine(root, 7, Date.now() - DAY)).toBe(1);
  });
});
