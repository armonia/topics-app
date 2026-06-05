/**
 * agentBoard — pure logic for the Agents Board: per-session recommended action
 * and the Autopilot safe-closure selection.
 *
 * The board shows the status of every active session with a recommended action.
 * Recommendations are HEURISTIC (free — no model call). Autopilot may auto-run
 * ONLY mechanical, reversible, safe actions (close a concluded+idle session);
 * it NEVER invokes the model. Deep reasoning is delegated to an on-demand
 * Claude Code Master session instead. See interactive-claude-primitive.
 *
 * Pure + side-effect-free → bun:test (co-located).
 */

export type SessionState = 'empty' | 'streaming' | 'update' | 'waiting' | 'idle';

/** Subset of MasterSession the board logic needs. */
export interface BoardSession {
  topicId: string;
  name: string;
  sessionType?: 'topic' | 'claude-code-terminal' | string;
  state: SessionState;
  unread?: number;
  /** ISO timestamp of last activity (for staleness). */
  lastAt?: string | null;
  lastRole?: string | null;
}

export type RecommendedAction = 'open' | 'close' | 'none';

export interface Recommendation {
  action: RecommendedAction;
  /** Short human reason shown next to the action. */
  reason: string;
  /** True when the action is mechanical + reversible + safe to auto-run. */
  safe: boolean;
}

/**
 * Recommend an action for one session, from its status alone (free heuristic).
 *
 *  - update    → OPEN: an unread assistant reply is waiting for you.
 *  - streaming → NONE: it's mid-reply, leave it.
 *  - waiting   → NONE: the AI has the ball (user sent, no reply yet).
 *  - idle      → CLOSE (safe): caught up; an assistant-finished, read thread
 *                reads as concluded. Reversible (archive), so safe to autopilot.
 *  - empty     → CLOSE (safe): nothing in it.
 *
 * Only `close` on `idle`/`empty` is marked safe — the one autopilot may run.
 */
export function recommendSessionAction(s: BoardSession): Recommendation {
  const unread = s.unread ?? 0;
  switch (s.state) {
    case 'update':
      return { action: 'open', reason: 'nuova risposta da leggere', safe: false };
    case 'streaming':
      return { action: 'none', reason: 'in lavorazione', safe: false };
    case 'waiting':
      return { action: 'none', reason: 'in attesa di risposta', safe: false };
    case 'empty':
      return { action: 'close', reason: 'vuota', safe: true };
    case 'idle':
    default:
      // Unread on an idle row means there's still something unseen → open.
      if (unread > 0) return { action: 'open', reason: `${unread} non letti`, safe: false };
      return { action: 'close', reason: 'conclusa', safe: true };
  }
}

export interface AutopilotOptions {
  /** Min age (ms) since lastAt before a session is eligible for auto-close. */
  minIdleMs?: number;
  /** Clock injection for tests. */
  now?: number;
}

const DEFAULT_MIN_IDLE_MS = 30 * 60 * 1000; // 30 min

/**
 * Select the sessions Autopilot may safely auto-close: recommendation is a
 * SAFE close AND the session has been idle longer than `minIdleMs`. Empty
 * sessions (no lastAt) are eligible immediately. Conservative by design —
 * anything streaming/waiting/with-unread is never selected.
 */
export function selectAutopilotClosures(
  sessions: BoardSession[],
  opts: AutopilotOptions = {},
): BoardSession[] {
  const minIdleMs = opts.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
  const now = opts.now ?? Date.now();
  return sessions.filter((s) => {
    const rec = recommendSessionAction(s);
    if (rec.action !== 'close' || !rec.safe) return false;
    if (s.state === 'empty') return true; // nothing to lose
    if (!s.lastAt) return false; // unknown age → don't touch
    const age = now - Date.parse(s.lastAt);
    return Number.isFinite(age) && age >= minIdleMs;
  });
}
