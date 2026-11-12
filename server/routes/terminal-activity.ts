import { terminalActivity as attentionOfActivity } from "../attention/terminal-turns";
import { sessions } from "./terminal-state";
import { autoNameCodexSession, autoNameOpencodeSession } from "./terminal-session-create";
import { _broadcastToAll, _tracker } from "./terminal-registry";

// --- Per-session pty activity tracking ----------------------------------
// All pty output flows through handleBridgeMessage's "data" case, so this is
// the single point where we can tell whether a session (notably claude-code)
// is producing output. We mark a session busy on output and idle after a
// quiet window; the active→idle transition is the "task finished" signal.
// Broadcast over the app WS so every client reacts — independent of whether
// a terminal pane is mounted (the old client-only pty pulse missed those).
const TERMINAL_IDLE_MS = 1500;
interface TerminalActivity { busy: boolean; timer: ReturnType<typeof setTimeout> | null; lastAt: number; }
export const terminalActivity = new Map<string, TerminalActivity>();
// Last visible-text signature per session, used to filter cosmetic repaints
// (e.g. the animated "/goal active" statusline) so they don't count as pty
// activity and pin a session "busy" forever. See lib/pty-activity.ts.
export const lastVisibleSig = new Map<string, string>();
// Sessioni RIATTACCATE il cui prossimo frame pty va consumato come BASELINE.
//
// PERCHÉ. Un riavvio del server azzera `lastVisibleSig`, quindi il primo frame
// di ogni pty sopravvissuto non ha un precedente con cui confrontarsi e
// `classifyFrame` non può che dichiararlo NON cosmetico. Ma quel frame è il
// ridisegno di uno schermo che esisteva già — la riattaccata stessa lo provoca —
// non lavoro nuovo. Contarlo costa due cose, misurate entrambe il 2026-08-09
// sullo stesso terminale: un `busy → finished` fasullo 1,5 s dopo (che sul
// client diventa il banner «Lavoro completato» di un lavoro chiuso da giorni) e
// una `reviveOnPtyActivity` che riaccende lo spinner su una sessione ferma da
// mezz'ora (fase `running` alle 11:35 con il transcript fermo alle 11:05 e zero
// byte da consumare: nessuna riga scritta, quindi nessun lavoro).
//
// Il guard di resize non copre questo caso: il ridisegno arriva senza che noi
// abbiamo inoltrato un resize, o fuori dalla sua finestra. È la stessa dottrina
// del «primo frame è solo baseline» che il notificatore ha già lato client
// (isRealPhaseTransition): un frame che non si può attribuire non annuncia
// niente. Vale solo per le riattaccate — uno spawn nuovo non ha uno schermo
// precedente, e il suo primo frame è lavoro vero.
export const awaitingBaselineFrame = new Set<string>();

/** La sessione `id` è stata riadottata da un roster preesistente (riavvio del
 *  server / bridge): il suo prossimo frame è un ridisegno, non lavoro. */
export function noteTerminalReattached(id: string) {
  awaitingBaselineFrame.add(id);
}
// Time (ms) of the last keystroke we forwarded to each session's pty. An output
// frame arriving within INPUT_ECHO_WINDOW_MS of this is the user's input being
// echoed/redrawn (typing, an autocomplete menu, prompt reflow) — NOT the
// process working — so it must not mark the session busy or revive it. This is
// the fix for "just typing into a Claude Code prompt raises the loading
// spinner". See lib/pty-activity.ts → isInputEcho.
export const lastInputAt = new Map<string, number>();
// Time (ms) of the last resize we forwarded to each session's pty. The SIGWINCH
// repaint that follows changes the screen (lines rewrap at the new width)
// WITHOUT the process doing work, so an output frame arriving within
// RESIZE_REPAINT_WINDOW_MS of a resize must not mark the session busy — the fix
// for "loading a caso al resize / all'apertura tab". A wider window than input
// echo because a full repaint round-trips the bridge and can lag a few frames.
// See lib/pty-activity.ts → isResizeRepaint.
export const lastResizeAt = new Map<string, number>();

/** Record that the user just sent input to a session's pty (any write: a typed
 *  char, a paste, Enter, an arrow key). Stamped from every write path so the
 *  data handler can recognise the resulting echo frames. */
export function noteTerminalInput(id: string) {
  lastInputAt.set(id, Date.now());
}

/** Record that we just resized a session's pty (window/pane resize, divider
 *  drag, sidebar toggle, tab show, focus regain). The data handler treats the
 *  resulting SIGWINCH repaint as non-work so it doesn't flash the spinner. */
export function noteTerminalResize(id: string) {
  lastResizeAt.set(id, Date.now());
}

export function markTerminalActivity(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  let a = terminalActivity.get(id);
  if (!a) { a = { busy: false, timer: null, lastAt: 0 }; terminalActivity.set(id, a); }
  a.lastAt = Date.now();
  if (!a.busy) {
    a.busy = true;
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: true, kind: session.type });
    attentionOfActivity(id, session, true, _tracker);
  }
  if (a.timer) clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a!.busy = false;
    a!.timer = null;
    // active→idle = the session stopped producing output → likely finished a
    // turn. `finished:true` lets the client raise a notification (it filters
    // to claude-code). `kind` carries the session type for that decision.
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: false, finished: true, kind: session.type });
    attentionOfActivity(id, session, false, _tracker);
    // Codex has no hooks (claude-hooks drives autoNameClaudeSession), so this
    // busy→idle transition IS its turn boundary: re-derive the tab name from
    // the rollout's latest user prompt. Guarded on a captured rollout id; a
    // no-op once the user renamed the tab. Best-effort, never throws.
    if (session.type === 'codex' && session.claudeSessionId) {
      try { autoNameCodexSession(session.claudeSessionId); } catch { /* best-effort */ }
    } else if (session.type === 'opencode') {
      // opencode has no hooks and mints its session id + AI title only after the
      // first prompt, so busy→idle is its turn boundary: (lazily) discover the
      // opencode session and pull its title. No captured id needed up-front.
      try { autoNameOpencodeSession(session.id); } catch { /* best-effort */ }
    }
  }, TERMINAL_IDLE_MS);
}

export function clearTerminalActivity(id: string) {
  const a = terminalActivity.get(id);
  if (a?.timer) clearTimeout(a.timer);
  terminalActivity.delete(id);
  lastVisibleSig.delete(id);
  lastInputAt.delete(id);
  lastResizeAt.delete(id);
  awaitingBaselineFrame.delete(id);
  // Tell clients to drop any loading state for this session (no `finished`:
  // an exit isn't a completed turn).
  if (a?.busy) _broadcastToAll?.({ type: 'terminal:activity', id, busy: false });
}

/**
 * How long (ms) the PTY for a claude session has been quiet, or null if we have
 * no activity record for it (unknown session, or one that never emitted). Busy
 * → 0. The phase reaper uses this to demote a `running` session ONLY when its
 * PTY has been genuinely silent (not just because a phase hook was missed).
 * Keyed by claudeSessionId because that's the tracker's key; we map it back to
 * the terminal session id via the `sessions` roster.
 */
export function getClaudeSessionPtyIdleMs(claudeSessionId: string): number | null {
  for (const [id, s] of sessions) {
    if (s.claudeSessionId !== claudeSessionId) continue;
    const a = terminalActivity.get(id);
    if (!a) return null;
    if (a.busy) return 0;
    return a.lastAt ? Date.now() - a.lastAt : null;
  }
  return null;
}

