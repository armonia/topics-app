/**
 * The stdin user message of a skill invocation keeps the command as the LAST
 * text block: the CLI parses that block as the input, so `/recap` expands and
 * gets only the user's own arguments.
 *
 * @covers SKILL-03
 */
import { describe, expect, it } from "bun:test";
import { buildUserTurnContent } from "./user-turn";

describe("buildUserTurnContent", () => {
  it("an ordinary message stays a plain string, with the prologue in front as before", () => {
    expect(buildUserTurnContent("ciao")).toBe("ciao");
    expect(buildUserTurnContent("ciao", { prologue: "RECAP" })).toBe("RECAP\nciao");
  });

  it("a skill invocation with context becomes two blocks, the command last", () => {
    expect(buildUserTurnContent("/vai solo X", { slashContext: "<context>\nC\n</context>" })).toEqual([
      { type: "text", text: "<context>\nC\n</context>" },
      { type: "text", text: "/vai solo X" },
    ]);
  });

  it("the recap prologue of a respawned session also goes in the block before the command", () => {
    expect(buildUserTurnContent("/vai", { prologue: "RECAP", slashContext: "<context>C</context>" })).toEqual([
      { type: "text", text: "RECAP\n\n<context>C</context>" },
      { type: "text", text: "/vai" },
    ]);
    expect(buildUserTurnContent("/vai", { prologue: "RECAP", slashContext: "" })).toEqual([
      { type: "text", text: "RECAP" },
      { type: "text", text: "/vai" },
    ]);
  });

  it("a skill invocation with nothing beside it is the bare string", () => {
    expect(buildUserTurnContent("/vai", { slashContext: "" })).toBe("/vai");
  });
});
