import type { Database } from "bun:sqlite";

const HEARTBEAT_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export function startHeartbeatChecker(db: Database, broadcastToAll: (msg: object) => void): void {
  const staleSessionsStmt = db.prepare(`
    SELECT id, agent_id, session_key, last_heartbeat
    FROM agent_sessions
    WHERE status = 'active'
      AND last_heartbeat IS NOT NULL
      AND datetime(last_heartbeat) < datetime('now', '-2 minutes')
  `);

  const markSessionStale = db.prepare(`
    UPDATE agent_sessions SET status = 'stale' WHERE id = ?
  `);

  const markProfileOffline = db.prepare(`
    UPDATE agent_profiles SET status = 'offline', updated_at = ? WHERE id = ?
  `);

  // Check for sessions without any heartbeat that started more than 2 minutes ago
  const noHeartbeatSessionsStmt = db.prepare(`
    SELECT id, agent_id, session_key, started_at
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
        markSessionStale.run(session.id);
        if (session.agent_id) {
          affectedAgentIds.add(session.agent_id);
        }
        staleCount++;
      }

      // Check sessions that never sent a heartbeat
      const noHeartbeatSessions = noHeartbeatSessionsStmt.all() as any[];
      for (const session of noHeartbeatSessions) {
        markSessionStale.run(session.id);
        if (session.agent_id) {
          affectedAgentIds.add(session.agent_id);
        }
        staleCount++;
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
