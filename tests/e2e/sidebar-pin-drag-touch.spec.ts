/**
 * @covers PINDRAG-01
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * FISSARE E SFISSARE COL DITO.
 *
 * chi usa la app, dal telefono: «non si riesce a spinnare una tab col drag and drop»,
 * e il drag&drop per togliere il pin non funziona. Non era un difetto solo: su
 * iOS `dragstart`/`dragover`/`drop` non vengono MAI emessi da un tocco, quindi
 * i due gesti che attraversano il confine della griglia dei Fissati erano
 * inerti per costruzione. Dentro la griglia il riordino col dito c'era gia'
 * (`useTouchDrag`): e' il confine che non si passava.
 *
 * Cosa si misura, e perche' non basta guardare la griglia:
 *
 *  1. SFISSARE. Una tessera trascinata col dito FUORI dalla griglia, sulla
 *     lista, perde il pin. Prima il rilascio fuori bersaglio era un
 *     annullamento e basta.
 *  2. FISSARE. Una riga della lista trascinata col dito DENTRO la griglia
 *     prende il pin. Prima la riga col dito non si trascinava affatto: aveva
 *     solo il long-press del menu.
 *
 * Il gesto si costruisce a mano: Playwright non ha una primitiva di
 * trascinamento col dito, e `useTouchDrag` legge `e.touches[0].clientX`, che
 * vuole veri oggetti `Touch` costruiti NELLA pagina. Il `touchstart` si spara
 * sull'ELEMENTO (lo ascolta React, che delega alla radice); `touchmove` e
 * `touchend` su `document`, che e' dove il gesto li aggancia in cattura.
 */

hermetic(test);

// La clip e' la prova: un gesto e' due o piu' stati, e uno screenshot non
// distingue «la tessera se n'e' andata» da «non c'e' mai stata».
test.use({ video: "on" });

const SIDEBAR = '[aria-label="Topics sidebar"]';
const creati: string[] = [];

const sezione = (page: Page): Locator => page.getByTestId("sidebar-pinned-section");
const lista = (page: Page): Locator => page.getByTestId("sidebar-timeline");

/** La tessera con questo nome. Ristretta ai `pinned-tile`: la fascia aperta di
 *  un progetto contiene righe che portano lo stesso nome accessibile. */
const tessera = (page: Page, nome: string): Locator =>
  sezione(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name: nome }));

/** La riga in lista con questo nome. */
const riga = (page: Page, nome: string): Locator =>
  lista(page).getByRole("treeitem", { name: nome });

/** Fissa scrivendo lo stato sidebar: il percorso dal menu e' coperto altrove, e
 *  qui interessa il GESTO, non come si e' arrivati ad avere una tessera. */
async function fissa(page: Page, ids: string[]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      pinnedLayout: ids.length ? [{ keys: ids, widths: ids.map(() => 1 / ids.length) }] : [],
    },
  });
}

/** Il cassetto mobile nasce CHIUSO e la chiave sopravvive al reload: senza
 *  dichiararlo, il test eredita l'ultimo gesto di chi e' passato di qui. */
async function apriApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("topics-mobile-drawer-collapsed", "0");
  });
  await page.goto("/");
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 15_000 });
}

/**
 * IL GESTO: premi, aspetta il sollevamento, trascina, stacca.
 *
 * I 500ms di `LONG_PRESS_MS` non sono negoziabili e non si possono accorciare
 * dal test: prima di quelli il dito e' ancora uno scorrimento. Il movimento e' a
 * passi, perche' il primo pixel oltre la tolleranza e' cio' che trasforma la
 * pressione in trascinamento, e un salto unico non lo racconta.
 */
async function trascinaColDito(
  page: Page,
  opts: { da: string; x0: number; y0: number; x1: number; y1: number },
): Promise<void> {
  await page.evaluate(async ({ da, x0, y0, x1, y1 }) => {
    const nodo = document.querySelector(da);
    if (!nodo) throw new Error(`nessun elemento da cui partire: ${da}`);

    // IL DITO, DISEGNATO: un tocco sintetico non lascia traccia, e nella clip
    // non si distinguerebbe il gesto da un'animazione partita da sola. E'
    // decorazione DEL TEST (`pointer-events: none`), l'app non lo vede mai.
    const dito = document.createElement("div");
    dito.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;
      margin:-22px 0 0 -22px;border-radius:9999px;background:rgba(255,255,255,.35);
      border:2px solid rgba(255,255,255,.9);box-shadow:0 0 12px rgba(0,0,0,.5)`;
    document.body.appendChild(dito);
    const muovi = (x: number, y: number) => { dito.style.left = `${x}px`; dito.style.top = `${y}px`; };
    muovi(x0, y0);

    const tocco = (x: number, y: number) => new Touch({ identifier: 7, target: nodo, clientX: x, clientY: y });
    const spara = (su: EventTarget, tipo: string, t: Touch, attivi: Touch[]) =>
      su.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true, touches: attivi, targetTouches: attivi, changedTouches: [t],
      }));
    const attesa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const primo = tocco(x0, y0);
    spara(nodo, "touchstart", primo, [primo]);
    // Il sollevamento, piu' un margine: sotto i 500ms non e' ancora un gesto.
    await attesa(700);

    const passi = 8;
    for (let i = 1; i <= passi; i++) {
      const x = x0 + ((x1 - x0) * i) / passi;
      const y = y0 + ((y1 - y0) * i) / passi;
      const t = tocco(x, y);
      spara(document, "touchmove", t, [t]);
      muovi(x, y);
      await attesa(30);
    }
    spara(document, "touchend", tocco(x1, y1), []);
    setTimeout(() => dito.remove(), 400);
  }, opts);
}

/** Il centro di un elemento, in coordinate di finestra. */
async function centro(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  expect(b, "l'elemento deve avere un rettangolo").not.toBeNull();
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
}

test.describe("Fissati: il confine della griglia si attraversa col dito", () => {
  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
    creati.length = 0;
  });

  test("SFISSA: la tessera trascinata sulla lista perde il pin", async ({ page, request }) => {
    const nome = `Sfissa col dito ${Date.now()}`;
    const topic = await createTopic(request, nome);
    creati.push(topic.id);
    await fissa(page, [topic.id]);
    await apriApp(page);

    const tile = tessera(page, nome);
    await expect(tile, "si parte da una tessera fissata").toBeVisible();
    const partenza = await centro(tile);

    // Sotto la griglia c'e' la lista: e' li' che col mouse si lascia cadere una
    // tessera per rimetterla in riga.
    const box = await sezione(page).boundingBox();
    const arrivo = { x: partenza.x, y: box!.y + box!.height + 120 };

    await trascinaColDito(page, {
      da: '[data-testid="sidebar-pinned-section"] [data-testid="pinned-tile"]',
      x0: partenza.x, y0: partenza.y, x1: arrivo.x, y1: arrivo.y,
    });

    await expect(tile, "la tessera non deve piu' esistere fra i fissati").toHaveCount(0);
    await expect(riga(page, nome), "e la chat deve essere tornata una riga").toBeVisible();
  });

  test("FISSA: la riga trascinata dentro la griglia prende il pin", async ({ page, request }) => {
    const ancora = await createTopic(request, `Ancora ${Date.now()}`);
    const nome = `Fissa col dito ${Date.now()}`;
    const topic = await createTopic(request, nome);
    creati.push(ancora.id, topic.id);
    // Una tessera c'e' gia': il bersaglio del dito e' la RIGA della griglia, e
    // con zero fissati si misurerebbe lo stato vuoto, che e' un altro codice.
    await fissa(page, [ancora.id]);
    await apriApp(page);

    const target = riga(page, nome);
    await expect(target, "si parte da una riga in lista").toBeVisible();
    const partenza = await centro(target);
    const arrivo = await centro(sezione(page).getByTestId("pinned-tile").first());

    await trascinaColDito(page, {
      da: `[data-testid="sidebar-timeline"] [role="treeitem"][aria-label="${nome}"]`,
      x0: partenza.x, y0: partenza.y, x1: arrivo.x, y1: arrivo.y,
    });

    await expect(tessera(page, nome), "la chat deve avere una sua tessera").toBeVisible();
  });
});
