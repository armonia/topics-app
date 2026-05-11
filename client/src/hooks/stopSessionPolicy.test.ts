import { describe, expect, test } from "bun:test";
import { decideClientWipeOnStop } from "./stopSessionPolicy";

describe("decideClientWipeOnStop", () => {
  describe("not hydrated", () => {
    // The whole point of the guard: until the server told us what the thread
    // actually contains, the local count is structurally unreliable. The
    // function must refuse every wipe regardless of how the count looks,
    // including counts that *would* be valid wipes if we were hydrated.

    test("refuses to wipe with 0 local user messages (cold mount)", () => {
      expect(decideClientWipeOnStop(false, 0)).toBe(false);
    });

    test("refuses to wipe with 1 local user message", () => {
      // Could be the brand-new-chat case OR a hot-reload race that dropped
      // 49 previous turns. We can't tell, so we refuse.
      expect(decideClientWipeOnStop(false, 1)).toBe(false);
    });

    test("refuses to wipe with many local user messages", () => {
      expect(decideClientWipeOnStop(false, 50)).toBe(false);
    });
  });

  describe("hydrated", () => {
    test("permits wipe of empty thread (no user message stored yet)", () => {
      expect(decideClientWipeOnStop(true, 0)).toBe(true);
    });

    test("permits wipe of first-turn thread (one user message)", () => {
      // The chat was just created, user typed once, cancels before AI replies.
      // Wipe is the intended UX: discard the throwaway thread.
      expect(decideClientWipeOnStop(true, 1)).toBe(true);
    });

    test("refuses to wipe an established thread (two user messages)", () => {
      // Two user turns means the chat has progressed past "I changed my mind
      // immediately"; the user is stopping mid-conversation, not discarding.
      expect(decideClientWipeOnStop(true, 2)).toBe(false);
    });

    test("refuses to wipe a long thread", () => {
      expect(decideClientWipeOnStop(true, 50)).toBe(false);
    });
  });
});
