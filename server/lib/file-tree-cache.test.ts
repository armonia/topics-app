/**
 * The file tree served from memory while the file watcher is live, for at most
 * 60 s from the walk; five seconds without a watcher.
 *
 * @covers FILE-01
 */
import { expect, test } from "bun:test";
import type { FileNode } from "../../shared/file-tree";
import { getFileTree, invalidateFileTreeCache, setFileTreeWatcher } from "./file-tree-cache";

test("a live watcher caps idle reads at 60 seconds and then visits the changed tree", async () => {
  const root = `/tmp/file-tree-cache-${crypto.randomUUID()}`;
  let visits = 0;
  let monotonic = 0;
  let version = "before";
  const walk = async (): Promise<FileNode[]> => {
    visits++;
    return [{ name: version, type: "file", path: `${root}/${version}` }];
  };

  try {
    setFileTreeWatcher(root, true);
    await getFileTree(root, 3, walk, () => monotonic);
    version = "after";
    for (let poll = 0; poll < 60; poll++) {
      monotonic += 10_000;
      await getFileTree(root, 3, walk, () => monotonic);
    }
    expect(visits, "ten idle minutes allow the initial visit plus one per 60-second cap").toBe(11);
    expect((await getFileTree(root, 3, walk, () => monotonic))[0]?.name).toBe("after");

    version = "event";
    invalidateFileTreeCache(root);
    expect((await getFileTree(root, 3, walk, () => monotonic))[0]?.name).toBe("event");
    expect(visits).toBe(12);
  } finally {
    invalidateFileTreeCache(root);
    setFileTreeWatcher(root, false);
  }
});

test("without a watcher the five-second fallback TTL expires", async () => {
  const root = `/tmp/file-tree-cache-ttl-${crypto.randomUUID()}`;
  let monotonic = 0;
  let visits = 0;
  const walk = async (): Promise<FileNode[]> => [{ name: String(++visits), type: "file", path: root }];
  await getFileTree(root, 2, walk, () => monotonic);
  monotonic += 5_000;
  await getFileTree(root, 2, walk, () => monotonic);
  expect(visits).toBe(2);
  invalidateFileTreeCache(root);
}, 7_000);
