/**
 * A command waiting for a new shell's first screen, to be typed there and NOT
 * run: «Open in terminal» under a code block of a reply (CHAT-RUN-05).
 *
 * Not the session's `command` (that runs it, and the server refuses it
 * without the agent's token) nor `/send` (it ends with Enter): the pane takes
 * the text when the shell has drawn its prompt and pastes it with xterm's
 * `term.paste()`, which wraps it in bracketed-paste markers when the shell
 * asked for them. zsh asks by default: a block of several lines then goes in
 * as one paste and waits on the command line.
 */
const pending = new Map<string, string>();

export function setPendingTerminalPaste(sessionId: string, text: string): void {
  pending.set(sessionId, text);
}

export function hasPendingTerminalPaste(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** The text left for this session, once. */
export function takePendingTerminalPaste(sessionId: string): string | undefined {
  const text = pending.get(sessionId);
  pending.delete(sessionId);
  return text;
}

/**
 * Paste, or put it on the clipboard. Without bracketed paste every newline
 * would reach the shell as an Enter and the first lines would run, so a text
 * of several lines is not pasted at all.
 */
export function pasteDecision(text: string, bracketedPaste: boolean): 'paste' | 'clipboard' {
  return bracketedPaste || !text.includes('\n') ? 'paste' : 'clipboard';
}
