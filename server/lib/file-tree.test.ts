/**
 * @covers FILE-01
 */
/** The explorer tree: the concurrent walk must give the same tree, in the same
 *  order, that the one-entry-at-a-time walk gave. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFileTree, type FileNode } from "./file-tree";
import { makeFakeHome } from "./protected-app-data.fixture";

const root = mkdtempSync(join(tmpdir(), "file-tree-"));
afterAll(() => {
  try { chmodSync(join(root, "locked"), 0o755); } catch {}
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, body = "x") {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

const shape = (nodes: FileNode[]): unknown[] =>
  nodes.map(n => (n.children ? { [n.name + "/"]: shape(n.children) } : n.type === "dir" ? n.name + "/" : n.name));

test("folders first, then names in order; rules, nested rules and depth hold", async () => {
  put(".gitignore", "*.log\n!keep.log\n/data/\nbuild-out/\n");
  put("b.txt"); put("a.txt"); put("app.log"); put("keep.log");
  put("data/x.db"); put("landing/data/changelog.json");
  put("node_modules/pkg/index.js"); put(".topics-secrets/key");
  put("build-out/a.js");
  put("src/.gitignore", "*.gen.ts\n");
  put("src/a.ts"); put("src/b.gen.ts"); put("src/deep/c.ts"); put("src/deep/d.gen.ts");
  put("src/deep/deeper/e.ts");

  const tree = await walkFileTree(root, 3);
  expect(shape(tree)).toEqual([
    { "landing/": [{ "data/": ["changelog.json"] }] },
    { "src/": [{ "deep/": ["deeper/", "c.ts"] }, ".gitignore", "a.ts"] },
    ".gitignore", "a.txt", "b.txt", "keep.log",
  ]);
  const file = tree.find(n => n.name === "a.txt")!;
  expect(file.size).toBe(1);
  expect(typeof file.modified).toBe("string");
});

// root ignores the permission bits, so `chmod 0444` cannot make the stat fail
// there (the cloud VM and most containers run as root). Skipped, and said so in
// the title; as a normal user the test stays able to go red.
const RUNS_AS_ROOT = process.getuid?.() === 0;

test.skipIf(RUNS_AS_ROOT)("a file that cannot be stat-ed still comes out, without a size, next to its siblings (skipped as root)", async () => {
  // A folder that can be listed but not searched: readdir works, stat fails.
  put("locked/one.txt"); put("locked/two.txt");
  chmodSync(join(root, "locked"), 0o444);
  const tree = await walkFileTree(root, 3);
  const locked = tree.find(n => n.name === "locked")!;
  expect(locked.children!.map(n => [n.name, n.size])).toEqual([["one.txt", undefined], ["two.txt", undefined]]);
});

describe("walkFileTree hands the event loop back while it walks", () => {
  test("the loop turns between the entries of a walk, not once at its end", async () => {
    // 12 folders x 20 files. Counted in loop turns, not milliseconds, so a busy
    // machine cannot make it pass or fail: a walk that stats a folder's entries
    // concurrently resolves them back to back and the loop turns a handful of
    // times; one entry at a time, it turns at least once per stat.
    const root = mkdtempSync(join(tmpdir(), "walk-yield-"));
    for (let d = 0; d < 12; d++) {
      mkdirSync(join(root, `dir${d}`));
      for (let f = 0; f < 20; f++) writeFileSync(join(root, `dir${d}`, `file${f}.txt`), "x");
    }
    let turns = 0;
    let on = true;
    const spin = (): void => { turns++; if (on) setImmediate(spin); };
    setImmediate(spin);
    const tree = await walkFileTree(root, 2);
    on = false;
    rmSync(root, { recursive: true, force: true });
    expect(tree).toHaveLength(12);
    expect(turns).toBeGreaterThanOrEqual(120);
  });
});

describe("walkFileTree never crosses into other apps' data", () => {
  // A temporary tree laid out like a home: walking the real one from a test
  // would pop the macOS permission prompt this guards against.
  const names = (nodes: FileNode[] | undefined): string[] => (nodes ?? []).map(n => n.name);
  const find = (nodes: FileNode[] | undefined, name: string): FileNode | undefined => (nodes ?? []).find(n => n.name === name);

  test("from HOME: Library is listed but not opened, a photo library likewise", async () => {
    const fake = makeFakeHome();
    try {
      const tree = await walkFileTree(fake.home, 4);
      const library = find(tree, "Library");
      expect(library?.type).toBe("dir");
      expect(library?.children, "Library must not be walked from HOME").toBeUndefined();
      const photos = find(find(tree, "Pictures")?.children, "Photos Library.photoslibrary");
      expect(photos?.children, "a photo library must not be walked").toBeUndefined();
      // The rest of the home is walked as before.
      expect(names(find(find(tree, "Projects")?.children, "app")?.children)).toContain("src");
    } finally {
      fake.dispose();
    }
  });

  test("from ~/Library: the per-app folders stay closed, Logs opens", async () => {
    const fake = makeFakeHome();
    try {
      const tree = await walkFileTree(join(fake.home, "Library"), 3);
      for (const d of ["Containers", "Group Containers", "Mail", "Messages", "Safari", "Calendars"]) {
        expect(find(tree, d)?.children, `${d} must not be walked`).toBeUndefined();
      }
      expect(names(find(tree, "Logs")?.children)).toEqual(["app.log"]);
    } finally {
      fake.dispose();
    }
  });
});
