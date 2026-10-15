/** @covers D3F-02 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFileTree } from "./file-tree";
import { nativeFileTreeEnabled, nativeFileTreeSnapshot, readNativeFileTree, setNativeFileTreeTestOverrides } from "./native-file-tree";
import type { NativeModule } from "./native-addon";

afterEach(() => setNativeFileTreeTestOverrides(null));

test("the file-tree switch selects JavaScript or native and exposes counters", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-file-tree-"));
  mkdirSync(join(root, "subdir"));
  writeFileSync(join(root, "subdir", "file.txt"), "x");
  let calls = 0;
  const native: NativeModule = {
    nativeVersion: () => "test",
    gitHeadCommitId: () => null,
    walkFileTree: async () => { calls++; return []; },
  };
  try {
    setNativeFileTreeTestOverrides({ enabled: false, module: native });
    const jsTree = await walkFileTree(root, 3);
    expect(jsTree.map(({ name }) => name)).toEqual(["subdir"]);
    expect(calls).toBe(0);
    expect(nativeFileTreeSnapshot()).toMatchObject({ loaded: true, enabled: false, calls: 0, fallbacks: 0 });

    setNativeFileTreeTestOverrides({ enabled: true, module: native });
    expect(await walkFileTree(root, 3)).toEqual([]);
    expect(calls).toBe(1);
    expect(nativeFileTreeSnapshot()).toMatchObject({ loaded: true, enabled: true, calls: 1, fallbacks: 0, lastError: null });

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    const rejecting: NativeModule = {
      nativeVersion: () => "test",
      gitHeadCommitId: () => null,
      walkFileTree: async () => { throw new Error("fixture rejection"); },
    };
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      setNativeFileTreeTestOverrides({ enabled: true, module: rejecting });
      expect((await walkFileTree(root, 3)).map(({ name }) => name)).toEqual(["subdir"]);
      expect((await walkFileTree(root, 3)).map(({ name }) => name)).toEqual(["subdir"]);
      expect(nativeFileTreeSnapshot()).toMatchObject({ calls: 2, fallbacks: 2, lastError: "fixture rejection" });
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file-tree switch reads server-synced settings and counts a missing addon without warning", async () => {
  const db = new Database(":memory:");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    db.run("CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)");
    expect(nativeFileTreeEnabled(db)).toBe(true);
    db.query("INSERT INTO ui_state (key, value) VALUES ('settings', ?)").run(JSON.stringify({ nativeFileTreeEnabled: false }));
    expect(nativeFileTreeEnabled(db)).toBe(false);
    db.query("UPDATE ui_state SET value = ? WHERE key = 'settings'").run("not-json");
    expect(nativeFileTreeEnabled(db)).toBe(true);

    console.warn = (...args: unknown[]) => { warnings.push(args); };
    setNativeFileTreeTestOverrides({ enabled: true, module: null });
    expect(await readNativeFileTree("/missing", 1)).toBeUndefined();
    expect(nativeFileTreeSnapshot()).toMatchObject({ loaded: false, enabled: true, calls: 0, fallbacks: 1 });
  } finally {
    console.warn = originalWarn;
    db.close();
  }
  expect(warnings).toEqual([]);
});
