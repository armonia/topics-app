/**
 * `maybeSendPush` is the closed-app half of the end-of-task notification: it
 * turns the `task:review-ready` WS broadcast into a task-aware web-push. Pin
 * that it fires with the task title + a taskId-keyed tag (so a re-emit replaces
 * rather than stacks), and that it stays quiet for unrelated broadcasts.
 *
 * `push-service` (DB + VAPID) is mocked so the trigger logic is tested in
 * isolation — no database, no network.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const pushCalls: Array<{ title: string; body: string; tag?: string; url?: string }> = [];
mock.module("./push-service", () => ({
  sendPushToAll: async (payload: any) => { pushCalls.push(payload); },
}));

const { maybeSendPush } = await import("./push-triggers");

describe("maybeSendPush — task:review-ready", () => {
  beforeEach(() => { pushCalls.length = 0; });

  test("fires a task-aware push when a task enters review", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskId: "t9", taskTitle: "Rifai lo schema" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].title).toContain("review");
    expect(pushCalls[0].body).toBe("Rifai lo schema");
    expect(pushCalls[0].tag).toBe("task-review-t9");
  });

  test("degrades gracefully when the title is missing", () => {
    maybeSendPush({ type: "task:review-ready", projectId: "p", taskId: "t1" });
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].body.length).toBeGreaterThan(0);
    expect(pushCalls[0].tag).toBe("task-review-t1");
  });

  test("stays quiet for unrelated broadcasts (e.g. task:updated)", () => {
    maybeSendPush({ type: "task:updated", projectId: "p", task: { id: "t1", status: "review" } });
    maybeSendPush({ type: "task:created", projectId: "p", task: { id: "t2" } });
    expect(pushCalls).toHaveLength(0);
  });
});
