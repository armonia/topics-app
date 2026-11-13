import { bridgeWriteForSession } from "../lib/terminal-suspend-key";
import { BridgeCreateAcks } from "../lib/bridge-create-ack";
import { formatTerminalKillLog, type TerminalKillReason } from "../lib/terminal-kill";
import { promptAsPaste } from "../lib/subagent-seed";
import { sessions } from "./terminal-state";
import { bridgeSocket } from "./terminal-bridge-socket";

/**
 * One line per session per silent window, not one per keystroke.
 *
 * Typing during a reconnect produces a burst: the same message repeated dozens
 * of times says nothing the first one did not, and buries the reconnect lines
 * that explain it. The counter is reported when the burst ends.
 */
const droppedInput = new Map<string, { n: number; since: number }>();
export function noteDroppedInput(sessionId: string, err: unknown): void {
  const now = Date.now();
  const prev = droppedInput.get(sessionId);
  if (prev && now - prev.since < 10_000) {
    prev.n++;
    return;
  }
  if (prev) {
    console.warn(`[Terminal] ${prev.n} keystroke(s) dropped for ${sessionId} while the bridge was down`);
  }
  droppedInput.set(sessionId, { n: 1, since: now });
  console.warn(`[Terminal] keystroke dropped for ${sessionId}: ${String((err as Error)?.message ?? err)}`);
}

/**
 * Decision for POST /api/terminal/sessions/:id/send, keyed on the session
 * type: the suspend key that freezes Claude Code never counts as sent. The
 * bridge receives `data`; when that is empty the route answers `dropped`
 * instead of `ok` and writes nothing.
 */
export function resolveTerminalSend(
  sessionType: string | undefined,
  input: string,
): { data: string; sent: number; dropped: boolean; pasted: boolean; enter?: boolean } {
  const data = bridgeWriteForSession(sessionType, input);
  if (data === null) return { data: "", sent: 0, dropped: true, pasted: false };
  const sent = Buffer.byteLength(data, "utf8");
  // Long plain text for a Claude TUI goes as one bracketed paste: a plain write
  // over 1022 bytes reached it without its head (lib/subagent-seed.ts). Keys
  // (Enter, arrows, anything with a control byte) and short text stay raw so
  // dialogs and menus keep reading them as keystrokes.
  const claudeTui = sessionType === "claude-code" || sessionType === "claude-code-team";
  // One trailing Enter (the legacy gateway sends `text + "\r"`) is split off and
  // sent as its own key after the paste.
  const enter = data.endsWith("\r");
  const text = enter ? data.slice(0, -1) : data;
  if (claudeTui && Buffer.byteLength(text, "utf8") > PASTE_MIN_BYTES && isPlainText(text)) {
    return { data: promptAsPaste(text), sent, dropped: false, pasted: true, enter };
  }
  return { data, sent, dropped: false, pasted: false };
}

/** Under this many bytes a write reaches the TUI in one piece (macOS reads 1022 at a time). */
export const PASTE_MIN_BYTES = 1000;

/** Printable text, newlines and tabs only: no ESC sequences, no Enter, no other control byte. */
export function isPlainText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f) return false;
  }
  return true;
}

export function sendToBridge(msg: any) {
  if (!bridgeSocket || bridgeSocket.destroyed) {
    throw new Error("Bridge not connected");
  }
  // Every byte bound for a PTY passes here (keyboard, /send, live-terminals,
  // sub-agent prompts): the one place the ctrl+z that freezes Claude Code
  // cannot slip past the filter. The why is in terminal-suspend-key.
  if (msg.type === "write") {
    const data = bridgeWriteForSession(sessions.get(msg.id)?.type, msg.data);
    if (data === null) return;
    if (data !== msg.data) msg = { ...msg, data };
  }
  bridgeSocket.write(JSON.stringify(msg) + "\n");
}

export function sendTerminalKill(id: string, reason: TerminalKillReason, caller: string): void {
  sendToBridge({ type: "kill", id, reason, caller });
  console.log(formatTerminalKillLog({ sessionId: id, reason, caller }));
}

// --- Create-ack tracking ---
// Pending POST /sessions calls park here until the bridge replies with
// {type:'created', id} or {type:'error', error}. Without this gate the
// API returned 200 even when pty.spawn threw inside the bridge — the
// user got an empty terminal pane and no clue why.
//
// The register lives in server/lib/bridge-create-ack.ts, where its own header
// explains why: an ack that arrives AFTER the caller gave up used to be an
// unhandled rejection, and an unhandled rejection kills the whole server.
export const pendingCreates = new BridgeCreateAcks();
