/**
 * @covers GATE-01
 *
 * The selector of `test:touched` has its own gate.
 *
 * Its failure mode is silent: a missing edge in the import graph means a test
 * that should have run does not, and the branch is green locally. So the
 * transitive case, the fallback and a mutant on the graph are all pinned.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_ROOTS, buildGraph, changedFiles, pathLiterals, resolveSpecifier, selectTests, specifiersOf, treeWalkers } from "./test-touched.ts";

// Spelled in two pieces so the module-mock scan does not read the fixture as a real mock.
const MOCK_CALL = "mock." + "module";

const SOURCES: Record<string, string> = {
  "shared/leaf.ts": "export const leaf = 1;",
  "shared/mid.ts": 'import { leaf } from "./leaf";\nexport const mid = leaf;',
  "server/top.ts": 'import { mid } from "../shared/mid.ts";\nexport const top = mid;',
  "server/top.test.ts": 'import { top } from "./top";',
  "server/lazy.test.ts": 'const m = await import("../shared/leaf.js");',
  "server/mocked.test.ts": `${MOCK_CALL}("../shared/mid", () => ({}));`,
  "server/alone.ts": "export const alone = 1;",
  "server/alone.test.ts": 'import { alone } from "./alone";',
  "client/src/ui/x.ts": "export const x = 1;",
  "client/src/ui/x.test.ts": 'import { x } from "@/ui/x";',
  "server/lib/reader.ts": "export const reader = 1;",
  "tests/unit/reads-text.test.ts": 'readFileSync(join(ROOT, "server", "lib", "reader.ts"), "utf8");',
  "tests/unit/reads-path.test.ts": 'readFileSync("shared/leaf.ts", "utf8");',
  "tests/unit/walks-tree.test.ts": 'Bun.spawnSync(["git", "ls-files"]);',
  "tests/e2e/helper.ts": "export const helper = 1;",
  "tests/unit/uses-e2e-helper.test.ts": 'import { helper } from "../e2e/helper";',
  "package.json": "{}",
  "bun.lock": "",
  "bunfig.toml": "",
  "tsconfig.server.json": "{}",
  "knip.jsonc": "{}",
  "tests/setup/bun-test-preload.ts": "export {};",
  "shared/types.ts": "export type T = 1;",
};
const files = Object.keys(SOURCES);
const suite = new Set(files.filter((f) => f.endsWith(".test.ts")));
const graph = () => buildGraph(files, (f) => SOURCES[f]);
const walkers = treeWalkers(files, (f) => SOURCES[f]);

describe("specifiersOf / resolveSpecifier", () => {
  test("reads static, dynamic and mocked specifiers", () => {
    expect(specifiersOf(SOURCES["server/lazy.test.ts"])).toEqual(["../shared/leaf.js"]);
    expect(specifiersOf(SOURCES["server/mocked.test.ts"])).toEqual(["../shared/mid"]);
  });
  test("resolves the client alias and the .js to .ts spelling", () => {
    const has = (f: string) => files.includes(f);
    expect(resolveSpecifier("@/ui/x", "client/src/a.ts", has)).toBe("client/src/ui/x.ts");
    expect(resolveSpecifier("../shared/leaf.js", "server/lazy.test.ts", has)).toBe("shared/leaf.ts");
    expect(resolveSpecifier("zod", "server/a.ts", has)).toBeNull();
  });
});

describe("selectTests", () => {
  test("a changed module selects its tests and those of everything importing it, transitively", () => {
    const selection = selectTests(["shared/leaf.ts"], graph(), suite);
    expect(selection).toEqual({ kind: "tests", tests: ["server/lazy.test.ts", "server/mocked.test.ts", "server/top.test.ts", "tests/unit/reads-path.test.ts"] });
  });
  test("a test that reads a file as text is linked to it by the path literal", () => {
    expect(pathLiterals(SOURCES["tests/unit/reads-text.test.ts"], files)).toEqual(new Set(["server/lib/reader.ts"]));
    expect(selectTests(["server/lib/reader.ts"], graph(), suite)).toEqual({ kind: "tests", tests: ["tests/unit/reads-text.test.ts"] });
  });
  test("a test that walks the tree runs on any code change", () => {
    expect(walkers).toEqual(new Set(["tests/unit/walks-tree.test.ts"]));
    const selection = selectTests(["server/alone.ts"], graph(), suite, () => false, walkers);
    expect(selection).toEqual({ kind: "tests", tests: ["server/alone.test.ts", "tests/unit/walks-tree.test.ts"] });
  });
  test("a changed test selects itself and nothing else", () => {
    expect(selectTests(["server/alone.test.ts"], graph(), suite)).toEqual({ kind: "tests", tests: ["server/alone.test.ts"] });
  });
  test("an unrelated module does not drag in other tests", () => {
    expect(selectTests(["server/alone.ts"], graph(), suite)).toEqual({ kind: "tests", tests: ["server/alone.test.ts"] });
  });
  test("a changed module under tests/e2e selects the unit tests that import it", () => {
    expect(GRAPH_ROOTS).toContain("tests/e2e");
    expect(selectTests(["tests/e2e/helper.ts"], graph(), suite)).toEqual({ kind: "tests", tests: ["tests/unit/uses-e2e-helper.test.ts"] });
  });
  test("code outside the import graph runs the whole suite instead of being skipped", () => {
    for (const file of ["landing/src/page.ts", "desktop-tauri/build.mjs", "scripts/not-in-graph.ts"]) expect(selectTests([file], graph(), suite).kind).toBe("full");
  });
  test("docs select nothing", () => {
    expect(selectTests(["README.md"], graph(), suite)).toEqual({ kind: "tests", tests: [] });
  });
  test.each(["package.json", "bun.lock", "bunfig.toml", "tsconfig.server.json", "tests/setup/bun-test-preload.ts", "shared/types.ts", "knip.jsonc"])("%s falls back to the whole suite", (file) => {
    expect(selectTests([file], graph(), suite).kind).toBe("full");
  });
  test("an unknown data file falls back to the whole suite, a deleted one does not", () => {
    expect(selectTests([".github/workflows/ci.yml"], graph(), suite).kind).toBe("full");
    expect(selectTests([".github/workflows/old.yml"], graph(), suite, () => true).kind).toBe("tests");
  });
  test("MUTANT: the real selector with its reverse walk removed misses what the original finds", async () => {
    const original = await Bun.file(join(import.meta.dir, "test-touched.ts")).text();
    const walk = "for (const parent of reverse.get(cur) ?? []) stack.push(parent);";
    expect(original).toContain(walk);
    const mutantPath = join(import.meta.dir, `test-touched.mutant-${process.pid}.tmp.ts`);
    writeFileSync(mutantPath, original.replace(walk, ""));
    try {
      const mutant = (await import(mutantPath)) as typeof import("./test-touched.ts");
      const expected = ["server/lazy.test.ts", "server/mocked.test.ts", "server/top.test.ts", "tests/unit/reads-path.test.ts"];
      expect(selectTests(["shared/leaf.ts"], graph(), suite)).toEqual({ kind: "tests", tests: expected });
      expect(mutant.selectTests(["shared/leaf.ts"], graph(), suite)).not.toEqual({ kind: "tests", tests: expected });
    } finally {
      rmSync(mutantPath, { force: true });
    }
  });
});

describe("changedFiles", () => {
  test("lists committed changes since the merge base plus untracked files, not what main already had", () => {
    const dir = mkdtempSync(join(tmpdir(), "touched-git-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "old.ts"), "export {};");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "work");
      writeFileSync(join(dir, "old.ts"), "export const a = 1;");
      git("commit", "-q", "-am", "edit");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "fresh.ts"), "export {};");
      expect(changedFiles("main", dir)).toEqual(["old.ts", "sub/fresh.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("a base that cannot be resolved falls back to the whole suite and says so", () => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "test-touched.ts"), "--list", "--base", "refs/heads/no-such-base-ref"]);
    expect(r.stdout.toString().trim()).toBe("(whole suite)");
    expect(r.stderr.toString()).toContain("running the whole suite");
  });
});
