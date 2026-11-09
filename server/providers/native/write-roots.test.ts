import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeTool } from "./tools";
import { writeRootsFor } from "./write-roots";

let base: string;
let workspace: string;
let allowed: string;
let closed: string;
let config: string;
const savedDir = process.env.APP_DATA_DIR;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "write-roots-"));
  workspace = join(base, "ws");
  allowed = join(base, "allowed");
  closed = join(base, "closed");
  for (const d of [workspace, allowed, closed]) mkdirSync(d, { recursive: true });
  process.env.APP_DATA_DIR = join(base, "data");
  mkdirSync(process.env.APP_DATA_DIR, { recursive: true });
  config = join(process.env.APP_DATA_DIR, "native-write-roots.json");
  writeFileSync(config, JSON.stringify({ [workspace]: [allowed, "/"] }));
});

afterAll(() => {
  if (savedDir === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = savedDir;
  rmSync(base, { recursive: true, force: true });
});

describe("write roots", () => {
  test("writes inside a declared root, creating folders", async () => {
    const target = join(allowed, "sub", "a.txt");
    const out = await executeTool("write_file", { path: target, content: "hi" }, { workspace });
    expect(out.isError).toBeUndefined();
    expect(readFileSync(target, "utf-8")).toBe("hi");
  });

  test("edit_file follows the same roots", async () => {
    const target = join(allowed, "b.txt");
    writeFileSync(target, "one");
    const out = await executeTool("edit_file", { path: target, old: "one", new: "two" }, { workspace });
    expect(out.isError).toBeUndefined();
    expect(readFileSync(target, "utf-8")).toBe("two");
  });

  test("a folder not listed stays closed", async () => {
    const out = await executeTool("write_file", { path: join(closed, "x.txt"), content: "no" }, { workspace });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("fuori dalla workspace");
  });

  test("a sibling sharing the prefix of a root stays closed", async () => {
    const sibling = `${allowed}-other`;
    mkdirSync(sibling, { recursive: true });
    const out = await executeTool("write_file", { path: join(sibling, "x.txt"), content: "no" }, { workspace });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("fuori dalla workspace");
  });

  test("the filesystem root is ignored, other workspaces get nothing", () => {
    expect(writeRootsFor(workspace, config)).toEqual([allowed]);
    expect(writeRootsFor(join(base, "other"), config)).toEqual([]);
  });

  test("a missing config means no extra roots", () => {
    expect(writeRootsFor(workspace, join(base, "none.json"))).toEqual([]);
  });
});
