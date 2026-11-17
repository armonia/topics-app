/**
 * The board workflow as pure rules: the one set of columns, the column of a
 * card, who waits on a person.
 *
 * @covers KANBAN-102
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PERSON_PATHS,
  STAGE_CI,
  WORKFLOW_COLUMNS,
  awaitsHuman,
  awaitsHumanSql,
  columnOfTask,
  parseCiPhase,
  parsePersonPaths,
  personPathsFromText,
  personPathsToText,
  resolveWorkflowRules,
} from "./workflow";

describe("the columns", () => {
  test("the five of before, plus the CI phase that only named cards enter", () => {
    const wf = { columns: WORKFLOW_COLUMNS };
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
});

describe("columnOfTask", () => {
  test("a card with no stage sits in the default column of its status", () => {
    const cols = WORKFLOW_COLUMNS;
    expect(columnOfTask(cols, { status: "review" })?.id).toBe("review");
    expect(columnOfTask(cols, { status: "backlog" })?.id).toBe("backlog");
    expect(columnOfTask(cols, { status: "todo", stage: null })?.id).toBe("todo");
  });

  test("a stage the status contradicts, or the workflow does not have, is ignored", () => {
    const cols = WORKFLOW_COLUMNS;
    expect(columnOfTask(cols, { status: "todo", stage: STAGE_CI })?.id).toBe("todo");
    // A stage of a removed workflow: the card stays in the column of its status.
    for (const stage of ["ai_review", "human_review", "triage"]) {
      expect(columnOfTask(cols, { status: "review", stage })?.id).toBe("review");
      expect(awaitsHuman({ status: "review", stage })).toBe(true);
    }
  });
});

describe("resolveWorkflowRules: the CI switch inherits, the paths add up", () => {
  test("no rows: the CI measures after the land, no board paths", () => {
    expect(resolveWorkflowRules({})).toEqual({ ciPhase: "after", personPaths: [] });
  });
  test("the project's mode wins over the global one; null inherits", () => {
    expect(resolveWorkflowRules({ global: { ciPhase: "off" } }).ciPhase).toBe("off");
    expect(resolveWorkflowRules({ global: { ciPhase: "off" }, project: { ciPhase: "before" } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ global: { ciPhase: "before" }, project: { ciPhase: null } }).ciPhase).toBe("before");
  });
  test("the three modes read as themselves, the old booleans as before and off", () => {
    expect(resolveWorkflowRules({ project: { ciPhase: "before" } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ project: { ciPhase: "after" } }).ciPhase).toBe("after");
    expect(resolveWorkflowRules({ project: { ciPhase: "off" } }).ciPhase).toBe("off");
    expect(resolveWorkflowRules({ project: { ciPhase: true } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ project: { ciPhase: false } }).ciPhase).toBe("off");
    // A value nobody knows inherits instead of switching the CI off by accident.
    expect(resolveWorkflowRules({ global: { ciPhase: "before" }, project: { ciPhase: "later" as never } }).ciPhase).toBe("before");
    expect(parseCiPhase("later")).toBeNull();
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

