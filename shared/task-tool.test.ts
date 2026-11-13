/**
 * Which tool calls are a board card, and which card each one means.
 * @covers CHAT-TASK-CARD
 */
import { describe, expect, test } from "bun:test";
import { TASK_TOOL_NAMES, taskIdOf, taskToolCall, taskToolName, taskToolStartsWait } from "./task-tool";

const ID = "214ac2a7-03c1-4a31-98d5-929d5423e083";

describe("taskToolName", () => {
  test.each(TASK_TOOL_NAMES.map((t) => [t]))("%s is recognised bare, prefixed and through the gateway", (tool) => {
    expect(taskToolName(tool)).toBe(tool);
    expect(taskToolName(`mcp__topics__${tool}`)).toBe(tool);
    expect(taskToolName(`mcp__gateway__topics_board__${tool}`)).toBe(tool);
  });

  test("other tools are not cards", () => {
    for (const n of ["list_tasks", "spawn_agent", "Bash", "board_unknown", "mcp__topics__create_task_extra", ""]) expect(taskToolName(n)).toBeNull();
  });
});

describe("taskIdOf", () => {
  test("the argument wins over the answer", () => {
    expect(taskIdOf({ task_id: ID }, "created task other [todo]: x")).toBe(ID);
    expect(taskIdOf({ taskId: ID }, undefined)).toBe(ID);
    expect(taskIdOf({ id: ID }, undefined)).toBe(ID);
  });

  test("create_task answer", () => {
    expect(taskIdOf({ text: "x" }, `created task ${ID} [backlog]: x`)).toBe(ID);
  });

  test("get_task answer", () => {
    expect(taskIdOf({}, `[todo] Title (id=${ID} @agent)`)).toBe(ID);
  });

  test("a JSON answer, and a bare uuid", () => {
    expect(taskIdOf({}, `{"ok":true,"id":"${ID}"}`)).toBe(ID);
    expect(taskIdOf({}, `board card ${ID} moved`)).toBe(ID);
  });

  test("nothing to read", () => {
    expect(taskIdOf({}, undefined)).toBeUndefined();
    expect(taskIdOf({}, "no card here")).toBeUndefined();
  });
});

describe("taskToolCall", () => {
  test("create_task and board_create are created, with the id from the answer", () => {
    expect(taskToolCall("mcp__topics__create_task", { text: "x" }, `created task ${ID} [backlog]: x`)).toEqual({ tool: "create_task", action: "created", taskId: ID });
    expect(taskToolCall("board_create", { title: "x" }, `{"id":"${ID}"}`)).toEqual({ tool: "board_create", action: "created", taskId: ID });
  });

  test("update_task: the status says what happened", () => {
    expect(taskToolCall("update_task", { task_id: ID, status: "review" }, undefined)?.action).toBe("delivered");
    expect(taskToolCall("update_task", { task_id: ID, status: "done" }, undefined)?.action).toBe("closed");
    expect(taskToolCall("update_task", { task_id: ID, status: "todo" }, undefined)?.action).toBe("resent");
    expect(taskToolCall("update_task", { task_id: ID, priority: 1 }, undefined)?.action).toBe("moved");
  });

  test("board_review: a rejection is a resend and keeps its reason", () => {
    expect(taskToolCall("board_review", { task_id: ID, decision: "reject", reason: "missing test" }, undefined))
      .toEqual({ tool: "board_review", action: "resent", taskId: ID, reason: "missing test" });
    expect(taskToolCall("board_review", { task_id: ID, decision: "approve" }, undefined)?.action).toBe("reviewed");
  });

  test("comment, status, get and land", () => {
    expect(taskToolCall("comment_task", { task_id: ID, content: "hi" }, undefined)?.action).toBe("commented");
    expect(taskToolCall("board_comment", { task_id: ID }, undefined)?.action).toBe("commented");
    expect(taskToolCall("get_task", { task_id: ID }, undefined)?.action).toBe("read");
    expect(taskToolCall("board_status", { task_id: ID }, undefined)?.action).toBe("read");
    expect(taskToolCall("board_land", { task_id: ID }, undefined)?.action).toBe("landed");
  });

  test("only a card made or sent back starts a wait", () => {
    expect(taskToolStartsWait(taskToolCall("create_task", {}, `created task ${ID} [todo]: x`)!)).toBe(true);
    expect(taskToolStartsWait(taskToolCall("update_task", { task_id: ID, status: "todo" }, undefined)!)).toBe(true);
    for (const tool of ["get_task", "comment_task", "board_status", "board_land"]) {
      expect(taskToolStartsWait(taskToolCall(tool, { task_id: ID }, undefined)!)).toBe(false);
    }
  });

  test("a call that is not a card is null", () => {
    expect(taskToolCall("Bash", { command: "ls" }, undefined)).toBeNull();
  });
});
