/**
 * A gate is worth something only once it has been seen RED. Here it is seen
 * red on each of the three shapes it exists for, and green on the three that
 * look like them and are not: a colour, an alignment, a relative size.
 *
 * The pure functions are called directly rather than spawning the script: the
 * scale is read from the real `index.css` in the runner, so driving it as a
 * process would only be able to prove the state of the repo today, which is
 * the one thing that is already green.
 * @covers GATE-14
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseScale, badSteps, findOffScale, type Step, collidingSteps } from "./check-typography";

const SCALE: Step[] = [
  { name: "nano", value: "9px" },
  { name: "mini", value: "11px" },
  { name: "body", value: "13px" },
];

describe("check:typography", () => {
  test("an absolute size written by hand is red", () => {
    const hits = findOffScale('<p className="text-[12.5px]">x</p>', "f.tsx", SCALE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.found).toBe("text-[12.5px]");
    expect(hits[0]!.line).toBe(1);
  });

  test("every absolute unit is caught, not just px", () => {
    const hits = findOffScale('a text-[0.8rem] b text-[9pt] c', "f.tsx", SCALE);
    expect(hits.map((h) => h.found)).toEqual(["text-[0.8rem]", "text-[9pt]"]);
  });

  test("a switched-off Tailwind step is red, with its variants", () => {
    const hits = findOffScale('<p className="text-xs md:text-2xl">x</p>', "f.tsx", SCALE);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.why).toContain("generates nothing");
  });

  test("colours, alignments and relative sizes stay green", () => {
    const src = '<p className="text-app-text-muted text-center text-[0.92em] text-red-500/60 text-mini">x</p>';
    expect(findOffScale(src, "f.tsx", SCALE)).toHaveLength(0);
  });

  test("a step that Tailwind also names is not reported as dead", () => {
    // If the scale itself ever declares `--text-sm`, that class is alive again.
    const hits = findOffScale('<p className="text-sm">x</p>', "f.tsx", [...SCALE, { name: "sm", value: "14px" }]);
    expect(hits).toHaveLength(0);
  });

  test("a half-pixel step, and one under the floor, are red", () => {
    const bad = badSteps([{ name: "half", value: "10.5px" }, { name: "tiny", value: "7px" }, { name: "ok", value: "11px" }]);
    expect(bad).toHaveLength(2);
    expect(bad[0]!.why).toContain("half a pixel");
  });

  test("a step that is not a length at all is red", () => {
    expect(badSteps([{ name: "weird", value: "1rem" }])).toHaveLength(1);
  });

  test("the real scale parses, and every one of its steps is a whole pixel", () => {
    const css = readFileSync(resolve(import.meta.dir, "..", "client/src/index.css"), "utf8");
    const steps = parseScale(css);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(badSteps(steps)).toEqual([]);
    expect(steps.map((s) => s.name)).toContain("mini");
  });
});

describe("collidingSteps", () => {
  const SCALE: Step[] = [{ name: "prose", value: "13px" }, { name: "mini", value: "11px" }];

  test("catches a step whose name is already a text colour in the same file", () => {
    // The real shape: the scale declares it inside `@theme`, and the palette
    // declares it again further down, where it wins.
    const css = "@theme {\n  --text-prose: 13px;\n  --text-mini: 11px;\n}\n:root {\n  --text-prose: #bbbec5;\n}\n";
    const found = collidingSteps(css, SCALE);
    expect(found).toHaveLength(1);
    expect(found[0]!.found).toBe("--text-prose");
  });

  test("says nothing when the two namespaces do not overlap", () => {
    const css = "@theme {\n  --text-prose: 13px;\n  --text-mini: 11px;\n}\n:root {\n  --text-heading: #ccced4;\n}\n";
    expect(collidingSteps(css, SCALE)).toEqual([]);
  });

  test("does not accuse a step of colliding with its own declaration", () => {
    const css = "@theme {\n  --text-prose: 13px;\n  --text-mini: 11px;\n}\n";
    expect(collidingSteps(css, SCALE)).toEqual([]);
  });
});
