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
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
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
