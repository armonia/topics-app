/**
 * The seed of a `spawn_agent` child must see a prompt the TUI folded into a
 * paste placeholder, or it types the prompt again (up to seven times, measured).
 * @covers SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerHoldsPrompt, promptAsPaste, splitSendText, trustCursorOnYes, trustDialogShowing } from "./subagent-seed";

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

// REAL screen of `claude` 2.1.288 opened in a never-seen folder (captured
// from a PTY on 04/10, path replaced): first the dialog with `❯` on
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
});

describe("splitSendText", () => {
  const long = "x".repeat(1100);

  test("a long text is pasted, and its closing Enter is kept apart", () => {
    expect(splitSendText(long)).toEqual({ body: long, enter: false });
    expect(splitSendText(`${long}\r`)).toEqual({ body: long, enter: true });
    expect(splitSendText(`riga\n${long}`)).toEqual({ body: `riga\n${long}`, enter: false });
  });

  test("keys are never text: arrows, a lone Enter, an escape inside a long body", () => {
    expect(splitSendText("\x1b[B\r")).toBeNull();
    expect(splitSendText("\r")).toBeNull();
    expect(splitSendText(`${long}\x1b[B`)).toBeNull();
  });

  test("a short text arrives whole as typed, so it stays typed", () => {
    expect(splitSendText("y")).toBeNull();
    expect(splitSendText("x".repeat(1022))).toBeNull();
  });
});
