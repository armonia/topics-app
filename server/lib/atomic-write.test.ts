/**
 * @covers RUNTIME-14
 */
/** The one tmp + rename writer: content, mode, no temp left behind, and a
 *  temp name the usage store's orphan cleanup can still read. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicTempPath, writeFileAtomic } from "./atomic-write";
import { isOrphanTmp } from "../usage/store";

const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("replaces the file and leaves no temp next to it", () => {
  const f = join(dir, "a.json");
  writeFileSync(f, "old");
  writeFileAtomic(f, "new");
  expect(readFileSync(f, "utf8")).toBe("new");
  expect(readdirSync(dir).filter(n => n.startsWith("a.json"))).toEqual(["a.json"]);
});

test("a mode is exact whatever the umask, and replaces the old file's bits", () => {
  const f = join(dir, "secret.json");
  writeFileSync(f, "x", { mode: 0o644 });
  const old = process.umask(0o077);
  try {
    writeFileAtomic(f, "{}", { mode: 0o600 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileAtomic(f, "{}", { mode: 0o644 });
    expect(statSync(f).mode & 0o777).toBe(0o644);
  } finally {
    process.umask(old);
  }
});

test("a failed write throws and leaves no temp", () => {
  const f = join(dir, "missing-dir", "x.json");
  expect(() => writeFileAtomic(f, "x")).toThrow();
  const target = join(dir, "is-a-dir");
  mkdirSync(target);
  expect(() => writeFileAtomic(target, "x")).toThrow();
  expect(readdirSync(dir).filter(n => n.includes(".tmp."))).toEqual([]);
});

test("the temp name carries pid and time the way the usage cleanup reads them", () => {
  const a = atomicTempPath(join(dir, "summary.json")).slice(dir.length + 1);
  const b = atomicTempPath(join(dir, "summary.json")).slice(dir.length + 1);
  expect(a.startsWith("summary.json.tmp.")).toBe(true);
  // Two writes in the same millisecond never share a temp.
  expect(a).not.toBe(b);
  // Ours: always an orphan to our own boot; someone else's fresh one: kept.
  expect(isOrphanTmp(a, process.pid, Date.now())).toBe(true);
  expect(isOrphanTmp(a, process.pid + 1, Date.now())).toBe(false);
});
