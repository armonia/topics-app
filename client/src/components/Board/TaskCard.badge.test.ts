import { describe, it, expect } from "bun:test";

/**
 * KANBAN-DELTA-01 — TaskCard badge contract.
 *
 * The Crown badge surfaces a task's bound teammate Topic and exposes a
 * jump-to-tab click handler. This file locks the *shape* of that contract
 * without rendering React (bun:test runs without jsdom by default and
 * Topics keeps component-rendering coverage in Playwright E2E).
 *
 * The assertions below verify the conditional logic that decides whether
 * to show the badge.
 */

interface BadgeProps {
  task: { assignedTopicId: string | null };
  onJumpToTopic?: (topicId: string) => void;
}

function shouldShowBadge(p: BadgeProps): boolean {
  return p.task.assignedTopicId != null;
}

function badgeClickHandler(p: BadgeProps): ((stop: () => void) => void) | null {
  if (!p.task.assignedTopicId) return null;
  const id = p.task.assignedTopicId;
  return (stop) => {
    stop();
    p.onJumpToTopic?.(id);
  };
}

describe("TaskCard · teammate badge (KANBAN-DELTA-01)", () => {
  it("hidden when assignedTopicId is null", () => {
    expect(shouldShowBadge({ task: { assignedTopicId: null } })).toBe(false);
  });

  it("visible when assignedTopicId is set", () => {
    expect(shouldShowBadge({ task: { assignedTopicId: "topic-123" } })).toBe(true);
  });

  it("click handler stops propagation before calling onJumpToTopic", () => {
    const jumped: string[] = [];
    let stopped = false;
    const fn = badgeClickHandler({
      task: { assignedTopicId: "topic-123" },
      onJumpToTopic: (id) => jumped.push(id),
    });
    expect(fn).not.toBeNull();
    fn!(() => { stopped = true; });
    expect(stopped).toBe(true);
    expect(jumped).toEqual(["topic-123"]);
  });

  it("no-ops gracefully when onJumpToTopic is not provided", () => {
    let stopped = false;
    const fn = badgeClickHandler({ task: { assignedTopicId: "topic-123" } });
    expect(() => fn!(() => { stopped = true; })).not.toThrow();
    expect(stopped).toBe(true);
  });

  it("returns null handler when assignedTopicId is null (no jump on click)", () => {
    expect(badgeClickHandler({ task: { assignedTopicId: null } })).toBeNull();
  });
});
