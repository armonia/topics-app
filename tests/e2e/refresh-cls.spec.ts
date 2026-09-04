import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp, ensureTopicVisible, openTopic } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import {
  armObserver,
  buildReport,
  collectShifts,
  summarize,
  writeReport,
  type ClsReport as ReturnReport,
} from "./helpers/cls-return";

hermetic(test);

/**
 * REFRESH-CLS — il refresh è un RITORNO, e un ritorno non sposta niente.
 *
 * IL METODO, dichiarato una volta qui perché altrimenti i numeri non sono
 * confrontabili (e un numero non confrontabile non è una misura):
 *
 *  · Si misura il SECONDO caricamento, non il primo. Il primo serve solo a
 *    scaldare quello che il client tiene in locale (pane-store, cache dei
 *    messaggi, preferenze): è la partenza. Quello che Attilio guarda è il
 *    `page.reload()` che viene dopo — il ritorno.
 *  · L'osservatore si registra in un `addInitScript`, quindi PRIMA di
 *    qualunque riga della app, con `buffered: true`: nessuno shift può
 *    accadere prima che qualcuno stia guardando.
 *  · CLS = definizione web-vitals: si sommano le entrate con
 *    `hadRecentInput === false` dentro finestre di sessione (gap max 1s,
 *    durata max 5s) e si tiene la finestra PIÙ GRANDE. Riportiamo accanto
 *    anche la somma nuda (`total`), che è sempre ≥ e serve solo a vedere se
 *    la differenza fra le due nasconde qualcosa.
 *  · Finestra di osservazione: 6s dal reload, senza interazione. Zero click,
 *    zero scroll — ogni shift misurato è quindi roba che è arrivata da sola.
 *  · Viewport fissi e dichiarati: 390×844 (telefono) e 1440×900 (desktop),
 *    `deviceScaleFactor` di default, nessuna strozzatura di CPU o rete: la
 *    stessa macchina prima e dopo, altrimenti si misura la macchina.
 *
 * Ogni shift viene ATTRIBUITO: per ogni sorgente il nodo che si è mosso, con
 * il suo rettangolo prima e dopo. È quella lista, non il numero, che dice
 * COSA arrivava tardi — il numero dice solo quanto è costato.
 *
 * L'artefatto finisce in `test-results/cls/<label>-<viewport>.json` così che
 * PRIMA e DOPO siano due file confrontabili riga per riga.
 * Si lancia:  E2E_CLS_LABEL=prima npx playwright test refresh-cls
 *
 * @covers PERF-01
 */

/**
 * The ceiling for a RETURN is not the 0.1 that `performance/spec.md` grants
 * the first render: a return has nothing to discover, so anything that moves
 * is something that arrived late. 0.01 is the measurement's own noise (the
 * digits of a presence chip, a toast easing in), not a tolerance for content.
 * The old curtain scored 0.054 on this very scenario and passed the 0.1 bar
 * while the whole column jumped under the reader's eyes (2026-09-03).
 */
const RETURN_BUDGET = 0.01;

const LABEL = process.env.E2E_CLS_LABEL || "run";

/** Le misure del contenuto VERO, a lista posata. Servono a poter dire se uno
 *  scheletro è realistico con un numero invece che a occhio: uno scheletro che
 *  non ha le misure del contenuto vero è un layout shift col cappello. */
type Geometry = { sidebarRow: number | null; messageRows: number[] };
type ClsReport = ReturnReport & { geometry: Geometry };

async function collect(page: Page): Promise<ClsReport> {
  const shifts = await collectShifts(page);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('[role="treeitem"]');
    const items = [...document.querySelectorAll('[data-testid="virtuoso-item-list"] > *')]
      .slice(0, 6)
      .map((el) => Math.round(el.getBoundingClientRect().height));
    return {
      sidebarRow: row ? Math.round(row.getBoundingClientRect().height) : null,
      messageRows: items,
    };
  });
  return { ...buildReport(shifts, { geometry }), geometry };
}

/**
 * What arrived while you were away. Between the departure and the return a
 * reply lands on the server that the local copy does not have yet, and it
 * carries a screenshot the browser has never fetched. That is the ordinary
 * shape of a return — an agent answered, you reload — and it is the one the
 * curtain used to lift too early on: measured 2026-09-03 on the desktop's own
 * state, the list revealed from the cache, then re-anchored when the history
 * came (item list 5.8k -> 18.5k px) and jumped 640 px again when the image got
 * its height. CLS 0.08 to 0.24 on a gesture whose contract is zero.
 */
async function replyWhileAway(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  // The route answers `{ topics: { [id]: topic } }`, a map and not a list.
  const body = (await res.json()) as { topics?: Record<string, { id: string; name?: string; sessionKey?: string }> };
  const topics = Object.values(body.topics ?? {});
  const topic = topics.find((t) => /Web Search Test/.test(t.name ?? ""));
  if (!topic) throw new Error("il topic «Web Search Test» del seed non c'è");
  const sessionKey = topic.sessionKey ?? `topic:${topic.id.slice(0, 8)}`;
  await seedMessage(request, {
    sessionKey,
    role: "assistant",
    content: `Ecco lo screenshot della pagina che mi hai chiesto.\n\n![pagina](${E2E_BASE}/icons/icon-512.png)\n\nIl titolo e la tabella dei prezzi sono dove li aspettavi.`,
  });
}

async function measureRefresh(page: Page, request: APIRequestContext, name: string): Promise<ClsReport> {
  // 1) La PARTENZA. Serve solo a riempire ciò che il client tiene in locale.
  await goToApp(page);
  await ensureTopicVisible(page, /Web Search Test/);
  await openTopic(page, /Web Search Test/);
  await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15000 });
  // Il primo caricamento deve essersi POSATO, altrimenti il reload eredita
  // lavoro in corso e misuriamo la coda della partenza invece del ritorno.
  await page.waitForTimeout(3000);

  // 1b) Meanwhile, on the server, a reply with an image has landed.
  await replyWhileAway(request);

  // 2) IL RITORNO. Da qui in poi nessuna interazione: ogni movimento è roba
  //    che è arrivata da sola.
  await armObserver(page);
  await page.reload({ waitUntil: "commit" });
  await page.waitForTimeout(6000);

  const report = await collect(page);
  const file = writeReport(LABEL, name, report);
  console.log(
    `\n[cls:${LABEL}:${name}] CLS=${report.cls.toFixed(4)} total=${report.total.toFixed(4)} shifts=${report.count}` +
    `\n[geom:${LABEL}:${name}] riga-sidebar=${report.geometry.sidebarRow}px messaggi=[${report.geometry.messageRows.join(', ')}]px` +
    `\n${summarize(report)}\n→ ${file}\n`,
  );
  return report;
}

test.describe("CLS del refresh — telefono 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("un ritorno non sposta niente", async ({ page, request }) => {
    const r = await measureRefresh(page, request, "390x844");
    expect(r.cls, `chi si e' mosso:\n${summarize(r)}`).toBeLessThanOrEqual(RETURN_BUDGET);
  });
});

test.describe("CLS del refresh — desktop 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("un ritorno non sposta niente", async ({ page, request }) => {
    const r = await measureRefresh(page, request, "1440x900");
    expect(r.cls, `chi si e' mosso:\n${summarize(r)}`).toBeLessThanOrEqual(RETURN_BUDGET);
  });
});
