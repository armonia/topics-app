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

test("a file that cannot be stat-ed still comes out, without a size, next to its siblings", async () => {
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
