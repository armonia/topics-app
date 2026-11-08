/**
 * The seed of a `spawn_agent` child must see a prompt the TUI folded into a
 * paste placeholder, or it types the prompt again (up to seven times, measured).
 * @covers SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerHoldsPrompt, promptAsPaste, trustCursorOnYes, trustDialogStep, trustDialogShowing } from "./subagent-seed";

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

describe("promptAsPaste", () => {
  test("the prompt goes between the bracketed-paste markers, whole", () => {
    expect(promptAsPaste("Riga uno\nRiga due")).toBe("\x1b[200~Riga uno\nRiga due\x1b[201~");
  });

  test("a text cannot close the paste early: what followed would reach the TUI as keys", () => {
    const pasted = promptAsPaste("prima\x1b[201~\x1b[Bdopo");
    expect(pasted.indexOf("\x1b[201~")).toBe(pasted.length - "\x1b[201~".length);
    expect(pasted).toBe("\x1b[200~prima[201~[Bdopo\x1b[201~");
  });
});

// REAL screen of `claude` 2.1.310 opened in a never-seen folder (captured
// from a clean PTY, no CLAUDE_* variables, on 08/11, path replaced): first the dialog with `❯` on
// «No, exit», then, after a down arrow, the redraw with `❯` on «Yes».
describe("folder-trust dialog", () => {
  const captured = readFileSync(join(import.meta.dir, "__fixtures__/claude-trust-dialog.txt"), "utf8");
  const redraw = captured.indexOf("\x1b[>0q");
  const onNo = captured.slice(0, redraw);

  test("the dialog is recognised, and its `╭─` border is not a ready composer", () => {
    expect(trustDialogShowing(onNo)).toBe(true);
    expect(trustDialogShowing(captured)).toBe(true);
  });

  test("Enter is allowed only once `❯` sits on «Yes»: on «No, exit» it kills the child", () => {
    expect(trustCursorOnYes(onNo)).toBe(false);
    expect(trustCursorOnYes(captured)).toBe(true);
  });

  test("once the composer is drawn after it, the dialog is over", () => {
    expect(trustDialogShowing(`${captured}\n╭──╮\n│ > │\n? for shortcuts`)).toBe(false);
    expect(trustDialogShowing("╭──╮\n│ > Fai il build │\n? for shortcuts")).toBe(false);
  });

  test("the next step waits for the whole dialog, then moves to «Yes», then accepts", () => {
    const beforeFooter = captured.slice(0, captured.indexOf("\x1b[18;2H"));
    expect(trustDialogStep(beforeFooter)).toBe("wait");
    expect(trustDialogStep(onNo)).toBe("down");
    expect(trustDialogStep(captured)).toBe("accept");
  });
});
