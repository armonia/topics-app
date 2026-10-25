import type { TerminalSessionType } from "../../../../shared/terminal-session-types";

export interface TouchKey {
  label: string;
  data: string;
  wide?: boolean;
}

// Control bytes built from codes: no literal control character in source.
const ESCAPE = String.fromCharCode(27);
const SUSPEND = String.fromCharCode(26);
const UNDO = String.fromCharCode(31);

const BASE_TOUCH_KEYS: TouchKey[] = [
  { label: "Esc", data: ESCAPE },
  { label: "Tab", data: String.fromCharCode(9) },
  { label: String.fromCharCode(0x2191), data: ESCAPE + "[A" },
  { label: String.fromCharCode(0x2193), data: ESCAPE + "[B" },
  { label: String.fromCharCode(0x2190), data: ESCAPE + "[D" },
  { label: String.fromCharCode(0x2192), data: ESCAPE + "[C" },
  { label: "Ctrl+C", data: String.fromCharCode(3), wide: true },
  { label: "Ctrl+D", data: String.fromCharCode(4), wide: true },
  { label: "Ctrl+Z", data: SUSPEND, wide: true },
];

/** Claude Code's undo: the safe stand-in for Ctrl+Z on Claude sessions. */
const CLAUDE_UNDO_KEY: TouchKey = { label: "Ctrl+_", data: UNDO, wide: true };

/**
 * Virtual-keyboard keys for a session type. Ctrl+Z freezes a Claude Code
 * pane for good (see server/lib/terminal-suspend-key), so Claude sessions
 * offer Ctrl+_ (its undo) instead; a shell keeps Ctrl+Z for job control.
 */
export function touchKeysForSession(sessionType: TerminalSessionType | undefined): TouchKey[] {
  if (sessionType !== "claude-code" && sessionType !== "claude-code-team") return [...BASE_TOUCH_KEYS];
  return BASE_TOUCH_KEYS.map((key) => (key.label === "Ctrl+Z" ? CLAUDE_UNDO_KEY : key));
}

export function touchKeysForSessionInfo(sessionInfo: { type: TerminalSessionType } | undefined): TouchKey[] {
  return touchKeysForSession(sessionInfo?.type);
}
