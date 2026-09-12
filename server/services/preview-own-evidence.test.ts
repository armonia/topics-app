import { describe, expect, it } from "bun:test";
import { holdsOwnEvidence } from "./preview-own-evidence";

/** @covers KANBAN-23 */
describe("holdsOwnEvidence", () => {
  const CHOSEN = "/Users/x/.topics/media/board/a1b2c3.png";
  const AUTO = "/Users/x/.topics/media/task-previews/task-9f8e7d.png";
  const SHEET = "/Users/x/.topics/media/task-sheets/task-9f8e7d.svg";

  it("a picture somebody chose is protected", () => {
    expect(holdsOwnEvidence(CHOSEN, false)).toBe(true);
  });

  it("an earlier auto-capture is not: replacing it with a newer one is the point", () => {
    expect(holdsOwnEvidence(AUTO, false)).toBe(false);
  });

  it("a delivery sheet is not: that one IS generated", () => {
    expect(holdsOwnEvidence(SHEET, false)).toBe(false);
  });

  it("an explicit recapture wins over anything, because asking is the point", () => {
    expect(holdsOwnEvidence(CHOSEN, true)).toBe(false);
  });

  it("nothing on the card means nothing to protect", () => {
    // Also the shape of a deps object that does not implement the lookup at
    // all: the guard must fall back to the behaviour there was before it.
    expect(holdsOwnEvidence(null, false)).toBe(false);
    expect(holdsOwnEvidence(undefined, false)).toBe(false);
    expect(holdsOwnEvidence("", false)).toBe(false);
  });
});
