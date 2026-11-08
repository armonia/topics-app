/**
 * What the seed of a `spawn_agent` child reads off its terminal: has the prompt
 * reached the composer yet?
 *
 * Pure, so the question can be asked of a captured screen in a test instead of
 * a live Claude TUI (`terminal.ts#seedAgentPrompt` is the only caller; the
 * live `send_to_agent` also writes through `promptAsPaste`).
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

/** Bracketed-paste markers (xterm mode 2004, which the Claude TUI turns on at start-up). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * A prompt as it must be written into a Claude TUI: as one bracketed paste.
 *
 * THE DEFECT THIS CLOSES. The prompt went into the PTY as plain bytes, in a
 * single write. macOS makes a PTY writer wait once 1022 bytes sit unread in
 * the terminal's input queue, so the TUI reads a long write in pieces of 1022
 * bytes, and the CLI dropped every full piece: only the last one reached the
 * composer. 14 sub-agents out of 38 between 25/10 and 08/11 got their brief
 * without its opening (from the seed or from `send_to_agent`); in 13 of them
 * exactly 1022, 2044, 3066, 4088 or 13286 bytes were missing (on 04/11 a
 * child that was to build a filings register got the last 54 bytes of 1076). The
 * 14th has no source text left to compare. Reproduced on claude 2.1.319: a
 * 2397-byte write reached the transcript as its last 353 bytes; the same text
 * between the markers reached it whole, as a real terminal delivers a paste.
 *
 * ESC goes: an `ESC[201~` inside the text would close the paste early and
 * the rest would reach the TUI as keystrokes.
 */
export function promptAsPaste(prompt: string): string {
  return PASTE_START + prompt.replaceAll("\x1b", "") + PASTE_END;
}

/** Past this many bytes a plain write reaches the Claude composer without its head. */
const PLAIN_WRITE_LIMIT = 1022;

/**
 * Splits what a caller of `/send` wrote into text and keys. Text is a body
 * with no control character but newline and tab, optionally ended by one Enter
 * (`\r`): that body is worth pasting. Anything else (arrows, ESC sequences, a
 * lone `\r`, a menu answer) is keystrokes and must reach the TUI as typed.
 * Only text past the plain-write limit needs the paste: a short one arrives
 * whole either way, and a paste would not drive a menu that reads keys.
 */
export function splitSendText(input: string): { body: string; enter: boolean } | null {
  const enter = input.endsWith("\r");
  const body = enter ? input.slice(0, -1) : input;
  // eslint-disable-next-line no-control-regex -- telling text from keystrokes is exactly a control-character test
  if (!body || /[\x00-\x08\x0b-\x1f\x7f]/.test(body)) return null;
  if (Buffer.byteLength(body, "utf8") <= PLAIN_WRITE_LIMIT) return null;
  return { body, enter };
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
