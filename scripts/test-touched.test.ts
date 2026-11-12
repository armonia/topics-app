/**
 * The selector of `test:touched` has its own gate.
 *
 * Its failure mode is silent: a missing edge in the import graph means a test
 * that should have run does not, and the branch is green locally. So the
 * transitive case, the fallback and a mutant on the graph are all pinned.
 */
import { describe, expect, test } from "bun:test";
import { buildGraph, pathLiterals, resolveSpecifier, selectTests, specifiersOf, treeWalkers } from "./test-touched.ts";

const SOURCES: Record<string, string> = {
  "shared/leaf.ts": "export const leaf = 1;",
  "shared/mid.ts": 'import { leaf } from "./leaf";\nexport const mid = leaf;',
  "server/top.ts": 'import { mid } from "../shared/mid.ts";\nexport const top = mid;',
  "server/top.test.ts": 'import { top } from "./top";',
  "server/lazy.test.ts": 'const m = await import("../shared/leaf.js");',
  "server/mocked.test.ts": 'mock.module("../shared/mid", () => ({}));',
  "server/alone.ts": "export const alone = 1;",
  "server/alone.test.ts": 'import { alone } from "./alone";',
  "client/src/ui/x.ts": "export const x = 1;",
  "client/src/ui/x.test.ts": 'import { x } from "@/ui/x";',
  "server/lib/reader.ts": "export const reader = 1;",
  "tests/unit/reads-text.test.ts": 'readFileSync(join(ROOT, "server", "lib", "reader.ts"), "utf8");',
  "tests/unit/reads-path.test.ts": 'readFileSync("shared/leaf.ts", "utf8");',
  "tests/unit/walks-tree.test.ts": 'Bun.spawnSync(["git", "ls-files"]);',
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
  test("MUTANT: a graph that loses the transitive edge is caught by the assertion above", () => {
    const broken = graph();
    broken.get("shared/mid.ts")!.clear();
    const selection = selectTests(["shared/leaf.ts"], broken, suite);
    expect(selection).not.toEqual({ kind: "tests", tests: ["server/lazy.test.ts", "server/mocked.test.ts", "server/top.test.ts", "tests/unit/reads-path.test.ts"] });
  });
});
