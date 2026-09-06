/**
 * notification-history.spec.ts — la CRONOLOGIA delle notifiche, accanto a Topics.
 *
 * Questa spec È la barra della consegna, punto per punto:
 *   NH-01  arriva una notifica con l'app aperta → il contatore sale DA SOLO
 *          (fronte WS, nessun refresh), si apre la cronologia, si clicca la
 *          riga e si finisce esattamente sulla cosa che l'ha generata.
 *   NH-02  il contatore torna a zero quando le si guarda, e ci resta dopo un
 *          ricaricamento (il «visto» sta sulla riga, non nella memoria di una
 *          finestra).
 *   NH-03  una notifica RAGGRUPPATA, vista una volta, non fa risalire il
 *          contatore: il «visto» vale per tutto il gruppo.
 *   NH-04  al riavvio non ricompare niente di vecchio come nuovo, e un secondo
 *          mittente dello stesso evento (banner + push, o N finestre) non
 *          raddoppia la riga.
 *
 * Il registro si semina dalla sua rotta pubblica (`POST /api/notifications`),
 * che è la stessa porta che il client usa quando manda un banner: seminare
 * scrivendo in tabella proverebbe la tabella, non la catena.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-notif-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
let taskId = "";

async function postNotification(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ recorded: boolean; unseen: number }> {
  const res = await request.post(`${BASE}/api/notifications`, { data: body });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { recorded: boolean; unseen: number };
}

/** Il registro riparte pulito prima di ogni prova: il conteggio è
 *  un'asserzione, e un residuo del test precedente lo renderebbe illeggibile. */
async function wipeRegistry(request: APIRequestContext): Promise<void> {
  // Non c'è (di proposito) una rotta che CANCELLA la cronologia: si segna tutto
  // visto fino ad adesso, che è ciò che azzera il contatore.
  await request.post(`${BASE}/api/notifications/seen`, { data: { upTo: new Date().toISOString() } });
}

const bell = (page: Page) => page.getByTestId("notification-history-button");
const panel = (page: Page) => page.getByTestId("notification-history-panel");
const rows = (page: Page) => page.getByTestId("notification-history-row");
/** Il numero sul tastino: il badge condiviso, che si nasconde a zero.
 *  Agganciato a `data-notification-count`, non all'`aria-label`: quello è una
 *  frase tradotta, e un locator che ci si appende congela la frase. */
const badge = (page: Page) => bell(page).locator("[data-notification-count]");

test.describe("Cronologia notifiche", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-notif" }, null, 2));
    const topic = await createTopic(request, "E2E-Notifiche", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Il task che la notifica deve aprire" },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await wipeRegistry(page.request);
  });

  test("NH-01: la notifica arriva, il contatore sale, il click porta al task", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "UNREAD-01" });
    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    // Si parte da zero: il badge non esiste proprio quando non c'è nulla da
    // guardare (NotificationBadge si nasconde a 0).
    await expect(badge(page)).toHaveCount(0);
    await didascalia(page, "1 · Il tastino accanto a Topics, contatore a zero");
    await beat(page, 1400);

    // La notifica arriva mentre l'app è aperta. Nessun reload: se il contatore
    // sale, è salito per il fronte `notification:new`.
    await postNotification(page.request, {
      kind: "task-review",
      title: "Task pronto per la review",
      body: "Il task che la notifica deve aprire",
      targetKind: "task",
      targetId: taskId,
      dedupeKey: `task-review:${taskId}`,
    });
    await expect(badge(page)).toHaveText("1", { timeout: 10_000 });
    await didascalia(page, "2 · Arriva una notifica: il contatore sale da solo");
    await beat(page, 1600);

    // La cronologia si apre dal tastino accanto a Topics.
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    const row = rows(page).first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-target", `/task/${taskId}`);
    await didascalia(page, "3 · La cronologia, con la riga e dove porta");
    await beat(page, 1600);

    // Il click porta ALLA COSA: la board generale si apre e il drawer è quello
    // del task che ha generato la notifica.
    await row.click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-detail-drawer")).toContainText("Il task che la notifica deve aprire");
    await didascalia(page, "4 · Il click porta esattamente sul task che l'ha generata");
    await beat(page, 2200);
  });

  test("NH-02: guardate = zero, e zero resta dopo un ricaricamento", async ({ page }) => {
    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    await postNotification(page.request, {
      kind: "chat-message",
      title: "Una risposta",
      dedupeKey: `e2e-seen-${Date.now()}`,
    });
    await expect(badge(page)).toHaveText("1", { timeout: 10_000 });

    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    // Guardare la lista È l'atto che azzera il contatore.
    await expect(badge(page)).toHaveCount(0, { timeout: 10_000 });

    // E ci RESTA: il «visto» sta sulla riga, sul server, non nella memoria di
    // questa finestra.
    await page.reload();
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    await expect(badge(page)).toHaveCount(0);
  });

  test("NH-03: raggruppata e vista una volta — il contatore non risale", async ({ page }) => {
    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });

    // Due notifiche dello stesso topic: un raggruppamento, cioè UNA cosa da
    // guardare. Chiavi di dedup diverse (sono due eventi), stesso bersaglio —
    // quindi stesso gruppo.
    const topicId = projectTopicId!;
    await postNotification(page.request, {
      kind: "chat-message", title: "Primo messaggio",
      targetKind: "topic", targetId: topicId, dedupeKey: `e2e-grp-a-${Date.now()}`,
    });
    await postNotification(page.request, {
      kind: "chat-message", title: "Secondo messaggio",
      targetKind: "topic", targetId: topicId, dedupeKey: `e2e-grp-b-${Date.now()}`,
    });
    await expect(badge(page)).toHaveText("2", { timeout: 10_000 });

    // Il conteggio azzerato dal server, non dall'ottimismo del client: si
    // rilegge la rotta.
    const marked = await page.request.post(`${BASE}/api/notifications/seen`, {
      data: { ids: [await firstRowId(page)] },
    });
    expect(marked.ok()).toBe(true);
    const after = (await marked.json()) as { unseen: number };
    // Senza la cascata sul gruppo qui resterebbe 1, e il contatore non
    // tornerebbe mai a zero: è il difetto già pagato sui rollup.
    expect(after.unseen).toBe(0);
    await expect(badge(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("NH-04: niente di vecchio ricompare come nuovo, e due mittenti = una riga", async ({ page }) => {
    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });

    // Chiave UNICA per esecuzione: la finestra di dedup è di 10s e i test di
    // questo file girano a pochi secondi l'uno dall'altro — riusare la chiave di
    // NH-01 farebbe fallire il seed, non la regola.
    const key = `task-review:${taskId}:${Date.now()}`;
    const first = await postNotification(page.request, {
      kind: "task-review", title: "Consegna", targetKind: "task", targetId: taskId, dedupeKey: key,
    });
    expect(first.recorded).toBe(true);
    // Il SECONDO mittente dello stesso evento: la push del server, o la stessa
    // notifica da un'altra finestra. Una riga, non due.
    const second = await postNotification(page.request, {
      kind: "task-review", title: "Consegna", targetKind: "task", targetId: taskId, dedupeKey: key, source: "push",
    });
    expect(second.recorded).toBe(false);
    expect(second.unseen).toBe(1);

    // Le si guarda, poi si "riavvia" (ricarica): il registro dice cosa è GIÀ
    // stato mostrato, quindi non ripresenta niente come nuovo.
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(badge(page)).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    await expect(badge(page)).toHaveCount(0);
    // La riga però c'è ancora: vista non vuol dire sparita.
    await bell(page).click();
    await expect(rows(page).first()).toBeVisible();
  });

  test("NH-05: il contatore non torna indietro quando il fronte arriva TARDI", async ({ page }) => {
    // NH-04 prova la stessa regola, ma solo se la rete è lenta abbastanza da
    // sfasare le cose: su questa macchina non lo è mai, sul runner Linux lo era
    // circa una volta su tre — un rosso mobile che accusava il prodotto solo
    // quando gli girava. Qui lo sfasamento è FATTO, non sperato: il fronte
    // `notification:new` viene trattenuto 2,5s, cioè consegnato ben dopo che la
    // cronologia è stata aperta e il «visto» è già andato a buon fine.
    //
    // Sono due ordini, e il difetto era in tutti e due:
    //  · aprendo, la rilettura e il «visto» partivano INSIEME. Il «visto» ricava
    //    il suo istante dall'elenco in mano, che senza il fronte è vuoto: non
    //    partiva nessuna POST e il contatore restava acceso per sempre.
    //  · il fronte in ritardo porta un `unseen` fotografato PRIMA del «visto»:
    //    applicato al suo arrivo, riaccendeva un contatore già spento.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const testo = typeof m === "string" ? m : "";
        if (testo.includes("notification:new")) {
          setTimeout(() => ws.send(m), 2500);
          return;
        }
        ws.send(m);
      });
    });

    // La sonda che rende l'attesa una CONDIZIONE e non un sonno.
    //
    // Qui non basta sapere che il ritardatore ha fatto partire il fronte: serve
    // sapere che la PAGINA l'ha ricevuto, perche' l'asserzione che segue dice
    // «e nonostante quello il contatore e' rimasto spento». Un `waitForTimeout`
    // di tre secondi e mezzo diceva solo «e' passato abbastanza tempo», che e'
    // un'altra cosa: su una macchina carica scade prima che il fronte arrivi e
    // il test passa senza aver mai provato niente. Contare i fronti alla porta
    // del client e' il modo onesto, ed e' quello che chiede CONVENTIONS.md.
    await page.addInitScript(() => {
      const w = window as unknown as { __frontiNotifica?: number };
      w.__frontiNotifica = 0;
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args: ConstructorParameters<typeof WebSocket>) {
          const ws = new target(...args);
          ws.addEventListener("message", (e: MessageEvent) => {
            if (typeof e.data === "string" && e.data.includes("notification:new")) {
              w.__frontiNotifica = (w.__frontiNotifica ?? 0) + 1;
            }
          });
          return ws;
        },
      });
    });

    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    // La lettura di montaggio è finita: quello che segue è solo il ritardo.
    await expect(badge(page)).toHaveCount(0);

    await postNotification(page.request, {
      kind: "task-review",
      title: "Consegna in ritardo",
      targetKind: "task",
      targetId: taskId,
      dedupeKey: `nh05:${taskId}:${Date.now()}`,
    });

    // Si apre SENZA aspettare il contatore: è il caso vero — chi guarda non sa
    // che c'è un fronte per strada, e apre perché gli va.
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(badge(page)).toHaveCount(0, { timeout: 10_000 });

    // Il fronte arriva ADESSO, in ritardo: la sonda lo conta quando entra dal
    // socket, quindi da qui in poi «e' arrivato» e' un fatto, non un'ipotesi.
    // Non deve riaccendere niente, e il server deve dire la stessa cosa dello
    // schermo.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __frontiNotifica?: number }).__frontiNotifica ?? 0), {
        timeout: 15_000,
        message: "il fronte notification:new trattenuto non e' mai arrivato alla pagina",
      })
      .toBeGreaterThanOrEqual(1);
    await expect(badge(page)).toHaveCount(0);
    const dopo = await page.request.get(`${BASE}/api/notifications`);
    expect(((await dopo.json()) as { unseen: number }).unseen).toBe(0);
  });

  test("NH-06: oltre la prima pagina — il registro non finisce alla cinquantesima", async ({ page }) => {
    // The registry holds 500 rows and a page serves 50. The panel drew 50 and
    // stopped there: no "load more", no line saying the list was cut. The
    // other 450 existed only for whoever knew to call the route with `before`.
    for (let i = 0; i < 60; i++) {
      await postNotification(page.request, {
        kind: "chat-message",
        title: `Riga di registro ${i}`,
        dedupeKey: `nh06-${Date.now()}-${i}`,
      });
    }

    await page.goto("/");
    await expect(bell(page)).toBeVisible({ timeout: 15_000 });
    await bell(page).click();
    await expect(panel(page)).toBeVisible();

    // The first page is a PAGE, and the panel says so instead of letting
    // fifty rows look like everything there is.
    await expect(rows(page)).toHaveCount(50, { timeout: 15_000 });
    // The control is there for the keyboard and for a list too short to
    // scroll, and it says the list is cut.
    await expect(page.getByTestId("notification-history-more")).toBeVisible();

    // The gesture is the one a reader makes: the bottom of the list. Clicking
    // the button would be a race against itself - the rows land ABOVE it, so
    // the target moves while the click is being aimed.
    await page.getByTestId("notification-history-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => rows(page).count(), { timeout: 15_000, message: "la seconda pagina non è mai arrivata" })
      .toBeGreaterThan(50);
    // And the first fifty are still there: it MERGES, it does not replace.
    await expect(rows(page).first()).toBeVisible();
  });
});

/** L'id della prima riga in elenco, letto dalla rotta (il DOM non lo espone). */
async function firstRowId(page: Page): Promise<string> {
  const res = await page.request.get(`${BASE}/api/notifications?limit=1`);
  const data = (await res.json()) as { rows: Array<{ id: string }> };
  return data.rows[0]!.id;
}
