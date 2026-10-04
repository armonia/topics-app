/**
 * What the seed of a `spawn_agent` child reads off its terminal: has the prompt
 * reached the composer yet?
 *
 * Pure, so the question can be asked of a captured screen in a test instead of
 * a live Claude TUI (`terminal.ts#seedAgentPrompt` is the only caller).
 *
 * THE DEFECT THIS CLOSES. The seed typed the prompt, then looked for its first
 * twenty characters on screen and typed it AGAIN whenever they were absent. A
 * long prompt never shows up as text: the TUI folds a paste into a
 * `[Pasted text #1 +N lines]` placeholder. So the probe never matched and the
 * prompt was typed six more times (plus one blind write). Measured on the
 * production transcripts 08/09-29/09: 24 children out of 39 received their
 * brief two to seven times, one of them 13,074 characters that arrived as
 * 96,796; one child wrote back that its brief had been pasted several times.
 */

/** Normalize terminal text for echo-matching: drop ANSI escape sequences,
 *  box-drawing glyphs and ALL whitespace, lowercased - so a prompt wrapped
 *  across the composer's bordered lines collapses back to a contiguous string
 *  we can substring-match against the prompt's own fingerprint. */
export function stripForEcho(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex -- strips terminal escape sequences, so ESC and BEL are the point of the pattern
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    // eslint-disable-next-line no-control-regex -- strips terminal escape sequences, so ESC and BEL are the point of the pattern
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    // eslint-disable-next-line no-control-regex -- strips terminal escape sequences, so ESC and BEL are the point of the pattern
    .replace(/\x1b[()][0-9A-B]/g, "") // charset selects
    .replace(/[─-╿▀-▟]/g, "") // box drawing + block elements
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** The placeholder the Claude TUI draws for a paste it folds, as `stripForEcho` leaves it. */
const PASTE_PLACEHOLDER = "[pastedtext";

/**
 * True when the composer on this screen already holds `prompt`: either its
 * opening characters are visible, or the TUI folded it into a paste
 * placeholder. Either way typing it again would duplicate it.
 */
export function composerHoldsPrompt(screen: string, prompt: string): boolean {
  const seen = stripForEcho(screen);
  const probe = stripForEcho(prompt).slice(0, 20);
  if (probe && seen.includes(probe)) return true;
  return seen.includes(PASTE_PLACEHOLDER);
}

/**
 * THE FOLDER-TRUST DIALOG. A CLI started in a folder never opened before asks
 * "do you trust this folder?" with the cursor on «No, exit». The seed did not
 * recognise it: the dialog's box has `╭─` borders, which the seed took for a
 * ready composer, so it typed the prompt and pressed Enter on «No». The CLI
 * exited with code 1 and no transcript: on 03/10 three sub-agents of
 * topic:d740f8ae in pop-demo, `reason="no-transcript"` and no log line.
 *
 * The buffer is the whole scrollback, so the dialog "is showing" only if the
 * composer has not appeared yet after its last question.
 */
const TRUST_QUESTION = "itrustthisfolder";
const COMPOSER_AFTER_TRUST = ["forshortcuts", "bypassing"];

export function trustDialogShowing(screen: string): boolean {
  const seen = stripForEcho(screen);
  const at = seen.lastIndexOf(TRUST_QUESTION);
  if (at < 0) return false;
  const after = seen.slice(at);
  return !COMPOSER_AFTER_TRUST.some((h) => after.includes(h));
}

/** The dialog's `❯` cursor sits on the «Yes» choice: only then does Enter accept. */
export function trustCursorOnYes(screen: string): boolean {
  const seen = stripForEcho(screen);
  const cursor = seen.lastIndexOf("❯");
  return cursor >= 0 && /^(\d\.)?yes/.test(seen.slice(cursor + 1));
}
