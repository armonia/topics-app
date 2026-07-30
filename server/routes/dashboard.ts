import type { AppContext, RouteHandler } from "../types";

/**
 * KPI e serie della Dashboard.
 *
 * Meta' dei numeri erano strutturalmente zero, e uno zero e' la bugia peggiore
 * che un cruscotto possa dire: "error rate 0%" si legge "nessun errore", non
 * "nessun dato". Le query leggevano tre tabelle che NESSUNO scrive —
 * `usage_records` (l'unico insert e' in `server/db/seed.ts`, che non e' chiamato
 * da nessuna parte), `agent_sessions` (zero insert in tutto il server) e
 * `heartbeats` (la route POST c'e', ma pretende una riga di `agent_sessions`
 * che non esiste, quindi non e' raggiungibile).
 *
 * Il dato vero c'era altrove, misurato sul DB di sviluppo:
 *   • `messages.cost_cents` + `usage_*_tokens` — 678 messaggi con costo, il
 *     consumo delle chat;
 *   • `tasks.agent_tokens` / `agent_cache_read_tokens` (migration 040/048) —
 *     94 task, 42,9M token di lavoro e 534M di rilettura di contesto;
 *   • `tasks.dispatch_state` / `dispatch_error` — il segnale di errore che
 *     `agent_sessions` avrebbe dovuto portare.
 *
 * Quello che NON ha una fonte resta dichiarato tale: `agentUtilization` torna
 * `null`, non 0, e la UI disegna "—". Inventare un valore plausibile al posto di
 * un dato mancante e' esattamente il guasto che questo commento chiude.
 */
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
    // Il tasso d'errore e' quello dei DISPATCH: `agent_sessions` non ha un solo
    // insert in tutto il server, quindi la vecchia coppia dava 0/0 per sempre.
    // Il denominatore sono i task che sono stati effettivamente dispatchati
    // (`dispatch_state` non nullo), non tutti i task: includere backlog e todo
    // diluirebbe il tasso con lavoro mai partito.
    errorSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE dispatch_state = 'failed' OR dispatch_error IS NOT NULL
    `),
    totalSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE dispatch_state IS NOT NULL
    `),
    // `messages.timestamp` e' ISO-8601 UTC in TEXT ('2026-07-30T09:12:00.000Z'),
    // quindi il confronto con `date('now', ...)` — che rende 'YYYY-MM-DD', anche
    // lui UTC — e' lessicografico e corretto: ogni istante del giorno ordina
    // dopo la sua mezzanotte e prima di quella dopo.
    tokenSpendDay: db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages
      WHERE timestamp >= date('now', 'start of day')
    `),
    tokenSpendWeek: db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages
      WHERE timestamp >= date('now', '-7 days')
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
    // I token vengono da DUE posti, e sommarli e' il punto: le chat
    // (`messages`) e gli agenti dispatchati sul board (`tasks`, migration
    // 040/048). Guardarne solo uno faceva sembrare scarico proprio il giorno in
    // cui la board aveva lavorato di piu'. La rilettura di cache e' compresa —
    // e' la quota dominante del consumo reale, ~60% misurato.
    tokensSeries: db.prepare(`
      SELECT date, SUM(value) as value FROM (
        SELECT date(timestamp) as date,
               SUM(COALESCE(usage_prompt_tokens, 0) + COALESCE(usage_completion_tokens, 0)) as value
        FROM messages
        WHERE timestamp >= date('now', ? || ' days')
        GROUP BY date(timestamp)
        UNION ALL
        SELECT date(completed_at) as date,
               SUM(agent_tokens + agent_cache_read_tokens) as value
        FROM tasks
        WHERE completed_at IS NOT NULL AND completed_at >= date('now', ? || ' days')
        GROUP BY date(completed_at)
      )
      WHERE date IS NOT NULL
      GROUP BY date
      ORDER BY date
    `),
    // In dollari solo cio' che ha un costo REGISTRATO. `tasks.agent_tokens` e'
    // un totale senza la scomposizione input/output, quindi tariffarlo sarebbe
    // inventare una precisione che il dato non ha: il consumo degli agenti
    // compare nella serie dei TOKEN, dove e' un fatto.
    costSeries: db.prepare(`
      SELECT date(timestamp) as date, SUM(COALESCE(cost_cents, 0)) / 100.0 as value
      FROM messages
      WHERE timestamp >= date('now', ? || ' days')
      GROUP BY date(timestamp)
      ORDER BY date
    `),
    errorsSeries: db.prepare(`
      SELECT date(updated_at) as date, COUNT(*) as value
      FROM tasks
      WHERE (dispatch_state = 'failed' OR dispatch_error IS NOT NULL)
        AND updated_at >= date('now', ? || ' days')
      GROUP BY date(updated_at)
      ORDER BY date(updated_at)
    `),

    // ── Agent stats ────────────────────────────────────────────────────

    // La classifica degli agenti veniva da `agent_sessions`, che nessuno
    // scrive: ogni agente compariva con tutti zeri. La fonte vera e' `tasks` —
    // `assigned_agent_id` (scritto alla presa in carico, `services/tasks.ts`),
    // `agent_tokens`/`agent_cache_read_tokens` e i tempi.
    //
    // LIMITE DICHIARATO: `assigned_agent_id` viene AZZERATO quando il task
    // esce dalla presa in carico (rollback e consegna), quindi sui task chiusi
    // l'attribuzione all'agente non resta. Finche' e' cosi', la classifica
    // mostra solo il lavoro IN CORSO. Non lo si aggira sommando altrove: la
    // colonna che manca e' "chi ha consegnato", ed e' un'altra modifica.
    agentStats: db.prepare(`
      SELECT
        ap.id as agent_id,
        ap.name as agent_name,
        ap.avatar_emoji,
        COALESCE(t.done_cnt, 0) as tasks_completed,
        COALESCE(t.tokens, 0) as total_tokens,
        COALESCE(t.avg_cycle, 0) as avg_cycle_time_hours,
        CASE WHEN COALESCE(t.dispatched, 0) = 0 THEN 0
             ELSE CAST(COALESCE(t.failed, 0) AS REAL) / t.dispatched
        END as error_rate,
        COALESCE(t.cnt, 0) as sessions_count
      FROM agent_profiles ap
      LEFT JOIN (
        SELECT assigned_agent_id as agent_id,
               COUNT(*) as cnt,
               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_cnt,
               SUM(agent_tokens + agent_cache_read_tokens) as tokens,
               AVG(CASE WHEN status = 'done' AND completed_at IS NOT NULL
                        THEN (julianday(completed_at) - julianday(created_at)) * 24 END) as avg_cycle,
               SUM(CASE WHEN dispatch_state IS NOT NULL THEN 1 ELSE 0 END) as dispatched,
               SUM(CASE WHEN dispatch_state = 'failed' OR dispatch_error IS NOT NULL THEN 1 ELSE 0 END) as failed
        FROM tasks
        WHERE assigned_agent_id IS NOT NULL
        GROUP BY assigned_agent_id
      ) t ON t.agent_id = ap.id
      ORDER BY tasks_completed DESC, sessions_count DESC
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

        // `heartbeats` non ha una fonte: la route POST che la popola
        // (`/api/agents/sessions/:key/heartbeat`) pretende una riga di
        // `agent_sessions`, e quella tabella non ha un solo insert in tutto il
        // server. Senza denominatore il KPI e' NON DISPONIBILE, e va detto:
        // restituire 0 significa "gli agenti sono fermi", che e' un'altra cosa.
        const activeHB = (stmts.activeHeartbeatsLastHour.get() as any)?.count ?? 0;
        const totalHB = (stmts.totalHeartbeatsLastHour.get() as any)?.count ?? 0;
        const agentUtilization = totalHB > 0 ? activeHB / totalHB : null;

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
          agentUtilization:
            agentUtilization === null ? null : Math.round(agentUtilization * 10000) / 10000,
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
