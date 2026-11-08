import type { AppContext, RouteHandler } from "../types";
import { costFromMessage, costFromTask } from "../usage/token-sql";

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
 * Quello che NON ha una fonte non si disegna affatto: `agentUtilization` (che
 * tornava sempre `null`) e la classifica per agente sono uscite insieme al
 * concetto di agente con un nome — un agente e' il provider che hai scelto, e
 * il lavoro si conta per TASK. Inventare un valore plausibile al posto di un
 * dato mancante e' il guasto che questo commento chiude; disegnare una scheda
 * che non puo' che dire "—" e' lo stesso guasto in forma piu' educata.
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
    //
    // THE TWO COUNTS MUST DESCRIBE THE SAME POPULATION, and until 2026-09-05
    // they did not: the numerator kept every row carrying a `dispatch_error`,
    // the denominator only the rows with a LIVE `dispatch_state`. A dispatch
    // that ends clears the state and leaves the error on the row (it is the
    // tooltip's source), so a finished failure left the numerator and not the
    // denominator: 59 over 31 on the production DB, a rate of 190.3% printed
    // as a percentage on a card. `dispatch_attempts > 0` is the honest
    // denominator - "this task was actually dispatched at least once" - it
    // survives the state being cleared, and it is on the same table.
    errorSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE dispatch_attempts > 0
        AND (dispatch_state = 'failed' OR dispatch_error IS NOT NULL)
    `),
    totalSessionCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE dispatch_attempts > 0
    `),
    // `messages.timestamp` e' ISO-8601 UTC in TEXT ('2026-07-30T09:12:00.000Z'),
    // quindi il confronto con `date('now', ...)` — che rende 'YYYY-MM-DD', anche
    // lui UTC — e' lessicografico e corretto: ogni istante del giorno ordina
    // dopo la sua mezzanotte e prima di quella dopo.
    // `cache_read_tokens IS NOT NULL` non e' un dettaglio tecnico: e' il
    // predicato di ATTENDIBILITA' del costo, e in questo schema esiste gia'.
    //
    // Una riga senza lo scorporo della cache e' stata tariffata contando come
    // input fresco anche i token RILETTI dalla cache, che in un turno agentico
    // sono la quota schiacciante: il suo `cost_cents` e' gonfiato fino a ~10
    // volte, di un fattore che non e' ricostruibile perche' le quote non sono
    // state salvate. Sommarle insieme alle righe buone produceva un totale che
    // non e' ne' il costo vero ne' una sua stima — sul DB di prod, 8.839$ di
    // righe cosi' accanto a 215$ di righe misurate.
    //
    // Quindi non si sommano, e non si nascondono: le due query gemelle le
    // CONTANO, e il KPI porta quel numero accanto al totale (`…Uncertain`). Un
    // dato mancante dichiarato e' informazione; sommato di nascosto e' una bugia.
    tokenSpendDay: db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages
      WHERE timestamp >= date('now', 'start of day')
        AND cache_read_tokens IS NOT NULL
    `),
    tokenSpendWeek: db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) / 100.0 as total FROM messages
      WHERE timestamp >= date('now', '-7 days')
        AND cache_read_tokens IS NOT NULL
    `),
    tokenSpendDayUncertain: db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE timestamp >= date('now', 'start of day')
        AND cost_cents > 0 AND cache_read_tokens IS NULL
    `),
    tokenSpendWeekUncertain: db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE timestamp >= date('now', '-7 days')
        AND cost_cents > 0 AND cache_read_tokens IS NULL
    `),
    approvalTurnaround: db.prepare(`
      SELECT AVG((julianday(reviewed_at) - julianday(created_at)) * 24) as avg_hours
      FROM approvals
      WHERE status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL
    `),
    // AN APPROVAL IS PENDING ONLY IF ITS TASK IS STILL WAITING FOR ONE. The
    // count used to read the `approvals` table alone, and the card showed it as
    // a red signal you cannot act on: there is no approvals UI in the client,
    // the only way to close a row is to move its task. On the production DB, 21
    // pending of which 14 on `done` tasks and 7 on archived ones, the oldest
    // from 2026-07-12 - a permanent red mark with nothing behind it. The task
    // is the truth: in review, not archived.
    pendingApprovals: db.prepare(`
      SELECT COUNT(*) as count
        FROM approvals a
        JOIN tasks t ON t.id = a.task_id
       WHERE a.status = 'pending' AND t.status = 'review' AND t.archived = 0
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
    // cui la board aveva lavorato di piu'.
    //
    // Il NUMERO e' quanto e' costato, non quanti token sono passati: le due
    // tabelle scompongono le stesse quantita' in modo diverso, e la traduzione
    // sta in `server/usage/token-sql.ts` accanto alla regola condivisa. Prima
    // qui la rilettura di cache valeva un token fresco, mentre la card la
    // buttava via del tutto: due numeri per la stessa domanda.
    tokensSeries: db.prepare(`
      SELECT date, SUM(value) as value FROM (
        SELECT date(timestamp) as date,
               SUM(${costFromMessage}) as value
        FROM messages
        WHERE timestamp >= date('now', ? || ' days')
        GROUP BY date(timestamp)
        UNION ALL
        SELECT date(completed_at) as date,
               SUM(${costFromTask}) as value
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
    // Stesso gate dei KPI: la serie disegna i giorni col costo MISURATO. Una
    // riga anteriore allo scorporo della cache alzerebbe la sua giornata di un
    // fattore ignoto, e una curva con dentro due unita' di misura diverse non e'
    // una curva.
    costSeries: db.prepare(`
      SELECT date(timestamp) as date, SUM(COALESCE(cost_cents, 0)) / 100.0 as value
      FROM messages
      WHERE timestamp >= date('now', ? || ' days')
        AND cache_read_tokens IS NOT NULL
      GROUP BY date(timestamp)
      ORDER BY date
    `),
    // Same population as the KPI above: a row without an attempt never
    // dispatched, so it cannot be a dispatch error.
    errorsSeries: db.prepare(`
      SELECT date(updated_at) as date, COUNT(*) as value
      FROM tasks
      WHERE dispatch_attempts > 0
        AND (dispatch_state = 'failed' OR dispatch_error IS NOT NULL)
        AND updated_at >= date('now', ? || ' days')
      GROUP BY date(updated_at)
      ORDER BY date(updated_at)
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
    _req: Request,
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
        // Quante righe sono state ESCLUSE dai due totali perche' il loro costo
        // non e' attendibile. Zero quasi sempre: sono righe vecchie.
        const tokenSpendDayUncertain = (stmts.tokenSpendDayUncertain.get() as any)?.count ?? 0;
        const tokenSpendWeekUncertain = (stmts.tokenSpendWeekUncertain.get() as any)?.count ?? 0;

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
          tokenSpendDayUncertain,
          tokenSpendWeekUncertain,
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
            // TWICE, not once: `tokensSeries` is the only one of the four that
            // JOINS two tables (`messages` and `tasks`), so it has one `?` per
            // branch. With a single argument SQLite rejects the statement and
            // the route answers 500 - always, on any database. Measured on
            // 25/08/2026 on the production server: throughput, cost and errors
            // answered 200 and `tokens` was the only route at 500, meaning the
            // dashboard's token chart has never worked. Nobody had noticed
            // because no test exercised these two routes
            // (`dashboard-routes.test.ts` was born for this).
            rows = stmts.tokensSeries.all(days, days) as any[];
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

    return null;
  };
}
