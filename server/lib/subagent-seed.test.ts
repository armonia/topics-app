/**
 * The seed of a `spawn_agent` child must see a prompt the TUI folded into a
 * paste placeholder, or it types the prompt again (up to seven times, measured).
 * @covers SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { composerHoldsPrompt } from "./subagent-seed";

const LONG = "Sei il sotto-agente native-image-view. ".repeat(80);

describe("composerHoldsPrompt", () => {
  test("a long prompt shown as a [Pasted text] placeholder is held", () => {
    const screen = "\x1b[2m╭──────────╮\x1b[0m\n│ > [Pasted text #1 +38 lines] │\n╰──────────╯\n  ? for shortcuts";
    expect(composerHoldsPrompt(screen, LONG)).toBe(true);
  });

  test("a short prompt wrapped across the bordered lines is held", () => {
    const screen = "╭────╮\n│ > Fai il │\n│ build e  │\n│ dimmi com'è │\n│ andata │\n╰────╯";
    expect(composerHoldsPrompt(screen, "Fai il build e dimmi com'è andata")).toBe(true);
  });

  test("an empty composer does not hold it", () => {
    expect(composerHoldsPrompt("╭────╮\n│ >        │\n╰────╯\n Welcome to Claude Code", LONG)).toBe(false);
  });
});
