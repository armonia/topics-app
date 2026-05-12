/**
 * v3 foundations AGENT-01 (partial) — explicit finite-state machine for
 * agent sessions and profiles.
 *
 * Today's behavior in `server/agent-heartbeat.ts` and SQL CHECK constraints
 * defines an IMPLICIT state machine spread across:
 *
 *   - `agent_sessions.status` CHECK ∈ {active, paused, completed, error, stale}
 *   - `agent_profiles.status` CHECK ∈ {available, busy, paused, offline}
 *   - Heartbeat checker that mutates `active → stale` after 2 min silence
 *   - Profile worker that flips profile → `offline` once no session is active
 *
 * This module makes the state space and valid transitions EXPLICIT so:
 *
 *   1. Future code paths (worktree lifecycle, in-process MCP, sub-agent
 *      orchestration) can call `canTransitionSession(from, to)` instead of
 *      re-deriving the rules.
 *   2. Tests can lock the FSM contract — any change to the transition
 *      table breaks a unit test instead of silently corrupting state.
 *   3. The Zod schemas mirror the SQL CHECK constraints so runtime
 *      validation (DB hydration, API boundary, WS frames) catches drift
 *      at the boundary rather than at the next failing query.
 *
 * Runtime behavior: ZERO changes. This module is pure data + predicates.
 * The heartbeat checker continues to operate as before; future PRs can
 * route its `UPDATE agent_sessions SET status = ?` through `applyTransition`
 * once the team is ready to enforce the FSM at the call site.
 *
 * Roadmap link: this is the AGENT-01 foundation (formal lifecycle state)
 * without touching JSONL polling or sub-agent timeline (AGENT-02/03 work).
 */
import { z } from 'zod';

// ----- State types ----------------------------------------------------------

/**
 * Lifecycle of a single agent run. A session starts `active`, may pause and
 * resume, and ends in one of three terminal states: completed (clean exit),
 * error (failure), or stale (heartbeat lost, no graceful close).
 *
 * Mirrors the CHECK constraint on `agent_sessions.status` in
 * `server/db/migrations/001-initial.sql`.
 */
export type AgentSessionState =
  | 'active'
  | 'paused'
  | 'completed'
  | 'error'
  | 'stale';

export const AGENT_SESSION_STATES = [
  'active',
  'paused',
  'completed',
  'error',
  'stale',
] as const satisfies readonly AgentSessionState[];

/**
 * Lifecycle of the long-lived agent profile (the persistent identity that
 * spawns sessions). `available` is the default ready-to-spawn state;
 * `busy` is one or more sessions running; `paused` is user-requested halt;
 * `offline` is set by the heartbeat checker when no sessions remain.
 *
 * Mirrors the CHECK constraint on `agent_profiles.status` in
 * `server/db/migrations/001-initial.sql`.
 */
export type AgentProfileState =
  | 'available'
  | 'busy'
  | 'paused'
  | 'offline';

export const AGENT_PROFILE_STATES = [
  'available',
  'busy',
  'paused',
  'offline',
] as const satisfies readonly AgentProfileState[];

// ----- Terminal-state predicates --------------------------------------------

/**
 * Terminal session states never transition to anything else; they exist
 * for historical record-keeping. Resuming a completed/error session means
 * starting a NEW session, not reviving the old row.
 */
export function isTerminalSessionState(s: AgentSessionState): boolean {
  return s === 'completed' || s === 'error';
}

// ----- Transition tables ----------------------------------------------------

/**
 * Explicit transition table for sessions. The key is the `from` state, the
 * value lists every legal `to` state. Empty array = terminal.
 *
 * Rationale per edge:
 *   - active → paused: user paused via UI / API.
 *   - active → completed: clean exit from the agent runtime.
 *   - active → error: provider error, abort, or assertion failure.
 *   - active → stale: heartbeat checker (server/agent-heartbeat.ts) marks
 *     sessions without a recent heartbeat as stale to free up profiles.
 *   - paused → active: user resumed.
 *   - paused → completed | error | stale: same reasons as from active.
 *   - stale → active: heartbeat resumed (e.g., a daemon that briefly
 *     networked-down comes back). Today this requires explicit operator
 *     action; future heartbeats could auto-revive.
 *   - completed, error: terminal — no transitions.
 */
const SESSION_TRANSITIONS: Record<AgentSessionState, readonly AgentSessionState[]> = {
  active: ['paused', 'completed', 'error', 'stale'],
  paused: ['active', 'completed', 'error', 'stale'],
  stale: ['active'],
  completed: [],
  error: [],
};

/**
 * Explicit transition table for profiles. All states can transition to all
 * others EXCEPT:
 *   - paused → busy: a paused profile must first become available
 *     (an explicit unpause).
 *   - offline → busy: an offline profile must first become available.
 *
 * available → busy: a new session started.
 * busy → available: last session ended (heartbeat checker, completion).
 * any → paused: explicit user pause.
 * any → offline: heartbeat checker decided.
 */
const PROFILE_TRANSITIONS: Record<AgentProfileState, readonly AgentProfileState[]> = {
  available: ['busy', 'paused', 'offline'],
  busy: ['available', 'paused', 'offline'],
  paused: ['available', 'offline'],
  offline: ['available'],
};

// ----- Public API: predicates ------------------------------------------------

export function canTransitionSession(
  from: AgentSessionState,
  to: AgentSessionState,
): boolean {
  // Self-loop is always allowed (idempotent writes / re-emit events).
  if (from === to) return true;
  return SESSION_TRANSITIONS[from].includes(to);
}

export function canTransitionProfile(
  from: AgentProfileState,
  to: AgentProfileState,
): boolean {
  if (from === to) return true;
  return PROFILE_TRANSITIONS[from].includes(to);
}

/**
 * List all valid `to` states from a given session state. Useful for UIs
 * that enumerate available actions (e.g., "Pause" only if from is active).
 */
export function nextSessionStates(from: AgentSessionState): readonly AgentSessionState[] {
  return SESSION_TRANSITIONS[from];
}

export function nextProfileStates(from: AgentProfileState): readonly AgentProfileState[] {
  return PROFILE_TRANSITIONS[from];
}

// ----- Zod schemas (runtime validation at boundaries) -----------------------

export const agentSessionStateSchema = z.enum([
  'active',
  'paused',
  'completed',
  'error',
  'stale',
]);

export const agentProfileStateSchema = z.enum([
  'available',
  'busy',
  'paused',
  'offline',
]);

export type SessionStateParseResult =
  | { ok: true; data: AgentSessionState }
  | { ok: false; error: string };

export function parseAgentSessionState(value: unknown): SessionStateParseResult {
  const result = agentSessionStateSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

export type ProfileStateParseResult =
  | { ok: true; data: AgentProfileState }
  | { ok: false; error: string };

export function parseAgentProfileState(value: unknown): ProfileStateParseResult {
  const result = agentProfileStateSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

// ----- Optional FSM-guarded transition helper -------------------------------

/**
 * Apply a transition with a runtime guard. Returns the new state on
 * success, or null + reason on rejection. Useful as a defensive wrapper
 * around SQL `UPDATE agent_sessions SET status = ?` once call sites adopt
 * the FSM.
 *
 * Today no production code calls this — it exists so future PRs can route
 * through a single chokepoint and emit structured telemetry on rejected
 * transitions (instead of silently corrupting state).
 */
export type TransitionResult<S> =
  | { ok: true; state: S }
  | { ok: false; reason: string };

export function applySessionTransition(
  from: AgentSessionState,
  to: AgentSessionState,
): TransitionResult<AgentSessionState> {
  if (canTransitionSession(from, to)) {
    return { ok: true, state: to };
  }
  return {
    ok: false,
    reason: `Invalid session transition: ${from} → ${to}. Allowed: [${SESSION_TRANSITIONS[from].join(', ') || '(terminal)'}]`,
  };
}

export function applyProfileTransition(
  from: AgentProfileState,
  to: AgentProfileState,
): TransitionResult<AgentProfileState> {
  if (canTransitionProfile(from, to)) {
    return { ok: true, state: to };
  }
  return {
    ok: false,
    reason: `Invalid profile transition: ${from} → ${to}. Allowed: [${PROFILE_TRANSITIONS[from].join(', ') || '(terminal)'}]`,
  };
}
