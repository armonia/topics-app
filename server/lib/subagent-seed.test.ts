/**
 * The seed of a `spawn_agent` child must see a prompt the TUI folded into a
 * paste placeholder, or it types the prompt again (up to seven times, measured).
 * @covers SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerHoldsPrompt, trustCursorOnYes, trustDialogShowing } from "./subagent-seed";

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

// Schermo VERO di `claude` 2.1.288 aperto in una cartella mai vista (catturato
// da un PTY il 04/10, percorso sostituito): prima il dialogo con `❯` su
// «No, exit», poi, dopo una freccia giù, il ridisegno con `❯` su «Yes».
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
