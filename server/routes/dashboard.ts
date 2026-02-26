import type { AppContext, RouteHandler } from "../types";

export function createDashboardRouter(ctx: AppContext): RouteHandler {
  const { db, json, errorResponse } = ctx;

  // ── KPI prepared statements ────────────────────────────────────────────

  const stmts = {
    throughputDay: db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'done' AND completed_at >= date('now', 'start of day')
    `),
    throughputWeek: db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'done' AND completed_at >= date('now', 'weekday 0', '-7 days')
    `),
    avgCycleTime: db.prepare(`
      SELECT AVG(julianday(completed_at) - julianday(created_at)) * 24 as avg_hours
      FROM tasks
      WHERE status = 'done' AND completed_at IS NOT NULL AND created_at IS NOT NULL
    `),
    wipCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'
    `),
    errorSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM agent_sessions WHERE status = 'error'
    `),
    totalSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM agent_sessions
    `),
    tokenSpendDay: db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
      WHERE timestamp >= strftime('%s', date('now', 'start of day')) * 1000
    `),
    tokenSpendWeek: db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
      WHERE timestamp >= strftime('%s', date('now', 'weekday 0', '-7 days')) * 1000
    `),
    activeHeartbeatsLastHour: db.prepare(`
      SELECT COUNT(*) as count FROM heartbeats
      WHERE status = 'active'
        AND timestamp >= strftime('%s', datetime('now', '-1 hour')) * 1000
    `),
    totalHeartbeatsLastHour: db.prepare(`
      SELECT COUNT(*) as count FROM heartbeats
      WHERE timestamp >= strftime('%s', datetime('now', '-1 hour')) * 1000
    `),
    approvalTurnaround: db.prepare(`
      SELECT AVG((julianday(reviewed_at) - julianday(created_at)) * 24) as avg_hours
      FROM approvals
      WHERE status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL
    `),
    pendingApprovals: db.prepare(`
      SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'
    `),

    // ── Time series ────────────────────────────────────────────────────

    throughputSeries: db.prepare(`
      SELECT date(completed_at) as date, COUNT(*) as value
      FROM tasks
      WHERE status = 'done'
        AND completed_at >= date('now', ? || ' days')
      GROUP BY date(completed_at)
      ORDER BY date(completed_at)
    `),
    tokensSeries: db.prepare(`
      SELECT date(datetime(timestamp / 1000, 'unixepoch')) as date,
             SUM(total_tokens) as value
      FROM usage_records
      WHERE timestamp >= strftime('%s', date('now', ? || ' days')) * 1000
      GROUP BY date(datetime(timestamp / 1000, 'unixepoch'))
      ORDER BY date
    `),
    costSeries: db.prepare(`
      SELECT date(datetime(timestamp / 1000, 'unixepoch')) as date,
             SUM(cost_usd) as value
      FROM usage_records
      WHERE timestamp >= strftime('%s', date('now', ? || ' days')) * 1000
      GROUP BY date(datetime(timestamp / 1000, 'unixepoch'))
      ORDER BY date
    `),
    errorsSeries: db.prepare(`
      SELECT date(started_at) as date, COUNT(*) as value
      FROM agent_sessions
      WHERE status = 'error'
        AND started_at >= date('now', ? || ' days')
      GROUP BY date(started_at)
      ORDER BY date(started_at)
    `),

    // ── Agent stats ────────────────────────────────────────────────────

    agentStats: db.prepare(`
      SELECT
        ap.id as agent_id,
        ap.name as agent_name,
        ap.avatar_emoji,
        COALESCE(completed.cnt, 0) as tasks_completed,
        COALESCE(sess.total_tokens, 0) as total_tokens,
        COALESCE(completed.avg_cycle, 0) as avg_cycle_time_hours,
        CASE WHEN COALESCE(sess.total_sessions, 0) = 0 THEN 0
             ELSE CAST(COALESCE(sess.error_sessions, 0) AS REAL) / sess.total_sessions
        END as error_rate,
        COALESCE(sess.total_sessions, 0) as sessions_count
      FROM agent_profiles ap
      LEFT JOIN (
        SELECT s.agent_id,
               COUNT(DISTINCT t.id) as cnt,
               AVG((julianday(t.completed_at) - julianday(t.created_at)) * 24) as avg_cycle
        FROM agent_sessions s
        JOIN tasks t ON t.id = s.task_id AND t.status = 'done' AND t.completed_at IS NOT NULL
        GROUP BY s.agent_id
      ) completed ON completed.agent_id = ap.id
      LEFT JOIN (
        SELECT agent_id,
               SUM(total_tokens) as total_tokens,
               COUNT(*) as total_sessions,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_sessions
        FROM agent_sessions
        GROUP BY agent_id
      ) sess ON sess.agent_id = ap.id
      ORDER BY tasks_completed DESC
    `),
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  function rangeToDays(range: string): string {
    switch (range) {
      case '1d': return '-1';
      case '7d': return '-7';
      case '30d': return '-30';
      default: return '-7';
    }
  }

  // ── Route handler ────────────────────────────────────────────────────

  return async function dashboardRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    // GET /api/dashboard/kpis
    if (method === 'GET' && pathname === '/api/dashboard/kpis') {
      try {
        const throughputDay = (stmts.throughputDay.get() as any)?.count ?? 0;
        const throughputWeek = (stmts.throughputWeek.get() as any)?.count ?? 0;
        const avgCycleTimeHours = (stmts.avgCycleTime.get() as any)?.avg_hours ?? 0;
        const wipCount = (stmts.wipCount.get() as any)?.count ?? 0;

        const errorSessions = (stmts.errorSessionCount.get() as any)?.count ?? 0;
        const totalSessions = (stmts.totalSessionCount.get() as any)?.count ?? 0;
        const errorRate = totalSessions > 0 ? errorSessions / totalSessions : 0;

        const tokenSpendDay = (stmts.tokenSpendDay.get() as any)?.total ?? 0;
        const tokenSpendWeek = (stmts.tokenSpendWeek.get() as any)?.total ?? 0;

        const activeHB = (stmts.activeHeartbeatsLastHour.get() as any)?.count ?? 0;
        const totalHB = (stmts.totalHeartbeatsLastHour.get() as any)?.count ?? 0;
        const agentUtilization = totalHB > 0 ? activeHB / totalHB : 0;

        const approvalTurnaroundHours = (stmts.approvalTurnaround.get() as any)?.avg_hours ?? 0;
        const pendingApprovals = (stmts.pendingApprovals.get() as any)?.count ?? 0;

        return json({
          throughputDay,
          throughputWeek,
          avgCycleTimeHours: Math.round(avgCycleTimeHours * 100) / 100,
          wipCount,
          errorRate: Math.round(errorRate * 10000) / 10000,
          tokenSpendDay: Math.round(tokenSpendDay * 100) / 100,
          tokenSpendWeek: Math.round(tokenSpendWeek * 100) / 100,
          agentUtilization: Math.round(agentUtilization * 10000) / 10000,
          approvalTurnaroundHours: Math.round(approvalTurnaroundHours * 100) / 100,
          pendingApprovals,
        });
      } catch (err: any) {
        console.error('[Dashboard] KPI error:', err);
        return errorResponse(500, err.message || 'Failed to compute KPIs');
      }
    }

    // GET /api/dashboard/timeseries?metric=throughput&range=7d
    if (method === 'GET' && pathname === '/api/dashboard/timeseries') {
      const metric = url.searchParams.get('metric') || 'throughput';
      const range = url.searchParams.get('range') || '7d';
      const days = rangeToDays(range);

      try {
        let rows: any[] = [];
        switch (metric) {
          case 'throughput':
            rows = stmts.throughputSeries.all(days) as any[];
            break;
          case 'tokens':
            rows = stmts.tokensSeries.all(days) as any[];
            break;
          case 'cost':
            rows = stmts.costSeries.all(days) as any[];
            break;
          case 'errors':
            rows = stmts.errorsSeries.all(days) as any[];
            break;
          default:
            return errorResponse(400, `Unknown metric: ${metric}`);
        }

        const points = rows.map((r: any) => ({
          date: r.date,
          value: Math.round((r.value ?? 0) * 100) / 100,
        }));

        return json({ points });
      } catch (err: any) {
        console.error('[Dashboard] TimeSeries error:', err);
        return errorResponse(500, err.message || 'Failed to compute time series');
      }
    }

    // GET /api/dashboard/agent-stats
    if (method === 'GET' && pathname === '/api/dashboard/agent-stats') {
      try {
        const rows = stmts.agentStats.all() as any[];
        const agents = rows.map((r: any) => ({
          agentId: r.agent_id,
          agentName: r.agent_name,
          avatarEmoji: r.avatar_emoji || '',
          tasksCompleted: r.tasks_completed,
          totalTokens: r.total_tokens,
          avgCycleTimeHours: Math.round((r.avg_cycle_time_hours ?? 0) * 100) / 100,
          errorRate: Math.round((r.error_rate ?? 0) * 10000) / 10000,
          sessionsCount: r.sessions_count,
        }));

        return json({ agents });
      } catch (err: any) {
        console.error('[Dashboard] AgentStats error:', err);
        return errorResponse(500, err.message || 'Failed to compute agent stats');
      }
    }

    return null;
  };
}
