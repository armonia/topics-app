import type { Database } from "bun:sqlite";
import {
  applySessionTransition,
  parseAgentSessionState,
  type AgentSessionState,
} from "./agent-fsm";

const HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export function startHeartbeatChecker(db: Database, broadcastToAll: (msg: object) => void): void {
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

  const markProfileOffline = db.prepare(`
    UPDATE agent_profiles SET status = 'offline', updated_at = ? WHERE id = ?
  `);

  // Check for sessions without any heartbeat that started more than 2 minutes ago
  const noHeartbeatSessionsStmt = db.prepare(`
    SELECT id, agent_id, session_key, started_at, status
    FROM agent_sessions
    WHERE status = 'active'
      AND last_heartbeat IS NULL
      AND datetime(started_at) < datetime('now', '-2 minutes')
  `);

  function check() {
    try {
      const now = new Date().toISOString();
      let staleCount = 0;
      const affectedAgentIds = new Set<string>();

      // Check sessions with stale heartbeats
      const staleSessions = staleSessionsStmt.all() as any[];
      for (const session of staleSessions) {
        if (transitionSessionTo(session, 'stale')) {
          if (session.agent_id) {
            affectedAgentIds.add(session.agent_id);
          }
          staleCount++;
        }
      }

      // Check sessions that never sent a heartbeat
      const noHeartbeatSessions = noHeartbeatSessionsStmt.all() as any[];
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
        const activeCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_sessions WHERE agent_id = ? AND status IN ('active', 'paused')`
        ).get(agentId) as any;

        if (!activeCount || activeCount.cnt === 0) {
          markProfileOffline.run(now, agentId);
        }
      }

      // Also check agent profiles using last_seen_at (for agent API heartbeats)
      const staleProfiles = db.prepare(`
        SELECT id FROM agent_profiles
        WHERE status NOT IN ('offline', 'paused')
          AND last_seen_at IS NOT NULL
          AND datetime(last_seen_at) < datetime('now', '-2 minutes')
      `).all() as any[];

      for (const profile of staleProfiles) {
        // Only mark offline if no active sessions
        const activeCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_sessions WHERE agent_id = ? AND status IN ('active', 'paused')`
        ).get(profile.id) as any;

        if (!activeCount || activeCount.cnt === 0) {
          markProfileOffline.run(now, profile.id);
          staleCount++;
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
  setInterval(check, HEARTBEAT_CHECK_INTERVAL_MS);

  console.log("[Heartbeat] Checker started (every 30s, stale threshold: 2min)");
}
