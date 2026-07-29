import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "./schemas/ws-outbound";
import {
  applySessionTransition,
  applyProfileTransition,
  parseAgentSessionState,
  parseAgentProfileState,
  type AgentSessionState,
  type AgentProfileState,
} from "./agent-fsm";

const HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export function startHeartbeatChecker(db: Database, broadcastToAll: (msg: OutboundMessage) => void): () => void {
  const staleSessionsStmt = db.prepare(`
    SELECT id, agent_id, session_key, last_heartbeat, status
    FROM agent_sessions
    WHERE status = 'active'
      AND last_heartbeat IS NOT NULL
      AND datetime(last_heartbeat) < datetime('now', '-2 minutes')
  `);

  // v3 foundations AGENT-01 adoption: route status updates through the FSM
  // guard. The previous direct `UPDATE … SET status = 'stale'` ran without
  // re-reading the row, so a session that completed between SELECT and
  // UPDATE could be silently overwritten from 'completed'/'error' back to
  // 'stale'. The FSM rejects that transition (terminal states are sealed),
  // turning the race into an observable warning instead of state corruption.
  const markSessionStale = db.prepare(`
    UPDATE agent_sessions SET status = 'stale' WHERE id = ? AND status = ?
  `);

  /**
   * Transition a session row to a new state with FSM enforcement. Reads the
   * current state from the provided row, validates the transition, and
   * issues a conditional UPDATE that aborts if the row state changed
   * underneath us. Returns true iff the UPDATE actually changed a row.
   */
  function transitionSessionTo(
    row: { id: string; status?: string },
    target: AgentSessionState,
  ): boolean {
    const currentRaw = row.status ?? 'active';
    const current = parseAgentSessionState(currentRaw);
    if (!current.ok) {
      console.warn(`[Heartbeat] Session ${row.id} has unknown status '${currentRaw}', skipping transition to '${target}': ${current.error}`);
      return false;
    }
    const guard = applySessionTransition(current.data, target);
    if (!guard.ok) {
      // Expected when the row reached a terminal state between SELECT and
      // UPDATE — log it so operators can see drift, but don't error.
      console.warn(`[Heartbeat] ${guard.reason} (session ${row.id})`);
      return false;
    }
    const result = markSessionStale.run(row.id, current.data);
    // bun:sqlite returns { changes } from .run(); treat 1 changed row as success.
    return ((result as { changes?: number }).changes ?? 0) > 0;
  }

  // v3 foundations AGENT-01 adoption (profile side): same race-safe pattern
  // as session updates. The conditional `WHERE id = ? AND status = ?` clause
  // makes the UPDATE no-op if the profile state changed underneath the FSM
  // guard (e.g., a user unpaused or the profile already went offline).
  const markProfileOffline = db.prepare(`
    UPDATE agent_profiles SET status = 'offline', updated_at = ? WHERE id = ? AND status = ?
  `);
  const readProfileStatusStmt = db.prepare(
    `SELECT status FROM agent_profiles WHERE id = ?`,
  );

  /**
   * Transition an agent profile to a new state with FSM enforcement. Reads
   * the current status from the DB (we don't have a row passed in, just the
   * id), validates the transition, and issues a conditional UPDATE. Returns
   * true iff the UPDATE actually changed a row.
   */
  function transitionProfileTo(
    agentId: string,
    target: AgentProfileState,
    now: string,
  ): boolean {
    const row = readProfileStatusStmt.get(agentId) as { status?: string } | null;
    if (!row) return false; // profile was deleted between SELECT and UPDATE
    const currentRaw = row.status ?? 'available';
    const current = parseAgentProfileState(currentRaw);
    if (!current.ok) {
      console.warn(`[Heartbeat] Profile ${agentId} has unknown status '${currentRaw}', skipping transition to '${target}': ${current.error}`);
      return false;
    }
    const guard = applyProfileTransition(current.data, target);
    if (!guard.ok) {
      console.warn(`[Heartbeat] ${guard.reason} (profile ${agentId})`);
      return false;
    }
    const result = markProfileOffline.run(now, agentId, current.data);
    return ((result as { changes?: number }).changes ?? 0) > 0;
  }

  // Check for sessions without any heartbeat that started more than 2 minutes ago
  const noHeartbeatSessionsStmt = db.prepare(`
    SELECT id, agent_id, session_key, started_at, status
    FROM agent_sessions
    WHERE status = 'active'
      AND last_heartbeat IS NULL
      AND datetime(started_at) < datetime('now', '-2 minutes')
  `);

  // Prepared once: counts non-terminal sessions for a given agent. Re-used per
  // affected agent below instead of re-preparing the same SQL each iteration.
  const activeSessionCountStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM agent_sessions WHERE agent_id = ? AND status IN ('active', 'paused')
  `);

  // Prepared once: agent profiles gone stale per their last_seen_at heartbeat.
  const staleProfilesStmt = db.prepare(`
    SELECT id FROM agent_profiles
    WHERE status NOT IN ('offline', 'paused')
      AND last_seen_at IS NOT NULL
      AND datetime(last_seen_at) < datetime('now', '-2 minutes')
  `);

  // Row shapes returned by the heartbeat queries above.
  type StaleSessionRow = { id: string; agent_id: string | null; status: string };
  type AgentCountRow = { cnt: number };
  type StaleProfileRow = { id: string };

  function check() {
    try {
      const now = new Date().toISOString();
      let staleCount = 0;
      const affectedAgentIds = new Set<string>();

      // Check sessions with stale heartbeats
      const staleSessions = staleSessionsStmt.all() as StaleSessionRow[];
      for (const session of staleSessions) {
        if (transitionSessionTo(session, 'stale')) {
          if (session.agent_id) {
            affectedAgentIds.add(session.agent_id);
          }
          staleCount++;
        }
      }

      // Check sessions that never sent a heartbeat
      const noHeartbeatSessions = noHeartbeatSessionsStmt.all() as StaleSessionRow[];
      for (const session of noHeartbeatSessions) {
        if (transitionSessionTo(session, 'stale')) {
          if (session.agent_id) {
            affectedAgentIds.add(session.agent_id);
          }
          staleCount++;
        }
      }

      // Mark affected agent profiles as offline (only if they have no other active sessions)
      for (const agentId of affectedAgentIds) {
        const activeCount = activeSessionCountStmt.get(agentId) as AgentCountRow | null;

        if (!activeCount || activeCount.cnt === 0) {
          transitionProfileTo(agentId, 'offline', now);
        }
      }

      // Also check agent profiles using last_seen_at (for agent API heartbeats)
      const staleProfiles = staleProfilesStmt.all() as StaleProfileRow[];

      for (const profile of staleProfiles) {
        // Only mark offline if no active sessions
        const activeCount = activeSessionCountStmt.get(profile.id) as AgentCountRow | null;

        if (!activeCount || activeCount.cnt === 0) {
          if (transitionProfileTo(profile.id, 'offline', now)) {
            staleCount++;
          }
        }
      }

      if (staleCount > 0) {
        console.log(`[Heartbeat] Marked ${staleCount} session(s)/profile(s) as stale, ${affectedAgentIds.size} agent(s) affected`);
        broadcastToAll({ type: "dashboard:updated" });
      }
    } catch (err) {
      console.warn("[Heartbeat] Check failed:", err);
    }
  }

  // Run immediately once, then on interval
  check();
  const timer = setInterval(check, HEARTBEAT_CHECK_INTERVAL_MS);
  // Background maintenance timer — must never keep the process alive on its own
  // (the server stays up via Bun.serve; tests that start the checker without
  // disposing it were leaking a ref'd interval that intermittently blocked
  // teardown). Matches the .unref() convention used by the other background
  // timers (status.ts, processes.ts, terminal.ts, claude-session-tracker.ts).
  if (typeof timer.unref === "function") timer.unref();

  console.log("[Heartbeat] Checker started (every 30s, stale threshold: 2min)");
  // Return a disposer so the caller can stop the checker on shutdown — the
  // interval was previously discarded and leaked (one per call, incl. tests).
  return () => clearInterval(timer);
}
