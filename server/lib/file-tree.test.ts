/**
 * @covers FILE-01
 */
/** The explorer tree: the concurrent walk must give the same tree, in the same
 *  order, that the one-entry-at-a-time walk gave. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTreeSlowLogger, fileTreeIo, walkFileTree, walkFileTreeJs, type FileNode } from "./file-tree";
import { makeFakeHome } from "./protected-app-data.fixture";

const root = mkdtempSync(join(tmpdir(), "file-tree-"));
afterAll(() => {
  try { chmodSync(join(root, "locked"), 0o755); } catch { /* best-effort: the locked dir may not exist if the test bailed early */ }
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

test("slow file-tree lines start above 200 ms and repeat at most once a minute", () => {
  let now = 10_000;
  const lines: string[] = [];
  const report = createFileTreeSlowLogger({ now: () => now, log: (line) => lines.push(line) });
  report(200);
  report(201);
  report(900);
  now += 59_999;
  report(250);
  now++;
  report(250);
  expect(lines).toEqual(["[FILE-TREE] 201ms", "[FILE-TREE] 250ms"]);
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
  // A real stat/readdir makes this flaky: under load libuv finishes several of
  // them in the same poll-phase batch, so even a one-entry-at-a-time walk can
  // turn the loop fewer times than a busy machine's run before it (card
  // 5bfe8272, PR #1786, two red CI runs on the same green commit). Swapping
  // `fileTreeIo` for a fake whose "I/O" is only a `setImmediate` tick removes
  // the disk and the thread pool from the picture: every resolution is a step
  // in the JS queue, which Bun processes in the same order regardless of CPU
  // speed, so the turn count becomes a fixed number rather than a measurement.
  const DIR_COUNT = 12;
  const FILE_COUNT = 20;
  const FAKE_ROOT = "/fake-walk-root";
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  function fakeEntries(dir: string): Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> {
    if (dir === FAKE_ROOT) {
      return Array.from({ length: DIR_COUNT }, (_, d) => ({ name: `dir${d}`, isDirectory: () => true, isFile: () => false }));
    }
    return Array.from({ length: FILE_COUNT }, (_, f) => ({ name: `file${f}.txt`, isDirectory: () => false, isFile: () => true }));
  }

  async function walkWithFakeIo(readdir: typeof fileTreeIo.readdir, stat: typeof fileTreeIo.stat): Promise<{ tree: FileNode[]; turns: number }> {
    const realReadDir = fileTreeIo.readdir;
    const realStat = fileTreeIo.stat;
    fileTreeIo.readdir = readdir;
    fileTreeIo.stat = stat;
    let turns = 0;
    let on = true;
    const spin = (): void => { turns++; if (on) setImmediate(spin); };
    setImmediate(spin);
    try {
      const tree = await walkFileTreeJs(FAKE_ROOT, 2);
      return { tree, turns };
    } finally {
      on = false;
      fileTreeIo.readdir = realReadDir;
      fileTreeIo.stat = realStat;
    }
  }

  test("one entry at a time: the loop turns at least once per entry, 20/20 regardless of load", async () => {
    const oneAtATime: typeof fileTreeIo.readdir = async (dir) => { await tick(); return fakeEntries(dir); };
    const oneAtATimeStat: typeof fileTreeIo.stat = async () => { await tick(); return { size: 1, mtime: new Date(0) }; };
    const { tree, turns } = await walkWithFakeIo(oneAtATime, oneAtATimeStat);
    expect(tree).toHaveLength(DIR_COUNT);
    // 1 readdir/dir (x12) + 1 stat/file (x240) + the root readdir, each its own tick.
    expect(turns).toBeGreaterThanOrEqual(DIR_COUNT * FILE_COUNT);
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
