import type { AppContext } from "../types";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { childPhase } from "../lib/subagent-runtime";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { type TerminalSession, sessionSockets, sessions, terminalActivity } from "./terminal-state";

// The module-level handles every terminal module reads (the WS broadcast, the
// phase tracker, the worktree store) and the roster broadcast built on them.
// Below all the other split modules, so each can import it.

// Broadcast current terminal sessions list via WS
export let _broadcastToAll: ((msg: OutboundMessage) => void) | null = null;
// Claude session tracker — the authoritative phase machine. Terminal claude
// sessions register here so their hook-driven phase (running/tool-running)
// becomes the solid "is it working" signal, instead of fragile pty bytes.
export let _tracker: ClaudeSessionTracker | null = null;
/** Test seam: the tracker the park guards read (null = none), whatever an earlier file in the process installed. */
export function _setTerminalTrackerForTests(tracker: ClaudeSessionTracker | null): void { _tracker = tracker; }
/** Test seam: the live panes, to put one in front of a hook without a bridge. */
export function _terminalSessionsForTests(): Map<string, TerminalSession> { return sessions; }

/** The branch an isolated sub-agent stands on (WORKTREE-14) is read from its
 *  directory, and the directory is the only binding there is: no new column. A
 *  module-level reference like `_tracker` because the wake of a child after a
 *  restart goes through here without `ctx` at hand. */
export let _worktreeStore: AppContext["worktreeStore"] | null = null;
/** The branch of the worktree checked out at exactly this path, if there is one. */
export function branchOfCwd(cwd: string | undefined | null): string | null {
  if (!cwd || !_worktreeStore) return null;
  try { return _worktreeStore.getByAbsPath(cwd)?.branchName ?? null; } catch { return null; }
}

/**
 * Il roster in memoria è già stato confrontato con la verità (il bridge, o il DB
 * quando il bridge non risponde), oppure è ancora quello vuoto del boot?
 *
 * PERCHÉ ESISTE. `Bun.serve` parte senza attendere `reconcileSessions` (lanciato
 * fire-and-forget in `createTerminalRouter`), quindi c'è una finestra in cui
 * `GET /api/terminal/sessions` risponde **200 con `[]`** — indistinguibile, per chi
 * la riceve, da "non c'è nessuna sessione". Il client la prendeva per oro colato:
 * la scriveva nello stato E nella cache `terminal-sessions-cache` di localStorage,
 * avvelenandola per il caricamento successivo. Da lì una pane terminale VIVA si
 * ritrova `sessionListed === false` ed è a un riaggancio sfortunato dall'overlay
 * "Sessione scaduta".
 *
 * È la stessa lezione che terminal-bridge-roster.ts ha già imparato una volta, in
 * `reconcileSessions`: distinguere "una risposta reale, anche vuota" da "NESSUNA risposta"
 * (`answered.ok`). Lì valeva per il bridge, qui vale per chi interroga noi.
 */
/** Il roster è confrontato con la verità: chi lo legge può fidarsi di un vuoto.
 *  Esce di qui SOLO come campo `reconciled` di `terminal:sessions` (qui
 *  sotto): è quello il canale che il client ascolta. C'era anche un getter
 *  `isRosterReconciled()` esportato, che non ha mai avuto un chiamante — due
 *  porte sullo stesso bit, e una murata. */
export let rosterReconciled = false;

export function setRosterReconciled(reconciled: boolean): void { rosterReconciled = reconciled; }

export function broadcastTerminalSessions() {
  if (!_broadcastToAll) return;
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
    command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
    topicId: s.topicId, type: s.type,
    // claudeSessionId lets the client map a claude-code pane to its phase in
    // the tracker (the authoritative loading signal).
    claudeSessionId: s.claudeSessionId || null,
    // Sub-agent parentage: lets the roster nest children under the orchestrator
    // that spawned them. null for human-/chat-created sessions.
    parentSessionKey: s.parentSessionKey || null,
    // A sub-agent's state from its transcript, not from PTY bytes (SUBAGENT-16):
    // waiting for its prompt, working, or finished its turn.
    ...(s.parentSessionKey ? { subAgentPhase: childPhase(s.id) } : {}),
    // Authoritative busy snapshot. Lets clients reconcile loading state from
    // the roster instead of relying solely on incremental terminal:activity
    // deltas (which are lost on server restart, WS reconnect, or a dropped
    // message → otherwise a finished session spins forever).
    busy: terminalActivity.get(s.id)?.busy ?? false,
  }));
  // `reconciled` dice se un `sessions: []` va creduto. Campo aggiuntivo, non
  // sostitutivo: i client vecchi continuano a leggere solo `sessions`.
  _broadcastToAll({ type: 'terminal:sessions', sessions: list, reconciled: rosterReconciled });
}

export function setTerminalBroadcast(fn: (msg: OutboundMessage) => void): void { _broadcastToAll = fn; }
export function setTerminalWorktreeStore(store: AppContext["worktreeStore"]): void { _worktreeStore = store; }
export function setTerminalTracker(tracker: ClaudeSessionTracker): void { _tracker = tracker; }
