/**
 * A tool that never ran does not get the green tick.
 *
 * The case that motivated the module: 2026-08-28, topic:4c935add, three times out
 * of three. The model was writing a document inside the argument of a
 * `write_file`, blew through the output cap halfway into the JSON, and the round
 * exited before executing the tools. `reason` was `done`, so the previous line
 * closed everything as successful: `Tool start: write_file` in the log and ZERO
 * `Tool result`, no file on disk, and a green tick on screen.
 * @covers CHAT-01
 */
import { describe, test, expect } from "bun:test";
import { toolOutcomeAtTurnEnd } from "./tool-finalize-status";

describe("how the hanging tools are closed", () => {
  test("a turn that really finished leaves the tools successful", () => {
    expect(toolOutcomeAtTurnEnd("done", { end: "end_turn" })).toEqual({ status: "success" });
  });

  test("THE CASE: cut by the output cap -> error, not success", () => {
    const e = toolOutcomeAtTurnEnd("done", { end: "max_tokens" });
    expect(e.status).toBe("error");
    // The sentence must say WHERE it broke, not just that it broke: the tool did
    // not fail while running, it never started at all.
    expect(e.error).toContain("limite di lunghezza");
  });

  test("the user's stop stays theirs, and it shows", () => {
    expect(toolOutcomeAtTurnEnd("aborted", { end: "end_turn" })).toEqual({
      status: "error",
      error: "Aborted by user",
    });
  });

  test("a stream error carries its own message along", () => {
    expect(toolOutcomeAtTurnEnd("error", undefined, "socket hung up")).toEqual({
      status: "error",
      error: "socket hung up",
    });
  });

  test("with no turnEnd a finished turn stays a success: no fault is invented", () => {
    // `turnEnd` is missing when one of our own timers finalizes. There the caller
    // knows the reason and passes it separately: inferring "cut" from an absent
    // field would turn every watchdog into a false cut.
    expect(toolOutcomeAtTurnEnd("done", undefined)).toEqual({ status: "success" });
  });
});
