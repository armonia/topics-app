import type { TerminalSessionType } from "../../shared/terminal-session-types";

export interface TerminalSession {
  id: string;
  name: string;
  /** How `name` was set: 'default' (the generated "Terminal N"), 'auto'
   *  (derived from the Claude session's evolving topic — still refreshable), or
   *  'user' (a manual rename, frozen so auto-naming won't overwrite it). */
  nameSource: 'default' | 'auto' | 'user';
  createdAt: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  topicId?: string;
  type: TerminalSessionType;
  skipPermissions: boolean;
  claudeSessionId?: string;
  /** OS pid of the PTY's root process (reported by the bridge on create /
   *  reattach). Used by the process detector to attribute listening ports
   *  started under this session to it. */
  ptyPid?: number;
  /** sessionKey of the orchestrator that spawned this session as a sub-agent
   *  (see routes `/api/sessions/:sessionKey/agents/*`). Undefined for every
   *  human-/chat-created session. The ownership guard keys off this so a parent
   *  can only drive the children it spawned, and the UI nests them under it. */
  parentSessionKey?: string;
  /** Normalised fingerprint of a sub-agent's opening prompt, kept so the
   *  transcript-discovery (which matches the child's real .jsonl by its first
   *  user turn — claude-code ignores our pre-assigned --session-id) can run at
   *  spawn AND as a self-healing fallback in the wake path. Sub-agents only. */
  spawnPromptSnippet?: string;
}


/** The CLI flags a sub-agent is launched with (`lib/subagent-launch.ts`). */
export interface SubagentLaunchFlags { model: string | null; agent: string | null; effort: string | null }

export const sessions = new Map<string, TerminalSession>();
export const sessionSockets = new Map<string, Set<any>>();
// Ids with an in-flight POST /reload, to reject a concurrent second reload of the
// same session (double right-click → "Ricarica", two clients) that would race the
// kill→recreate sequence.
export const reloadingSessionIds = new Set<string>();
// Ids the idle park asked the bridge to kill. Their exit code (129, SIGHUP) is
// the park's own signal, not a diagnosis of the session: it is stored and sent
// as NULL, so the pane being looked at revives on its own, as it does for any
// park, instead of waiting behind the code of a death nobody had.
export const parkedByServer = new Set<string>();
// Same guard for POST /revive, and it is not optional decoration. `/revive` had
// none, so two clients clicking the dormant tab together (or a client retrying a
// slow request) both passed the `status = 'dormant'` read and both called
// `createSession` for the SAME id: two PTYs, one map entry. The bridge `exit`
// frame is keyed by id alone, with no pid or generation, so the FIRST of the two
// to die tore down the survivor — closing its sockets and deleting its row — and
// the surviving PTY then existed in neither the session map nor the DB.
//
// It holds the in-flight PROMISE, not just the id, and that is the whole
// difference: the loser AWAITS the winner and gets the same session back. When
// this was a Set the loser got a 409, which no caller could tell apart from a
// real failure — `closedTabRecord.reopenClosedTab` fell through to
// `POST /api/terminal/sessions` and minted a SECOND terminal (the "two tabs, one
// full one empty" duplication its own comment warns about), and
// `SingleTerminalPane`'s auto-revive gave up and left the "Sessione scaduta"
// overlay on a session that was coming back at that very moment, with nothing to
// re-trigger it. Serialisation is a server-side concern; making every client
// implement a retry for it is how one of them gets it wrong.
export const revivingSessions = new Map<string, Promise<TerminalSession>>();


// A terminal can open a browser pane (contextId `term-<id>`). Deleting the
// terminal session must also tear that browser down, else the context lived on
// after its owner was gone (a `term-*` Playwright context found alive exactly
// this way). terminal.ts has no browserService handle, so server.ts injects a
// closer that broadcasts the pane close + destroys the server-side context.
export let terminalBrowserCloser: ((contextId: string) => void) | null = null;
export function setTerminalBrowserCloser(fn: ((contextId: string) => void) | null): void {
  terminalBrowserCloser = fn;
}


/**
 * The memory-pressure signal, injected by `server.ts`.
 *
 * A setter and not a constructor argument, for an ordering reason: `memSignal`
 * is created hundreds of lines AFTER `createTerminalRouter`, and moving it up
 * would mean relocating the memory probe for this file's convenience. Absent =
 * the sweep uses the normal threshold, which is the previous behaviour.
 */
export let terminalMemPressure: (() => { atCeiling: boolean }) | null = null;
export function setTerminalMemPressure(fn: (() => { atCeiling: boolean }) | null): void {
  terminalMemPressure = fn;
}

