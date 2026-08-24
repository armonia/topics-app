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

async function chiama(router: Router, path: string) {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

async function banco(): Promise<Router> {
  const { createDashboardRouter } = await import("../../server/routes/dashboard");
  return createDashboardRouter(await createTestAppContext());
}

/** Le chiavi a cui le cinque componenti del cruscotto sono cablate. */
const CHIAVI_KPI = [
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
    const res = await chiama(router, "/api/dashboard/kpis");
    expect(res.status).toBe(200);
    const kpi = (await res.json()) as Record<string, unknown>;

    const mancanti = CHIAVI_KPI.filter((k) => typeof kpi[k] !== "number");
    expect(mancanti, "chiavi assenti o non numeriche: la card resta vuota, non rossa").toEqual([]);

    // Vuoto vuol dire zero, non `null`: e' il ramo `?? 0` che la rotta mette su
    // ogni statement, e senza dati e' l'unico che gira.
    expect(kpi.throughputDay).toBe(0);
    expect(kpi.wipCount).toBe(0);
    expect(kpi.errorRate).toBe(0);
  });

  test("l'errore rate non divide per zero", async () => {
    // `totalSessions > 0 ? … : 0`. Su un database vuoto il divisore E' zero, e
    // il ramo sbagliato darebbe `NaN` — che in JSON diventa `null` e sulla card
    // diventa un trattino, in silenzio.
    const router = await banco();
    const kpi = (await (await chiama(router, "/api/dashboard/kpis")).json()) as { errorRate: number };
    expect(Number.isFinite(kpi.errorRate)).toBe(true);
  });
});

describe("la serie storica del cruscotto", () => {
  test("le quattro metriche note rispondono con dei punti", async () => {
    const router = await banco();
    for (const metric of ["throughput", "tokens", "cost", "errors"]) {
      const res = await chiama(router, `/api/dashboard/timeseries?metric=${metric}&range=7d`);
      expect(res.status, `metrica ${metric}`).toBe(200);
      const { points } = (await res.json()) as { points: Array<{ date: string; value: number }> };
      expect(Array.isArray(points), `metrica ${metric}`).toBe(true);
    }
  });

  test("una metrica che non esiste e' 400, non un grafico vuoto", async () => {
    // La meta' che rende non vacuo il test sopra: qui la risposta CAMBIA. Un
    // grafico vuoto e un grafico che non esiste si disegnano uguali, e solo il
    // codice di stato li distingue.
    const router = await banco();
    const res = await chiama(router, "/api/dashboard/timeseries?metric=inventata&range=7d");
    expect(res.status).toBe(400);
  });

  test("senza metrica si intende throughput", async () => {
    const router = await banco();
    const res = await chiama(router, "/api/dashboard/timeseries");
    expect(res.status).toBe(200);
  });

  test("un intervallo sconosciuto NON e' un errore: ripiega su sette giorni", async () => {
    // Asimmetria voluta rispetto alla metrica, e sta qui scritta apposta: chi
    // legge lo `switch` di `rangeToDays` e quello delle metriche e' tentato di
    // renderli coerenti. Il ripiego e' la scelta giusta — un intervallo strano
    // e' una preferenza, una metrica strana e' una richiesta senza risposta.
    const router = await banco();
    const strano = await chiama(router, "/api/dashboard/timeseries?metric=throughput&range=999y");
    expect(strano.status).toBe(200);

    const sette = await chiama(router, "/api/dashboard/timeseries?metric=throughput&range=7d");
    expect(await strano.clone().json()).toEqual(await sette.json());
  });
});
