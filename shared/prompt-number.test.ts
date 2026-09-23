/**
 * @covers CHAT-04
 */
import { describe, it, expect } from "bun:test";
import { promptNumbers } from "./prompt-number";

describe("promptNumbers (server, whole thread)", () => {
  it("counts only what the person typed", () => {
    const thread = [
      { id: "u1", role: "user", content: "prima" },
      { id: "a1", role: "assistant", content: "ok" },
      { id: "n1", role: "user", content: "Objective still open: x", blocks: [{ kind: "goal-nudge", attempt: 1 }] },
      { id: "e1", role: "user", content: "You are the exclusive owner of task 1" },
      { id: "u2", role: "user", content: "seconda" },
    ] as const;
    const got = promptNumbers(thread as never, new Set(["e1"]));
    expect([...got]).toEqual([["u1", 1], ["u2", 2]]);
  });
});
