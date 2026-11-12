/**
 * @covers NATIVE-WRITE-ROOTS-01
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { insideAnyRoot, loadWriteRoots } from "./write-roots";
import { executeTool } from "./tools";

let dir: string;
// "Outside" must be outside the scratch folders too: `dir` lives under the OS
// temp dir, and a write there is allowed (`temp-roots.ts`), so the refusals
// below aim at the home folder, where nothing may be created.
const OUTSIDE = join(homedir(), ".cache", "write-roots-test-never-created");
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "write-roots-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadWriteRoots", () => {
  test("returns the roots declared for the workspace only", () => {
    const file = join(dir, "roots.json");
    writeFileSync(file, JSON.stringify({ [join(dir, "ws")]: [join(dir, "a")], [join(dir, "other")]: [join(dir, "b")] }));
    expect(loadWriteRoots(join(dir, "ws"), file)).toEqual([resolve(dir, "a")]);
  });
  test("missing or malformed file means no roots", () => {
    expect(loadWriteRoots(dir, join(dir, "nope.json"))).toEqual([]);
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    expect(loadWriteRoots(dir, file)).toEqual([]);
  });
  test("a filesystem root is not accepted", () => {
    const file = join(dir, "roots.json");
    writeFileSync(file, JSON.stringify({ [dir]: [resolve("/")] }));
    expect(loadWriteRoots(dir, file)).toEqual([]);
  });
});

describe("insideAnyRoot", () => {
  test("accepts children, rejects siblings with a shared prefix and parents", () => {
    const root = join(dir, "proj");
    expect(insideAnyRoot(join(root, "x", "y.txt"), [root])).toBe(true);
    expect(insideAnyRoot(join(dir, "proj-other", "y.txt"), [root])).toBe(false);
    expect(insideAnyRoot(join(dir, "y.txt"), [root])).toBe(false);
  });
});

describe("write_file with declared roots", () => {
  test("outside and undeclared stays refused", async () => {
    const ws = join(dir, "ws");
    mkdirSync(ws);
    const target = join(OUTSIDE, "elsewhere", "f.txt");
    const r = await executeTool("write_file", { path: target, content: "x" }, { workspace: ws });
    expect(r.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

describe("write_file and edit_file into a declared root", () => {
  test("allowed inside the root, refused next to it", async () => {
    const ws = join(dir, "ws");
    const root = join(dir, "declared");
    mkdirSync(ws);
    const prev = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = join(dir, "data");
    try {
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data", "native-write-roots.json"), JSON.stringify({ [ws]: [root] }));
      const ok = await executeTool("write_file", { path: join(root, "sub", "f.txt"), content: "one" }, { workspace: ws });
      expect(ok.isError).toBeFalsy();
      const ed = await executeTool("edit_file", { path: join(root, "sub", "f.txt"), old: "one", new: "two" }, { workspace: ws });
      expect(ed.isError).toBeFalsy();
      const no = await executeTool("write_file", { path: join(OUTSIDE, "declared-x", "f.txt"), content: "x" }, { workspace: ws });
      expect(no.isError).toBe(true);
      // Next to the declared root, still under the temp dir: allowed since the
      // scratch folders are open to every workspace, with or without a root.
      const scratch = await executeTool("write_file", { path: join(dir, "declared-x", "f.txt"), content: "x" }, { workspace: ws });
      expect(scratch.isError).toBeFalsy();
    } finally {
      if (prev === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = prev;
    }
  });
});
