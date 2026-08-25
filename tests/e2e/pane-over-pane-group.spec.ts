/**
 * IL GESTO DEL BROWSER: una pane lasciata cadere SOPRA un'altra pane le
 * raggruppa in una finestra sola, a tab.
 *
 * Il modello del gruppo c'era già, e la zona 'center' del corpo di una pane era
 * già una fusione-a-tab. Quello che NON funzionava è proprio il caso che si
 * nota: **sopra un browser**. Una pane browser framabile rende un `<iframe>`, e
 * durante un drag HTML5 gli eventi finiscono nel documento DELL'IFRAME: il
 * `dragover` della pane sotto non parte mai, l'anteprima di fusione non si
 * dipinge e il rilascio cade nel vuoto. Misurato prima della cura: il centro non
 * dipingeva niente e il drop lasciava le due celle esattamente com'erano.
 *
 * La cura sta in `lib/paneDragFlag.ts` + la regola `[data-pane-drag] iframe` di
 * `index.css`: mentre una tab è in volo gli iframe diventano trasparenti ai
 * puntatori, e l'hit test torna al div del gruppo — lo stesso percorso che
 * rendeva già vivo il drop sopra un terminale.
 *
 * Le tre cose che questo file sorveglia:
 *   1. browser SOPRA browser → una cella sola, due tab (il caso di Attilio);
 *   2. TIPI DIVERSI → si raggruppano lo stesso (la decisione, scritta);
 *   3. il ritorno: una tab tolta dal gruppo torna una pane a sé.
 *
 * @covers LAYOUT-01
 */
import { test, expect } from "./fixtures/browser-v2.fixture";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Una pagina del server di test: same-origin, sempre raggiungibile, e nessuna
 *  dipendenza di rete dentro una suite che deve restare ermetica. */
const URL_PANE = `${E2E_BASE}/changelog.json`;

let t1 = "";
let t2 = "";

/** Drag col MOUSE vero: in Chromium l'HTML5 DnD parte da qui, non da DragEvent. */
async function trascina(page: Page, sorgente: string, x: number, y: number): Promise<void> {
  const src = page.locator(`[role="main"] [data-pane-id="${sorgente}"]`).first();
  const s = await src.boundingBox();
  if (!s) throw new Error("sorgente senza bounding box");
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  // Primo micro-spostamento: è quello che fa nascere il drag.
  await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 });
  await page.mouse.move(x, y, { steps: 14 });
  await page.mouse.move(x, y + 1, { steps: 2 });
  await page.mouse.up();
}

/** Le tab di ogni cella, in ordine — l'osservabile di questo file. */
function celle(page: Page): Promise<string[][]> {
  return page.locator('[role="main"] [data-split-card]').evaluateAll((cards) =>
    cards.map((c) =>
      Array.from(c.querySelectorAll('[data-testid="panel-tab-bar"] [data-pane-id]')).map(
        (t) => t.getAttribute("data-pane-id") || "",
      ),
    ),
  );
}

/** Il centro del CORPO della cella che tiene `paneId` (non la barra delle tab). */
async function centroDi(page: Page, paneId: string): Promise<[number, number]> {
  const c = await celle(page);
  const idx = c.findIndex((cc) => cc.includes(paneId));
  if (idx < 0) throw new Error(`nessuna cella tiene ${paneId}, fra: ${JSON.stringify(c)}`);
  const b = await page.locator('[role="main"] [data-split-card]').nth(idx).boundingBox();
  if (!b) throw new Error("cella senza bounding box");
  // 55% dell'altezza: dentro la scatola centrale di `detectDropZone` (fusione a
  // tab) e ben sotto la barra delle tab, che ha un drop tutto suo.
  return [b.x + b.width / 2, b.y + b.height * 0.55];
}

/** Una pausa che esiste SOLO nella clip di consegna: la suite non rallenta. */
const battuta = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

/** Didascalia sulla clip — solo sotto E2E_EVIDENCE (l'anteprima di un task si
 *  legge a 268px: un titolo grande è l'unica cosa che sopravvive). */
async function didascalia(page: Page, testo: string) {
  if (process.env.E2E_EVIDENCE !== "1") return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "background:rgba(10,10,12,.92);color:#fff;font:700 40px/1.25 system-ui,sans-serif;" +
        "padding:14px 20px;letter-spacing:-.01em;border-top:3px solid #8b5cf6;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, testo);
}

test.describe("Una pane sopra un'altra pane fa un gruppo", () => {
  // Più larga del default della suite: questo file È la clip di consegna, e
  // l'anteprima di un task viene resa a 268px — oltre un rapporto
  // altezza/larghezza di 0.537 la card TAGLIA invece di rimpicciolire.
  // 1440×760 → 0.528. Nessuna asserzione dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    t1 = (await createTopic(request, `E2E-POP1-${Date.now()}`)).id;
    t2 = (await createTopic(request, `E2E-POP2-${Date.now()}`)).id;
  });

  test.afterAll(async ({ request }) => {
    // Chi sporca pulisce: i contesti browser vivono nel processo del server e
    // `resetPaneStore` non li tocca.
    await closeAllBrowserContexts(request);
    for (const id of [t1, t2]) if (id) await deleteTopic(request, id).catch(() => {});
  });

  test.beforeEach(async ({ page, request, browserProcessPageV2 }) => {
    await resetPaneStore(request, [t1, t2]);
    // Pane browser SENZA un Chromium vero: contesti, bridge WS e pannello sono
    // finti, e `framable` acceso le fa rendere come <iframe> — che è esattamente
    // la superficie che mangiava il gesto.
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 5 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: URL_PANE, title: "Pagina", hasScreenshot: true,
    });
    await page.route(/\/api\/browsers\/framable/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }),
    );
  });

  /** Apre una pane browser per ognuno dei topic passati e ne torna i pane id.
   *  Ogni contesto nasce nella SUA cella: due finestre affiancate, che è la
   *  situazione da cui parte il gesto. */
  async function apriBrowser(page: Page, topicIds: string[]): Promise<string[]> {
    for (const id of topicIds) {
      await page.evaluate(({ tid, url }) => {
        window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
      }, { tid: id, url: URL_PANE });
      await expect(page.locator(`[role="main"] [data-pane-id="browser:${id}"]`).first())
        .toBeVisible({ timeout: 15000 });
    }
    return topicIds.map((id) => `browser:${id}`);
  }

  test("POP-01: un browser lasciato SOPRA un altro browser fa un gruppo di due tab", async ({ page }) => {
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });
    const [b1, b2] = await apriBrowser(page, [t1, t2]);
    // Se non ci sono i due iframe, questo test non sta provando il caso che deve
    // provare: è l'iframe la superficie che si mangiava il `dragover`.
    await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(2, { timeout: 15000 });
    expect((await celle(page)).find((c) => c.includes(b1))).toEqual([b1]);

    await didascalia(page, "Un browser sopra l'altro browser");
    await battuta(page, 1400);
    await trascina(page, b1, ...await centroDi(page, b2));

    // I due sono ora UNA finestra con due tab, nell'ordine «chi c'era» + «chi è
    // arrivato» (una fusione dal corpo accoda; l'indice preciso lo possiede il
    // drop sulla BARRA).
    await expect
      .poll(async () => (await celle(page)).find((c) => c.includes(b2)) ?? [], { timeout: 8000 })
      .toEqual([b2, b1]);
    await didascalia(page, "Due tab, una finestra: è un gruppo");
    await battuta(page, 1800);
  });

  test("POP-02: TIPI DIVERSI si raggruppano lo stesso — un browser sopra una chat", async ({ page }) => {
    // La decisione, scritta una volta: il gruppo è una FINESTRA, non un club di
    // tipi uguali. Il modello regge già `paneIds` eterogenei, e rifiutare il
    // drop farebbe fallire il gesto proprio dove l'utente ha mirato — che è il
    // difetto da cui nasce questa card, non la sua cura.
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });
    const [b1] = await apriBrowser(page, [t1]);

    const cellaChat = (await celle(page)).find((c) => c.includes(t2));
    expect(cellaChat, "la chat deve avere una cella sua").toBeTruthy();
    await didascalia(page, "Un browser sopra una CHAT: tipi diversi");
    await battuta(page, 1400);
    await trascina(page, b1, ...await centroDi(page, t2));

    await expect
      .poll(async () => (await celle(page)).find((c) => c.includes(t2)) ?? [], { timeout: 8000 })
      .toEqual([...cellaChat!, b1]);
    await didascalia(page, "Si raggruppano lo stesso");
    await battuta(page, 1600);
  });

  test("POP-03: il ritorno — una tab tolta dal gruppo torna una pane a sé", async ({ page }) => {
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${t1}"]`).first()).toBeVisible({ timeout: 15000 });
    const [b1, b2] = await apriBrowser(page, [t1, t2]);
    await trascina(page, b1, ...await centroDi(page, b2));
    await expect
      .poll(async () => (await celle(page)).find((c) => c.includes(b2)) ?? [], { timeout: 8000 })
      .toEqual([b2, b1]);

    // Il gesto inverso, dal menu della tab: la tab esce e si ripiglia una cella.
    await didascalia(page, "E adesso una tab ESCE dal gruppo");
    await battuta(page, 1400);
    await page.locator(`[role="main"] [data-pane-id="${b1}"]`).first().click({ button: "right" });
    await page.getByText("Dividi a destra", { exact: true }).click();

    await expect
      .poll(async () => {
        const c = await celle(page);
        return [c.find((cc) => cc.includes(b1)) ?? [], c.find((cc) => cc.includes(b2)) ?? []];
      }, { timeout: 8000 })
      .toEqual([[b1], [b2]]);
    await didascalia(page, "Due pane a sé, come prima");
    await battuta(page, 1600);
  });
});
