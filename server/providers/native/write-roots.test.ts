import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { WRITE_ROOTS_FILE, isInWriteRoot, readWriteRoots } from "./write-roots";

let base: string;
let workspace: string;
let allowed: string;
let other: string;
let dataDir: string;

function writeConfig(roots: unknown, key = workspace) {
  writeFileSync(join(dataDir, WRITE_ROOTS_FILE), JSON.stringify({ [key]: roots }));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "write-roots-"));
  workspace = join(base, "ws");
  allowed = join(base, "allowed");
  other = join(base, "other");
  dataDir = join(base, "data");
  for (const d of [workspace, allowed, other, dataDir]) mkdirSync(d);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("write roots", () => {
  test("no file means no roots", () => {
    expect(readWriteRoots(workspace, dataDir)).toEqual([]);
    expect(isInWriteRoot(workspace, join(allowed, "a.txt"), dataDir)).toBe(false);
  });

  test("a declared root allows paths inside it, new files included", () => {
    writeConfig([allowed]);
    expect(isInWriteRoot(workspace, join(allowed, "a.txt"), dataDir)).toBe(true);
    expect(isInWriteRoot(workspace, join(allowed, "new", "deep", "a.txt"), dataDir)).toBe(true);
  });

  test("anything not declared stays closed, sibling prefixes included", () => {
    writeConfig([allowed]);
    expect(isInWriteRoot(workspace, join(other, "a.txt"), dataDir)).toBe(false);
    expect(isInWriteRoot(workspace, `${allowed}-evil/a.txt`, dataDir)).toBe(false);
    expect(isInWriteRoot(workspace, join(allowed, "..", "other", "a.txt"), dataDir)).toBe(false);
  });

  test("roots are per workspace", () => {
    writeConfig([allowed], join(base, "another-ws"));
    expect(isInWriteRoot(workspace, join(allowed, "a.txt"), dataDir)).toBe(false);
  });

  test("too wide or relative roots are dropped", () => {
    writeConfig(["/", homedir(), "relative/dir", 42, allowed]);
    expect(readWriteRoots(workspace, dataDir)).toEqual([allowed]);
  });

  test("malformed file means no roots", () => {
    writeFileSync(join(dataDir, WRITE_ROOTS_FILE), "{ nope");
    expect(readWriteRoots(workspace, dataDir)).toEqual([]);
  });

  test("a symlink inside a root that points outside is refused", () => {
    writeConfig([allowed]);
    try {
      symlinkSync(other, join(allowed, "link"), "junction");
    } catch {
      return;
    }
    expect(isInWriteRoot(workspace, join(allowed, "link", "a.txt"), dataDir)).toBe(false);
  });
});
