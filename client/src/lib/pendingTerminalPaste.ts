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

/**
 * The text as it may reach a shell: a carriage return becomes a newline, and
 * every other control byte but tab and newline (C0 and DEL) is dropped. Run is
 * not offered on a block holding them, but Open in terminal is, and xterm's
 * `paste()` passes them through: an embedded `ESC[201~` would close the
 * bracketed paste early and the lines after it would run, and a bare `\r` is
 * an Enter.
 */
function typeableText(text: string): string {
  let out = '';
  const normalized = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) continue;
    out += normalized[i];
  }
  return out;
}

export function setPendingTerminalPaste(sessionId: string, text: string): void {
  pending.set(sessionId, typeableText(text));
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
 * (or carriage return) would reach the shell as an Enter and the first lines
 * would run, so a text of several lines is not pasted at all.
 */
export function pasteDecision(text: string, bracketedPaste: boolean): 'paste' | 'clipboard' {
  return bracketedPaste || !/[\n\r]/.test(text) ? 'paste' : 'clipboard';
}
