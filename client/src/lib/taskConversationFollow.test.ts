/**
 * @covers KANBAN-05
 */
import { describe, expect, test } from "bun:test";
import { followChoiceMayChange } from "./taskConversationFollow";

describe("task conversation follow scroll intent", () => {
  test("a viewport resize does not turn following off", () => {
    expect(followChoiceMayChange({
      wasFollowing: true,
      viewportResized: true,
      contentGrew: false,
      movedUp: true,
    })).toBe(false);
  });

  test("a resize does not force a reader who had scrolled up back to the bottom", () => {
    expect(followChoiceMayChange({
      wasFollowing: false,
      viewportResized: true,
      contentGrew: false,
      movedUp: true,
    })).toBe(true);
  });

  test("content growth without a reader scroll keeps the existing follow", () => {
    expect(followChoiceMayChange({
      wasFollowing: true,
      viewportResized: false,
      contentGrew: true,
      movedUp: false,
    })).toBe(false);
  });
});
