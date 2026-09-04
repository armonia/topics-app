/**
 * The two dashboard routes — the whole HTTP surface of the feature.
 *
 * @covers DASH-01
 *
 * Why this file exists. On 2026-08-25 an audit of the 310 HTTP routes found
 * `GET /api/dashboard/kpis` and `GET /api/dashboard/timeseries` named by no
 * test at all: 2 out of 2, with five client components behind them
 * (`DashboardPane`, `KPICard`, `KPICardGrid`, `RangeSelector`,
 * `TimeSeriesChart`). `dashboard.spec.ts` exists but never calls the paths, and
 * the one scenario it is remembered for asserts visibility only.
 *
 * What earns a test here is not the arithmetic of any single KPI — that is SQL,
 * and re-implementing it in the assertion would only prove the assertion. It is
 * the SHAPE OF THE ANSWER, which is what the five components are wired to and
 * what breaks silently:
 *
 *  - every KPI key is present on an EMPTY database, as a number. The route
 *    already defends this with `?? 0` on each statement; nothing checked it.
 *    A key that starts arriving as `undefined` renders as an empty card, not
 *    as an error — the dashboard just quietly stops saying something.
 *  - an unknown metric is a 400, not an empty chart. The `default:` branch of
 *    the switch is the difference between "there is no data" and "you asked
 *    for something that does not exist", and a chart cannot tell the two
 *    apart on its own.
 *  - an unknown RANGE is deliberately NOT an error: `rangeToDays` falls back to
 *    7 days. That asymmetry with the metric branch is a real decision and it
 *    should be visible in a test, because the next person to read the switch
 *    will be tempted to make the two consistent.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("dashboard-routes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/dashboard").createDashboardRouter>;

async function call(router: Router, path: string) {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

async function banco(): Promise<Router> {
  const { createDashboardRouter } = await import("../../server/routes/dashboard");
  return createDashboardRouter(await createTestAppContext());
}

/** The same bench, with the database in hand: the seeded KPIs need to write. */
async function benchWithDb(): Promise<{ router: Router; db: import("bun:sqlite").Database }> {
  const { createDashboardRouter } = await import("../../server/routes/dashboard");
  const ctx = await createTestAppContext();
  return { router: createDashboardRouter(ctx), db: ctx.db };
}

/** The keys the dashboard's five components are wired to. */
const KPI_KEYS = [
  "throughputDay",
  "throughputWeek",
  "avgCycleTimeHours",
  "wipCount",
  "errorRate",
  "tokenSpendDay",
  "tokenSpendWeek",
  "tokenSpendDayUncertain",
  "tokenSpendWeekUncertain",
  "approvalTurnaroundHours",
  "pendingApprovals",
] as const;

describe("i numeri del cruscotto", () => {
  test("a database vuoto ogni KPI c'e' ed e' un numero, non un buco", async () => {
    const router = await banco();
    const res = await call(router, "/api/dashboard/kpis");
    expect(res.status).toBe(200);
    const kpi = (await res.json()) as Record<string, unknown>;

    const missing = KPI_KEYS.filter((k) => typeof kpi[k] !== "number");
    expect(missing, "chiavi assenti o non numeriche: la card resta vuota, non rossa").toEqual([]);

    // Empty means zero, not `null`: it is the `?? 0` branch the route puts on
    // every statement, and with no data it is the only one that runs.
    expect(kpi.throughputDay).toBe(0);
    expect(kpi.wipCount).toBe(0);
    expect(kpi.errorRate).toBe(0);
  });

  test("l'errore rate non divide per zero", async () => {
    // `totalSessions > 0 ? ... : 0`. On an empty database the divisor IS zero,
    // and the wrong branch would give `NaN` - which in JSON becomes `null` and
    // on the card becomes a dash, quietly.
    const router = await banco();
    const kpi = (await (await call(router, "/api/dashboard/kpis")).json()) as { errorRate: number };
    expect(Number.isFinite(kpi.errorRate)).toBe(true);
  });
});

describe("i due KPI che descrivevano una popolazione che non esiste", () => {
  test("l'error rate non puo' superare il 100%: numeratore e denominatore sono la stessa popolazione", async () => {
    // The failure this test names: a finished dispatch clears `dispatch_state`
    // and LEAVES `dispatch_error` on the row (it is the tooltip's source). With
    // the old pair those rows stayed in the numerator and left the denominator:
    // 59 over 31 on the production DB, printed on the card as «190.3%».
    const { router, db } = await benchWithDb();
    const seed = (id: string, state: string | null, error: string | null) =>
      db.run(
        `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at,
                            dispatch_attempts, dispatch_state, dispatch_error)
         VALUES (?, 'proj-x', ?, 'in_progress', '2026-09-01', '2026-09-01', 1, ?, ?)`,
        [id, id, state, error],
      );
    seed("kpi-working", "working", null);
    seed("kpi-done-1", null, "x");
    seed("kpi-done-2", null, "x");

    const kpi = (await (await call(router, "/api/dashboard/kpis")).json()) as { errorRate: number };
    expect(kpi.errorRate).toBeLessThanOrEqual(1);
    expect(kpi.errorRate).toBeCloseTo(2 / 3, 3); // the route rounds to 4 decimals

    db.run("DELETE FROM tasks WHERE id LIKE 'kpi-%'");
  });

  test("le approvazioni in attesa sono quelle di un task ancora in review", async () => {
    // Without the join on the task the card counted the whole `approvals`
    // table: 21 pending on the production DB, of which 14 on `done` tasks and 7
    // on archived ones. A red mark nobody can act on - there is no approvals UI
    // in the client, the only way to close a row is to move its task.
    const { router, db } = await benchWithDb();
    const task = (id: string, status: string, archived = 0) =>
      db.run(
        `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, archived)
         VALUES (?, 'proj-x', ?, ?, '2026-09-01', '2026-09-01', ?)`,
        [id, id, status, archived],
      );
    const approval = (id: string, taskId: string) =>
      db.run(
        `INSERT INTO approvals (id, task_id, requested_by, approval_type, status, created_at)
         VALUES (?, ?, 'agent', 'review', 'pending', '2026-09-01')`,
        [id, taskId],
      );
    task("ap-done", "done");
    task("ap-review", "review");
    task("ap-archived", "review", 1);
    approval("a-done", "ap-done");
    approval("a-review", "ap-review");
    approval("a-archived", "ap-archived");

    const kpi = (await (await call(router, "/api/dashboard/kpis")).json()) as { pendingApprovals: number };
    expect(kpi.pendingApprovals).toBe(1);

    db.run("DELETE FROM approvals WHERE id LIKE 'a-%'");
    db.run("DELETE FROM tasks WHERE id LIKE 'ap-%'");
  });
});

describe("la serie storica del cruscotto", () => {
  test("le quattro metriche note rispondono con dei punti", async () => {
    const router = await banco();
    for (const metric of ["throughput", "tokens", "cost", "errors"]) {
      const res = await call(router, `/api/dashboard/timeseries?metric=${metric}&range=7d`);
      expect(res.status, `metrica ${metric}`).toBe(200);
      const { points } = (await res.json()) as { points: Array<{ date: string; value: number }> };
      expect(Array.isArray(points), `metrica ${metric}`).toBe(true);
    }
  });

  test("una metrica che non esiste e' 400, non un grafico vuoto", async () => {
    // The half that makes the test above non-vacuous: here the answer CHANGES.
    // An empty chart and a chart that does not exist are drawn the same way, and
    // only the status code tells them apart.
    const router = await banco();
    const res = await call(router, "/api/dashboard/timeseries?metric=inventata&range=7d");
    expect(res.status).toBe(400);
  });

  test("senza metrica si intende throughput", async () => {
    const router = await banco();
    const res = await call(router, "/api/dashboard/timeseries");
    expect(res.status).toBe(200);
  });

  test("un intervallo sconosciuto NON e' un errore: ripiega su sette giorni", async () => {
    // A deliberate asymmetry with the metric branch, written down here on
    // purpose: whoever reads the `switch` in `rangeToDays` and the one for the
    // metrics will be tempted to make them consistent. The fallback is the right
    // choice - an odd range is a preference, an odd metric is a request with no
    // answer.
    const router = await banco();
    const odd = await call(router, "/api/dashboard/timeseries?metric=throughput&range=999y");
    expect(odd.status).toBe(200);

    const sevenDays = await call(router, "/api/dashboard/timeseries?metric=throughput&range=7d");
    expect(await odd.clone().json()).toEqual(await sevenDays.json());
  });
});
