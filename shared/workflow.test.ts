import { describe, expect, test } from "bun:test";
import { TASK_STATUSES } from "./board";
import {
  STAGE_AI_REVIEW,
  STAGE_HUMAN_REVIEW,
  STAGE_TRIAGE,
  WORKFLOW_PRESETS,
  awaitsHuman,
  columnOfTask,
  resolveWorkflow,
  stageAtBirth,
  stageForDelivery,
} from "./workflow";

const armonia = WORKFLOW_PRESETS.armonia;

describe("resolveWorkflow", () => {
  test("with no row the columns are the five of before", () => {
    const wf = resolveWorkflow({});
    expect(wf.preset).toBe("default");
    expect(wf.source).toBe("default");
    expect(wf.columns.map((c) => c.id)).toEqual([...TASK_STATUSES]);
    expect(wf.columns.every((c) => c.id === c.base)).toBe(true);
  });

  test("the project row wins over the global one", () => {
    expect(resolveWorkflow({ global: "armonia", project: "default" })).toMatchObject({ preset: "default", source: "project" });
    expect(resolveWorkflow({ global: "armonia" })).toMatchObject({ preset: "armonia", source: "global" });
    expect(resolveWorkflow({ global: "default", project: "armonia" })).toMatchObject({ preset: "armonia", source: "project" });
  });

  test("an unknown preset id falls through, it does not break the board", () => {
    expect(resolveWorkflow({ project: "nope", global: "armonia" }).preset).toBe("armonia");
    expect(resolveWorkflow({ project: "nope", global: "nope" }).preset).toBe("default");
  });
});

describe("columnOfTask", () => {
  test("armonia: six columns, each stage on a coherent base status", () => {
    expect(armonia.map((c) => c.id)).toEqual(["triage", "todo", "in_progress", "ai_review", "human_review", "done"]);
    expect(armonia.find((c) => c.id === STAGE_TRIAGE)?.base).toBe("backlog");
    expect(armonia.find((c) => c.id === STAGE_AI_REVIEW)?.base).toBe("review");
    expect(armonia.find((c) => c.id === STAGE_HUMAN_REVIEW)?.base).toBe("review");
  });

  test("a card with no stage sits in the default column of its status", () => {
    expect(columnOfTask(armonia, { status: "review" })?.id).toBe(STAGE_HUMAN_REVIEW);
    expect(columnOfTask(armonia, { status: "backlog" })?.id).toBe(STAGE_TRIAGE);
    expect(columnOfTask(armonia, { status: "todo", stage: null })?.id).toBe("todo");
  });

  test("a stage the status contradicts is ignored", () => {
    expect(columnOfTask(armonia, { status: "todo", stage: STAGE_AI_REVIEW })?.id).toBe("todo");
    expect(columnOfTask(armonia, { status: "review", stage: STAGE_AI_REVIEW })?.id).toBe(STAGE_AI_REVIEW);
  });

  test("on the default workflow a stage from another workflow changes nothing", () => {
    expect(columnOfTask(WORKFLOW_PRESETS.default, { status: "review", stage: STAGE_AI_REVIEW })?.id).toBe("review");
  });
});

describe("awaitsHuman", () => {
  test("ai_review does not count as review; human_review and plain review do", () => {
    expect(awaitsHuman({ status: "review", stage: STAGE_AI_REVIEW })).toBe(false);
    expect(awaitsHuman({ status: "review", stage: STAGE_HUMAN_REVIEW })).toBe(true);
    expect(awaitsHuman({ status: "review", stage: null })).toBe(true);
    expect(awaitsHuman({ status: "in_progress" })).toBe(false);
  });
});

describe("stageAtBirth", () => {
  test("a card from a person or a chat goes to triage", () => {
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: "human" })).toBe(STAGE_TRIAGE);
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: null })).toBe(STAGE_TRIAGE);
  });
  test("a complete card an agent or a schedule opened skips triage", () => {
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: "agent:jarvis", complete: true })).toBeNull();
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: "cron:nightly", complete: true })).toBeNull();
  });
  test("an incomplete one is triaged like a person's", () => {
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: "agent:session", complete: false })).toBe(STAGE_TRIAGE);
    expect(stageAtBirth(armonia, { status: "backlog", createdBy: "agent:session" })).toBe(STAGE_TRIAGE);
  });
  test("a card born in Todo has already been given the go", () => {
    expect(stageAtBirth(armonia, { status: "todo", createdBy: "human" })).toBeNull();
  });
  test("no triage column, no stage", () => {
    expect(stageAtBirth(WORKFLOW_PRESETS.default, { status: "backlog", createdBy: "human" })).toBeNull();
  });
});

describe("stageForDelivery", () => {
  test("a card an agent opened goes back to it, in AI review", () => {
    expect(stageForDelivery(armonia, { createdBy: "agent:session" })).toBe(STAGE_AI_REVIEW);
    expect(stageForDelivery(armonia, { createdBy: "cron:nightly" })).toBe(STAGE_AI_REVIEW);
  });
  test("with a question for the person it reaches Human review", () => {
    expect(stageForDelivery(armonia, { createdBy: "agent:session", humanAsk: "is the copy right?" })).toBe(STAGE_HUMAN_REVIEW);
    expect(stageForDelivery(armonia, { createdBy: "agent:session", humanAsk: "   " })).toBe(STAGE_AI_REVIEW);
  });
  test("a card a person opened goes to the person", () => {
    expect(stageForDelivery(armonia, { createdBy: "human" })).toBe(STAGE_HUMAN_REVIEW);
    expect(stageForDelivery(armonia, { createdBy: null })).toBe(STAGE_HUMAN_REVIEW);
  });
  test("on the default workflow nothing changes", () => {
    expect(stageForDelivery(WORKFLOW_PRESETS.default, { createdBy: "agent:session" })).toBeNull();
  });
});
