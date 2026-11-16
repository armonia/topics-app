/**
 * @covers GATE-02
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The scope of the "solido" index lives in spec-flow.completeness.json (mutation.tierA). The
// Mutation workflow only starts on a PR whose paths match its filter: a target added to the
// config but not to the filter is measured at night, while a PR that weakens it runs nothing,
// and you find out the next morning on a red main.
const root = new URL("..", import.meta.url);
const tierA = JSON.parse(readFileSync(new URL("spec-flow.completeness.json", root), "utf8")).mutation.tierA;
const workflow = readFileSync(new URL(".github/workflows/mutation.yml", root), "utf8");
const globs = [...workflow.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
const covers = (file: string) =>
  globs.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(file));

test("every mutation target and its tests start the Mutation workflow on a PR", () => {
  const files: string[] = [...tierA.targets, ...tierA.tests, "spec-flow.completeness.json", "stryker.config.mjs"];
  expect(files.filter((f) => !covers(f))).toEqual([]);
});

test("the filter reads as written: a file outside every glob is not covered", () => {
  expect(covers("server/services/tasks.ts")).toBe(false);
});
