/**
 * A chat's task map with its Topics commands folded in as one `command` task
 * (design section 5.2): the CLI's tasks stay, a command that owes nothing
 * leaves, and one still owed keeps the time it entered.
 * @covers ATTN-02
 */
import { describe, expect, it } from "bun:test";
import { withCommandTask } from "./background-tasks";

const at = "2026-10-04T09:00:00.000Z";
const later = "2026-10-04T09:05:00.000Z";

describe("withCommandTask", () => {
  it("adds the command beside the CLI's tasks while a command runs or its wake is on its way", () => {
    const out = withCommandTask({ b1: { kind: "bash", label: "build", startedAt: at } }, "running", later);
    expect(Object.keys(out.tasks).sort()).toEqual(["b1", "command"]);
    expect(out.count).toBe(2);
    expect(out.kinds.sort()).toEqual(["bash", "command"]);
    expect(withCommandTask({}, "wake-queued", later).tasks.command?.kind).toBe("command");
  });

  it("drops the command when nothing is owed, and leaves the CLI's tasks", () => {
    const out = withCommandTask({ b1: { kind: "bash", label: "build", startedAt: at }, command: { kind: "command", label: "run_command", startedAt: at } }, "none", later);
    expect(Object.keys(out.tasks)).toEqual(["b1"]);
    expect(out.count).toBe(1);
  });

  it("keeps the time a command entered across rewrites, and does not count a recurring cron", () => {
    const out = withCommandTask({ command: { kind: "command", label: "run_command", startedAt: at }, c1: { kind: "cron", label: "*/5", startedAt: at, recurring: true } }, "running", later);
    expect(out.tasks.command?.startedAt).toBe(at);
    expect(out.count).toBe(1);
    expect(out.kinds).toEqual(["command"]);
  });
});
