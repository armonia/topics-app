/**
 * The gate that picks the e2e specs of a change has its own gate.
 *
 * Two failure modes, and they are opposite: pick TOO MANY (the gate becomes the
 * suite and gets switched off) or pick the wrong ones (the gate is green while
 * the spec that measures the change never runs). Both happened while writing
 * it: the first selection linked 5 changed files to 75 specs on tokens like
 * "famil", and the second put eight specs of other features in front of the
 * one that had actually gone red.
 */
import { describe, expect, test } from "bun:test";
import { areaTokens, selectSpecs, testIdsOf } from "./check-e2e-touched.ts";

const spec = (file: string, text: string) => ({ file: `tests/e2e/${file}`, text });

describe("testIdsOf", () => {
  test("reads the three places a testid is declared, prefix included", () => {
    const ids = testIdsOf(`
      <div data-testid="pane-add-menu" />
      <b data-testid={"identity-row-me"} />
      const row = { testId: \`pane-add-menu-\${agent}\` };
      page.getByTestId("sidebar-board-generale");
    `);
    expect(ids).toContain("pane-add-menu");
    expect(ids).toContain("identity-row-me");
    expect(ids).toContain("pane-add-menu");
    expect(ids).toContain("sidebar-board-generale");
  });

  test("ignores prose and short tokens", () => {
    // `famil${...}` in a sentence is what selected 75 specs on the first run.
    const ids = testIdsOf('const msg = `famil${n === 1 ? "y" : "ies"}`; <i data-testid="ab" />');
    expect(ids).toEqual([]);
  });
});

describe("areaTokens", () => {
  test("the folder and the module name, when they are worth a match", () => {
    expect(areaTokens("client/src/components/Sidebar/TopicItem.tsx")).toEqual(["sidebar", "topicitem"]);
    // `lib` is too short to be a surface: it would match nothing useful.
    expect(areaTokens("client/src/lib/selectionStyles.ts")).toEqual(["selectionstyles"]);
  });
});

describe("selectSpecs", () => {
  const all = [
    spec("sidebar-chevron-column.spec.ts", 'page.locator(\'[role="tree"]\')'),
    spec("share-project.spec.ts", 'getByTestId("project-share")'),
    spec("add-menu.spec.ts", 'import { TERMINAL_AGENT_TYPES } from "../../shared/terminal-session-types";'),
  ];

  test("a changed spec is its own reason to run", () => {
    const picked = selectSpecs(["tests/e2e/add-menu.spec.ts"], all);
    expect(picked.map((p) => p.file)).toEqual(["tests/e2e/add-menu.spec.ts"]);
  });

  test("a file nobody imports and no spec names selects nothing", () => {
    expect(selectSpecs(["docs/whatever.md", "package.json"], all)).toEqual([]);
  });

  test("the area beats a passing testid mention", () => {
    // Both files exist in the repo; the sidebar spec names no testid at all, so
    // only the area can link it, and it has to come first.
    const picked = selectSpecs(["client/src/components/Sidebar/TopicItem.tsx"], all);
    expect(picked[0]?.file).toBe("tests/e2e/sidebar-chevron-column.spec.ts");
  });
});
