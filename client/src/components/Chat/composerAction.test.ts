import { describe, expect, test } from "bun:test";
import { decideComposerAction } from "./composerAction";

describe("decideComposerAction", () => {
  describe("idle (busy=false)", () => {
    test("empty composer is disabled — there is nothing to do", () => {
      expect(decideComposerAction({ busy: false, hasContent: false })).toEqual({
        kind: "disabled",
      });
    });

    test("composer with content sends — the canonical happy path", () => {
      expect(decideComposerAction({ busy: false, hasContent: true })).toEqual({
        kind: "send",
      });
    });
  });

  describe("busy (streaming / loading / thinking / waiting-for-tool-input)", () => {
    test("empty composer offers Stop — agent owns the turn, user can abort", () => {
      expect(decideComposerAction({ busy: true, hasContent: false })).toEqual({
        kind: "stop",
      });
    });

    test("composer with content queues — preserves typed text for after the stream", () => {
      // Critical UX invariant: typing while streaming must NOT lose the text.
      // The queue path persists it and auto-sends on stream:end.
      expect(decideComposerAction({ busy: true, hasContent: true })).toEqual({
        kind: "queue",
      });
    });
  });

  test("decision is pure: same input → same output (no hidden state)", () => {
    const probe = { busy: true, hasContent: false };
    const first = decideComposerAction(probe);
    const second = decideComposerAction(probe);
    expect(first).toEqual(second);
  });
});
