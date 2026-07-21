/**
 * `emitReviewReadyEdge` is the anti-spam heart of the end-of-task
 * notification: it broadcasts the dedicated `task:review-ready` event ONLY on
 * the transition INTO review, so re-emitting `task:updated` for an
 * already-in-review task (a new comment, a preview bump) never re-notifies.
 * If this ever fired on every `task:updated` the user would get a banner storm.
 */
import { describe, test, expect } from "bun:test";
import { emitReviewReadyEdge } from "./tasks";

function collector() {
  const events: any[] = [];
  return { events, broadcast: (m: object) => events.push(m) };
}

describe("emitReviewReadyEdge", () => {
  test("emits on the transition INTO review", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "proj1", { id: "t1", text: "Fix login", status: "review" }, "in_progress");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:review-ready",
      projectId: "proj1",
      taskId: "t1",
      taskTitle: "Fix login",
    });
  });

  test("does NOT re-emit when the task was already in review", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "proj1", { id: "t1", text: "x", status: "review" }, "review");
    expect(events).toHaveLength(0);
  });

  test("does not emit for a non-review target status", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "in_progress" }, "todo");
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "done" }, "review");
    expect(events).toHaveLength(0);
  });

  test("first-seen task going straight to review (unknown prev) still notifies", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, undefined);
    expect(events).toHaveLength(1);
  });

  test("falls back to 'Task' title and carries reason when given", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "", status: "review" }, undefined, "system-delivered");
    expect(events[0].taskTitle).toBe("Task");
    expect(events[0].reason).toBe("system-delivered");
  });

  test("no-op on a null/undefined task", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", null, "in_progress");
    emitReviewReadyEdge(broadcast, "p", undefined, "in_progress");
    expect(events).toHaveLength(0);
  });
});
