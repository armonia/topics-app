/**
 * Ctrl+Z freezes a Claude Code that Topics launched, for good.
 *
 * On ctrl+z Claude Code tears its UI down (leaves the alternate screen, turns
 * off mouse and bracketed paste), prints "has been suspended. Run `fg`…" and
 * sends itself SIGTSTP, waiting for a SIGCONT to put the UI back. Under Topics
 * it is the PTY's direct child and its own session leader: its process group is
 * orphaned and the kernel DISCARDS the SIGTSTP. The process stays alive, no
 * shell will ever `fg` it, and from then on it only writes the title: the last
 * frame stays on screen and resizes no longer redraw it. That was the "cut off"
 * pane of 21/10: PTY at 83 columns, Claude Code stuck at 25 for hours, 17 KB of
 * title-only output after the suspend message. A manual SIGCONT redrew it.
 *
 * Measured on a PTY whose child is session leader, as in the bridge: after
 * ctrl+z claude answers a resize with 0 bytes, and with 2841 after SIGCONT;
 * codex, opencode, muse and kimi keep redrawing. Hence the filter only covers
 * the Claude types, and a shell keeps its ctrl+z (job control works there).
 *
 * With the default bindings nothing is lost: there is nowhere to go back to,
 * and Claude Code's undo is ctrl+_. Ctrl+Z is not a reserved shortcut though:
 * whoever rebinds it in `~/.claude/keybindings.json`, or uses an $EDITOR opened
 * with ctrl+g that undoes on ctrl+z, loses it inside Topics. One key less beats
 * a frozen pane. `ESC 0x1A` (alt+ctrl+z) goes too: dropping only the 0x1A would
 * leave a bare ESC, which in Claude Code interrupts the running turn.
 */
export function withoutSuspendKey(sessionType: string | undefined, data: string): string {
  if (sessionType !== "claude-code" && sessionType !== "claude-code-team") return data;
  if (!data.includes("\x1a")) return data;
  return data.replaceAll("\x1b\x1a", "").replaceAll("\x1a", "");
}

/**
 * Single choke point for every byte bound for a PTY (keyboard socket,
 * /send, writeTopicsTerminal, live-terminals topics send, seeded prompts):
 * the bytes that may be written, or null when nothing may go out. Keyed on
 * the SESSION TYPE, never on the key or path that delivered the byte, so a
 * ctrl+z rebound in keybindings.json meets the same filter.
 */
export function bridgeWriteForSession(sessionType: string | undefined, data: string): string | null {
  const filtered = withoutSuspendKey(sessionType, data);
  return filtered.length > 0 ? filtered : null;
}
