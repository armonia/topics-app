/**
 * The board workflow as pure rules: the one preset, the column of a card, who
 * waits on a person, and the rows a database may still hold from the removed
 * `armonia` preset.
 *
 * @covers KANBAN-102
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PERSON_PATHS,
  STAGE_CI,
  WORKFLOW_PRESETS,
  awaitsHuman,
  awaitsHumanSql,
  columnOfTask,
  parsePersonPaths,
  personPathsFromText,
  personPathsToText,
  resolveWorkflow,
  resolveWorkflowRules,
} from "./workflow";

describe("resolveWorkflow", () => {
  test("with no row the columns are the five of before, plus the CI phase that only named cards enter", () => {
    const wf = resolveWorkflow({});
    expect(wf.preset).toBe("default");
    expect(wf.source).toBe("default");
    expect(wf.columns.map((c) => c.id)).toEqual(["backlog", "todo", "in_progress", "review", "ci", "done"]);
    expect(wf.columns.filter((c) => c.id !== STAGE_CI).every((c) => c.id === c.base)).toBe(true);
    // A card with no stage never lands in CI: its review stays the review of before.
    expect(columnOfTask(wf.columns, { status: "review" })?.id).toBe("review");
    expect(columnOfTask(wf.columns, { status: "review", stage: STAGE_CI })?.id).toBe(STAGE_CI);
  });

  test("a card in the CI phase waits on nobody", () => {
    expect(awaitsHuman({ status: "review", stage: STAGE_CI })).toBe(false);
    expect(awaitsHuman({ status: "review", stage: null })).toBe(true);
    expect(awaitsHuman({ status: "in_progress" })).toBe(false);
    expect(awaitsHumanSql(true)).toContain(`'${STAGE_CI}'`);
  });

  test("the default is the only preset", () => {
    expect(Object.keys(WORKFLOW_PRESETS)).toEqual(["default"]);
  });

  // A production database may still hold an `armonia` row (the preset was
  // removed): it must read as no row, without errors.
  test("a row that still says armonia, in the project or global scope, reads as the default", () => {
    expect(resolveWorkflow({ project: "armonia" })).toMatchObject({ preset: "default", source: "default" });
    expect(resolveWorkflow({ global: "armonia" })).toMatchObject({ preset: "default", source: "default" });
    expect(resolveWorkflow({ project: "armonia", global: "armonia" }).columns).toBe(WORKFLOW_PRESETS.default);
  });

  test("an unknown preset id falls through, it does not break the board", () => {
    expect(resolveWorkflow({ project: "nope", global: "default" })).toMatchObject({ preset: "default", source: "global" });
    expect(resolveWorkflow({ project: "nope", global: "nope" }).preset).toBe("default");
  });
});

describe("columnOfTask", () => {
  test("a card with no stage sits in the default column of its status", () => {
    const cols = WORKFLOW_PRESETS.default;
    expect(columnOfTask(cols, { status: "review" })?.id).toBe("review");
    expect(columnOfTask(cols, { status: "backlog" })?.id).toBe("backlog");
    expect(columnOfTask(cols, { status: "todo", stage: null })?.id).toBe("todo");
  });

  test("a stage the status contradicts, or the workflow does not have, is ignored", () => {
    const cols = WORKFLOW_PRESETS.default;
    expect(columnOfTask(cols, { status: "todo", stage: STAGE_CI })?.id).toBe("todo");
    // A stage of a removed workflow: the card stays in the column of its status.
    for (const stage of ["ai_review", "human_review", "triage"]) {
      expect(columnOfTask(cols, { status: "review", stage })?.id).toBe("review");
      expect(awaitsHuman({ status: "review", stage })).toBe(true);
    }
  });
});

describe("resolveWorkflowRules: the CI switch inherits, the paths add up", () => {
  test("no rows: CI phase on, no board paths", () => {
    expect(resolveWorkflowRules({})).toEqual({ ciPhase: true, personPaths: [] });
  });
  test("the project's switch wins over the global one; null inherits", () => {
    expect(resolveWorkflowRules({ global: { ciPhase: false } }).ciPhase).toBe(false);
    expect(resolveWorkflowRules({ global: { ciPhase: false }, project: { ciPhase: true } }).ciPhase).toBe(true);
    expect(resolveWorkflowRules({ global: { ciPhase: false }, project: { ciPhase: null } }).ciPhase).toBe(false);
  });
  test("the global paths come first, then the project's", () => {
    const g = { pattern: "a/**", why: "g" }; const p = { pattern: "b/**", why: "p" };
    expect(resolveWorkflowRules({ global: { personPaths: [g] }, project: { personPaths: [p] } }).personPaths).toEqual([g, p]);
  });
});

describe("person paths as text and as data", () => {
  test("one per line, `pattern # why`; blank and comment lines skipped; no why = this board", () => {
    const paths = personPathsFromText("client/src/** # interfaccia\n\n# a note\n  scripts/**  \n");
    expect(paths).toEqual([{ pattern: "client/src/**", why: "interfaccia" }, { pattern: "scripts/**", why: "this board" }]);
    expect(personPathsFromText(personPathsToText(paths))).toEqual(paths);
  });
  test("a list that is not one is refused, not read as empty", () => {
    expect(parsePersonPaths([{ pattern: "a/**", why: "x" }])).toEqual([{ pattern: "a/**", why: "x" }]);
    expect(parsePersonPaths("a/**")).toBeNull();
    expect(parsePersonPaths([{ pattern: "", why: "x" }])).toBeNull();
    expect(parsePersonPaths(Array.from({ length: MAX_PERSON_PATHS + 1 }, () => ({ pattern: "a", why: "b" })))).toBeNull();
  });
});

