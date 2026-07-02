// Pure decision logic for terminal-session OS banners — extracted from
// useCompletionNotifier so it's unit-testable in isolation (bun:test).
//
// Terminal Claude Code sessions publish `session:state` with a NULL sessionKey
// (they're keyed off claudeSessionId, not a Topics session id), so the chat
// notifier path early-returns on them and they never got an OS banner. This
// module answers, for a terminal phase transition: should we banner, and with
// what title/body — mirroring the chat semantics established in the status
// redesign (commits 2cc7a013 / 4ebb4a00): a system banner fires ONLY for an
// action-required phase (your turn / needs approval / error) OR a finish
// (completed) — never for every turn-end, and never for a working phase.

import type { ClaudeSessionPhase, ClaudeSessionPendingApproval } from '../../types';

/**
 * The phases that warrant an OS banner for a terminal session. Identical to the
 * chat notifier's actionable set:
 *   - awaiting-user     → the turn finished and Claude is waiting on you ("your turn")
 *   - awaiting-approval → a permission gate mid-task (needs a decision NOW)
 *   - completed         → an explicit success ack (background work surfacing)
 *   - error             → the session crashed; you must intervene
 * A working phase (running / tool-running) or a quiet phase (starting / paused /
 * dormant) never banners.
 */
const BANNER_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set([
  'awaiting-user',
  'awaiting-approval',
  'completed',
  'error',
]);

/** True iff this phase should raise an OS banner (see BANNER_PHASES). */
export function isBannerPhase(phase: ClaudeSessionPhase): boolean {
  return BANNER_PHASES.has(phase);
}

/** Minimal roster view the decision needs — resolves a terminal id → its
 *  friendly name (the auto-name / user rename) and owning topic. */
export interface TerminalNotifyRosterEntry {
  id: string;
  name?: string;
  topicId?: string;
  claudeSessionId?: string | null;
}

export interface TerminalNotifyInput {
  /** The terminal session id (roster id). */
  terminalId: string;
  /** The phase the session just transitioned INTO. */
  phase: ClaudeSessionPhase;
  /** The prior phase, or undefined if this is the first frame we've seen for
   *  this session (a fresh mount / reconnect bootstrap). */
  prevPhase: ClaudeSessionPhase | undefined;
  /** Monotonic revision from the session state — part of the dedupe key so a
   *  reconnect replay of the SAME (phase, rev) can't re-fire. */
  rev: number;
  /** The pending approval payload (question / plan text), when the phase is
   *  awaiting-approval. Its `prompt` becomes the banner body. */
  pendingApproval?: ClaudeSessionPendingApproval;
  /** Friendly session name (auto-name or user rename), used as the banner title. */
  name?: string;
  /** Fallback title when the session has no name (e.g. the owning topic's name). */
  fallbackTitle?: string;
  /** Is the Topics window focused AND this terminal's tab the active one? When
   *  true we suppress (the user is already looking at it) unless the override
   *  below is set. Mirrors the chat path's focused-pane suppression. */
  isFocusedAndVisible: boolean;
  /** Settings.notifyEvenWhenFocused — banner even when focused+visible. */
  notifyEvenWhenFocused: boolean;
}

export interface TerminalNotifyDecision {
  /** Banner title — the session/tab name (or the topic/generic fallback). */
  title: string;
  /** Banner body — the question/plan text for an approval, else a status line. */
  body: string;
  /** 'warn' for error/approval, 'ok' for your-turn/completed. Drives the sound
   *  level parity with the chat path (cosmetic; the OS banner text is title/body). */
  level: 'ok' | 'warn';
  /** The dedupe key the caller should record so this exact event doesn't
   *  re-fire on a reconnect replay: `<terminalId>:<phase>:<rev>`. */
  dedupeKey: string;
}

/** Build the stable dedupe key for a terminal phase event. Exposed so the
 *  caller can seed / check its record set with the identical key. */
export function terminalDedupeKey(terminalId: string, phase: ClaudeSessionPhase, rev: number): string {
  return `${terminalId}:${phase}:${rev}`;
}

/** The terminal panel id for a session id — matches createPaneId('terminal', id). */
export function terminalPanelId(terminalId: string): string {
  return `terminal:${terminalId}`;
}

/**
 * Human-readable status line for a phase, used as the banner BODY when there's
 * no richer text (an approval carries its prompt instead). Italian, matching the
 * chat notifier's wording so both surfaces read identically.
 */
function statusBody(phase: ClaudeSessionPhase): string {
  switch (phase) {
    case 'awaiting-user': return 'In attesa di te';
    case 'awaiting-approval': return "Serve un'approvazione";
    case 'completed': return 'Lavoro completato';
    case 'error': return 'Errore — intervieni';
    default: return '';
  }
}

/**
 * Decide whether a terminal phase transition should raise an OS banner, and if
 * so with what title/body/level + dedupe key. Returns null to suppress.
 *
 * Suppression rules (in order):
 *   1. First frame (no prevPhase) — baseline only, never banner. A reconnect
 *      bootstrap re-broadcasts the full roster, so a session already parked at
 *      awaiting-user would otherwise banner on every reconnect. Mirrors the
 *      chat path's isFirstFrame guard.
 *   2. No real transition (prevPhase === phase) — a repeat frame, never banner.
 *   3. Not an actionable/terminal phase — never banner (no every-turn spam).
 *   4. Focused AND visible, and notifyEvenWhenFocused is off — the user is
 *      already looking at this tab; suppress.
 *
 * Dedupe by (terminalId, phase, rev) is the CALLER's responsibility: this
 * function returns the key to record, but doesn't hold state (keeps it pure /
 * testable). The caller checks its record set before firing and records the
 * returned key after.
 */
export function decideTerminalBanner(input: TerminalNotifyInput): TerminalNotifyDecision | null {
  // 1 + 2: only fire on a genuine transition we can attribute.
  if (input.prevPhase === undefined) return null;
  if (input.prevPhase === input.phase) return null;

  // 3: gate on the actionable/terminal phase set.
  if (!isBannerPhase(input.phase)) return null;

  // 4: focused-pane suppression.
  if (input.isFocusedAndVisible && !input.notifyEvenWhenFocused) return null;

  const title = input.name || input.fallbackTitle || 'Claude Code';

  // Body: an approval carries the actual question/plan text (commit cb77dab8 put
  // it in pendingApproval.prompt) — far more useful than a generic status line.
  // Trim + collapse whitespace so a multi-line plan reads cleanly in the banner,
  // and cap the length so the OS doesn't truncate mid-word unpredictably.
  let body = statusBody(input.phase);
  if (input.phase === 'awaiting-approval' && input.pendingApproval?.prompt) {
    const cleaned = input.pendingApproval.prompt.replace(/\s+/g, ' ').trim();
    if (cleaned) body = cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
  }

  const level: 'ok' | 'warn' =
    input.phase === 'error' || input.phase === 'awaiting-approval' ? 'warn' : 'ok';

  return {
    title,
    body,
    level,
    dedupeKey: terminalDedupeKey(input.terminalId, input.phase, input.rev),
  };
}
