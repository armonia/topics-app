/**
 * The native `glob` is a read-only tool, allowed even in «ask» mode: it must
 * list files and do nothing else. These cases pin the three things the old
 * `bash -lc` version got wrong: a pattern ran as a command, `..` left the
 * workspace, and `**` was not recursive on macOS bash 3.2.
 *
 * @covers RT-07, RT-11
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./tools";
import { globFiles } from "./glob-files";

let base: string;
let ws: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "native-glob-"));
  ws = join(base, "ws");
  for (const rel of [
    "a.ts", ".hidden.ts", "README.md",
    "src/b.ts", "src/deep/c.ts", "src/deep/d.md",
    "lib/e.ts",
    "build/gen.ts",
    "node_modules/pkg/index.ts",
    ".git/HEAD",
  ]) {
    mkdirSync(join(ws, rel, ".."), { recursive: true });
    writeFileSync(join(ws, rel), "x\n");
  }
  writeFileSync(join(base, "outside.ts"), "x\n");
  mkdirSync(join(base, "elsewhere"));
  writeFileSync(join(base, "elsewhere", "secret.ts"), "needle\n");
  // A folder of the workspace that is a link out of it.
  symlinkSync(join(base, "elsewhere"), join(ws, "out"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const glob = (pattern: string, path?: string) =>
  executeTool("glob", { pattern, ...(path ? { path } : {}) }, { workspace: ws });

describe("native glob runs no shell", () => {
  test("a command substitution in the pattern runs nothing", async () => {
    const marker = join(base, "pwned");
    for (const pattern of [`$(touch ${marker})`, `\`touch ${marker}\``, `*; touch ${marker}`]) {
      await glob(pattern);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("`..` and absolute patterns are refused, never listed", async () => {
    for (const pattern of ["../*.ts", "src/../../*.ts", join(base, "*.ts"), "~/*"]) {
      const r = await glob(pattern);
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("outside.ts");
    }
  });
});

describe("native search roots follow links before they are checked", () => {
  test("a linked folder out of the workspace is refused, as the pattern head or as `path`", async () => {
    for (const r of [await glob("out/*"), await glob("out/**/*.ts"), await glob("*", join(ws, "out"))]) {
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("secret.ts");
    }
  });

  test("a wildcard lists the link by name and never enters it", async () => {
    const r = await glob("**/*");
    expect(r.content.split("\n")).toContain("out");
    expect(r.content).not.toContain("secret.ts");
  });

  test("grep refuses the same link as `path`", async () => {
    const r = await executeTool("grep", { pattern: "needle", path: "out" }, { workspace: ws });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("secret.ts");
  });
});

describe("native glob matches like globstar", () => {
  test("`**` is recursive and includes the root level and dotfiles", async () => {
    const r = await glob("**/*.ts");
    expect(r.content.split("\n")).toEqual([".hidden.ts", "a.ts", "lib/e.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  test("a pattern without `**` matches at exactly its depth", async () => {
    expect((await glob("*.ts")).content.split("\n")).toEqual([".hidden.ts", "a.ts"]);
    expect((await glob("src/*.ts")).content).toBe("src/b.ts");
    expect((await glob("*/*.ts")).content.split("\n")).toEqual(["lib/e.ts", "src/b.ts"]);
    expect((await glob("{src,lib}/**/*.ts")).content.split("\n")).toEqual(["lib/e.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  test("dependency and git folders are walked only when the pattern names them", async () => {
    expect((await glob("**/*.ts")).content).not.toContain("node_modules");
    expect((await glob("node_modules/**/*.ts")).content).toBe("node_modules/pkg/index.ts");
    expect((await glob("**/HEAD")).content).toBe("nessun file");
    expect((await glob(".git/*")).content).toBe(".git/HEAD");
    expect((await glob("{build,lib}/*.ts")).content.split("\n")).toEqual(["build/gen.ts", "lib/e.ts"]);
  });

  test("a pattern ending in `/` lists folders", async () => {
    expect((await glob("src/*/")).content).toBe("src/deep/");
  });

  test("`path` moves the root and results stay relative to it", async () => {
    expect((await glob("**/*.md", join(ws, "src"))).content).toBe("deep/d.md");
  });
});

describe("globFiles bounds", () => {
  test("a cancelled walk says so instead of answering «no files»", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await globFiles(ws, "**/*", { signal: ac.signal });
    expect(r.ok).toBe(false);
  });

  test("a walk past maxEntries stops and says so", async () => {
    const r = await globFiles(ws, "**/*", { maxEntries: 3 });
    expect(r.ok && r.truncated).toBe(true);
  });

  test("maxResults caps the matches", async () => {
    const r = await globFiles(ws, "**/*.ts", { maxResults: 2 });
    expect(r.ok && r.files.length).toBe(2);
    expect(r.ok && r.truncated).toBe(true);
  });
});

describe("native grep takes the pattern as a pattern", () => {
  test("a pattern starting with `-` searches for it instead of becoming an option", async () => {
    writeFileSync(join(ws, "flags.txt"), "use -v here\n");
    const r = await executeTool("grep", { pattern: "-v here" }, { workspace: ws });
    expect(r.content).toContain("flags.txt");
  });
});
