/**
 * Trascinare una cosa DENTRO una finestra — da ogni sorgente.
 *
 * Le sorgenti di trascinamento sono tre e devono valere uguale:
 *   1. la TAB nella barra dei pannelli   (`PANE_TAB` + `PANEL_ID`)
 *   2. la RIGA della sidebar             (`PANEL_ID`)
 *   3. la TESSERA dei FISSATI            (`PINNED_TILE` + `PANEL_ID`)
 *
 * E le destinazioni sono due: la CELLA della griglia (la «finestra» in cui il
 * lavoro è diviso) e la CARD di un gruppo nella sidebar.
 *
 * IL DIFETTO CHE QUESTO FILE SORVEGLIA: dalla sidebar (riga o tessera) il
 * `dragover` dipingeva l'anteprima di fusione sulla cella sotto il cursore —
 * «questa cosa entra QUI» — e poi il drop buttava via riga e colonna e apriva
 * la chat nel serbatoio principale. Con la griglia non divisa non si vedeva;
 * appena divisa, trascinare dentro una finestra non ci metteva niente, mentre
 * lo stesso gesto partendo da una tab della barra funzionava.
 *
 * I drag qui sono col MOUSE VERO (down/move/up), non `DragEvent` sintetici: è
 * l'unico modo per accorgersi se un antenato mangia il gesto, se la sorgente
 * non è `draggable`, o se il drop cade nel vuoto.
 *
 * @covers LAYOUT-01
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { splitViaContextMenu } from "./helpers/layout";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/** Drag col MOUSE vero: in Chromium l'HTML5 DnD parte da qui, non da DragEvent. */
async function dragOnto(page: Page, source: Locator, x: number, y: number): Promise<void> {
  const s = await source.boundingBox();
  if (!s) throw new Error("sorgente senza bounding box");
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  // Primo micro-spostamento: è quello che fa nascere il drag.
  await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 });
  await page.mouse.move(x, y, { steps: 14 });
  await page.mouse.move(x, y + 1, { steps: 2 });
  await page.mouse.up();
}

/** Il centro di `loc`, dove lasciare cadere. */
async function centro(loc: Locator): Promise<[number, number]> {
  const b = await loc.boundingBox();
  if (!b) throw new Error("destinazione senza bounding box");
  return [b.x + b.width / 2, b.y + b.height * 0.55];
}

/** Le tab della cella `cellSel`, in ordine. */
function tabsIn(page: Page, cellSel: string): Promise<string[]> {
  return page
    .locator(`${cellSel} [data-testid="panel-tab-bar"] [data-pane-id]`)
    .evaluateAll(els => els.map(e => e.getAttribute("data-pane-id") || ""));
}

/** Una pausa che esiste SOLO nella clip di consegna: la suite non rallenta. */
const battuta = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

/**
 * Didascalia sulla clip — solo sotto E2E_EVIDENCE, zero effetto sulla suite.
 * L'anteprima di un task viene resa a 268px: da un video di una UI a 1440px non
 * si legge una riga, e un titolo grande è l'unica cosa che sopravvive alla
 * riduzione. `pointer-events:none` così non intercetta un gesto.
 */
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

test.describe("Trascinare dentro una finestra", () => {
  // Più largo del default della suite (1280×800) per una ragione sola: questo
  // file È la clip di consegna, e l'anteprima di un task viene resa a 268px —
  // oltre un rapporto altezza/larghezza di 0.70 la card TAGLIA invece di
  // rimpicciolire. 1440×760 → 0.528, ci sta intero. Nessuna asserzione qui
  // dipende dalla larghezza: le celle si misurano a runtime.
  test.use({ viewport: { width: 1440, height: 760 } });

  let idA = "";
  let idB = "";
  let idC = "";
  let idPin = "";

  test.beforeAll(async ({ request }) => {
    idA = (await createTopic(request, "GDROP-A-" + Date.now())).id;
    idB = (await createTopic(request, "GDROP-B-" + Date.now())).id;
    idC = (await createTopic(request, "GDROP-C-" + Date.now())).id;
    idPin = (await createTopic(request, "GDROP-PIN-" + Date.now())).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idA, idB, idC, idPin]) if (id) await deleteTopic(request, id).catch(() => {});
  });

  /**
   * `aperte` = le tab a livello app; GDROP-PIN è sempre FISSATO (che è cosa
   * diversa dall'essere aperto: una tessera fissata con la tab chiusa è lo
   * stato normale di un fissato, ed è il caso che fa nascere la pane al drop).
   */
  async function scena(page: Page, aperte: string[]) {
    await resetPaneStore(page.request, aperte);
    await page.request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: { pinnedItems: [idPin], viewMode: "timeline", showArchived: false },
    }).catch(() => {});
    await page.addInitScript((pinned: string) => {
      localStorage.setItem(
        "topics-sidebar-state",
        JSON.stringify({ pinnedItems: [pinned], viewMode: "timeline", showArchived: false }),
      );
    }, idPin);
    await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: aperte } }).catch(() => {});
    await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: aperte, pinned: [] } }).catch(() => {});
    await page.request.put(`${BASE}/api/ui-state/grid-layout`, {
      data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
    }).catch(() => {});
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${aperte[0]}"]`).first()).toBeVisible({ timeout: 10000 });
  }

  /** Divide la griglia in due: A da sola in una cella, il resto nel serbatoio. */
  async function dividi(page: Page) {
    await splitViaContextMenu(page, "Dividi a destra");
    await expect(page.getByTestId("panel-tab-bar")).toHaveCount(2, { timeout: 5000 });
  }

  /**
   * Il selettore della cella che TIENE `id`. Identificare le celle per numero
   * di tab non funziona: con due sole pane aperte, dopo lo split le celle hanno
   * una tab a testa e «quella con una tab» è ambigua — un test che pesca la
   * cella sbagliata passa anche col difetto in piedi.
   */
  async function cellaCon(page: Page, id: string): Promise<string> {
    const chiavi = await page
      .locator("[data-panel-cell]")
      .evaluateAll(els => els.map(e => e.getAttribute("data-panel-cell") || ""));
    for (const k of chiavi) {
      const sel = `[data-panel-cell="${k}"]`;
      if ((await tabsIn(page, sel)).includes(id)) return sel;
    }
    throw new Error(`nessuna cella tiene ${id}, fra: ${chiavi.join(", ")}`);
  }

  const rigaSidebar = (page: Page, re: RegExp) =>
    page.locator('[aria-label="Topics sidebar"]').getByRole("treeitem", { name: re }).first();

  // ── Destinazione: la CELLA della griglia ───────────────────────────────────

  test("GDROP-01: la TAB della barra entra nella cella su cui cade (il riferimento)", async ({ page }) => {
    await scena(page, [idA, idB, idC]);
    await dividi(page);
    const cella = await cellaCon(page, idA);
    const prima = await tabsIn(page, cella);
    await dragOnto(page, page.locator(`[role="main"] [data-pane-id="${idC}"]`).first(), ...await centro(page.locator(cella)));
    await expect.poll(() => tabsIn(page, cella), { timeout: 5000 }).toEqual([...prima, idC]);
  });

  test("GDROP-02: la RIGA della sidebar entra nella cella su cui cade", async ({ page }) => {
    await scena(page, [idA, idB, idC]);
    await dividi(page);
    const cella = await cellaCon(page, idA);
    const prima = await tabsIn(page, cella);
    await didascalia(page, "Riga della sidebar → la finestra a destra");
    await battuta(page, 1400);
    await dragOnto(page, rigaSidebar(page, /GDROP-C-/), ...await centro(page.locator(cella)));
    await expect.poll(() => tabsIn(page, cella), { timeout: 5000 }).toEqual([...prima, idC]);
    await didascalia(page, "È entrata LÌ (prima finiva nel serbatoio)");
    await battuta(page, 1800);
  });

  test("GDROP-03: la TESSERA fissata entra nella cella su cui cade — anche con la tab CHIUSA", async ({ page }) => {
    // GDROP-PIN non è fra le aperte: la pane non esiste ancora, quindi il drop
    // deve prima aprirla e POI portarla nella cella. Metterla nella cella prima
    // che la pane esista non basterebbe: `pruneSoloCells` la scarterebbe nello
    // stesso render.
    await scena(page, [idA, idB, idC]);
    await dividi(page);
    const cella = await cellaCon(page, idA);
    const prima = await tabsIn(page, cella);
    const tessera = page.locator(`[data-pinned-tile="${idPin}"]`).first();
    await expect(tessera).toBeVisible({ timeout: 5000 });
    await didascalia(page, "Tessera FISSATA (tab chiusa) → la finestra a destra");
    await battuta(page, 1400);
    await dragOnto(page, tessera, ...await centro(page.locator(cella)));
    await expect.poll(() => tabsIn(page, cella), { timeout: 8000 }).toEqual([...prima, idPin]);
    await didascalia(page, "Si apre DENTRO quella finestra");
    await battuta(page, 1800);
  });

  test("GDROP-04: e sul SERBATOIO principale si atterra lì, non nella cella divisa", async ({ page }) => {
    // Il rovescio della medaglia: la cella non è l'unica destinazione, e un
    // drop sul serbatoio non deve finire nello split solo perché ora la cella
    // è un bersaglio vero.
    await scena(page, [idA, idB, idC]);
    await dividi(page);
    const divisa = await cellaCon(page, idA);
    const pool = await cellaCon(page, idB);
    const primaPool = await tabsIn(page, pool);
    const primaDivisa = await tabsIn(page, divisa);
    const tessera = page.locator(`[data-pinned-tile="${idPin}"]`).first();
    await expect(tessera).toBeVisible({ timeout: 5000 });
    await dragOnto(page, tessera, ...await centro(page.locator(pool)));
    await expect.poll(() => tabsIn(page, pool), { timeout: 8000 }).toEqual([...primaPool, idPin]);
    expect(await tabsIn(page, divisa), "la cella divisa resta com'era").toEqual(primaDivisa);
  });

  // ── Destinazione: la CARD di un GRUPPO nella sidebar ───────────────────────

  /** Crea "Gruppo 2" portandoci dentro la tab `paneId` dal suo menu. */
  async function nuovoGruppoCon(page: Page, paneId: string) {
    await page.locator(`[data-pane-id="${paneId}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
    await expect(page.getByTestId("space-card")).toHaveCount(1, { timeout: 5000 });
  }

  const cardAltroGruppo = (page: Page) => page.getByTestId("space-card").first();

  /**
   * La pane `id` è passata all'altro gruppo? Si misura sulla GRIGLIA, non
   * sull'elenco della card: una tab FISSATA sta sopra i gruppi e per contratto
   * non compare dentro nessuna card (vedi SPACE-09), quindi l'elenco non è un
   * osservabile comune alle tre sorgenti. La griglia sì.
   */
  async function passataAllAltroGruppo(page: Page, id: string) {
    await expect(
      page.locator(`[data-pane-id="${id}"]`),
      "la pane lascia l'insieme visibile di Principale",
    ).toHaveCount(0, { timeout: 5000 });
    await cardAltroGruppo(page).getByTestId("space-row").first().click();
    await expect(
      page.locator(`[data-pane-id="${id}"]`).first(),
      "e si vede nel gruppo di destinazione",
    ).toBeVisible({ timeout: 5000 });
  }

  test("GDROP-05: dalla BARRA delle tab dentro la card di un gruppo", async ({ page }) => {
    await scena(page, [idA, idB, idC]);
    await nuovoGruppoCon(page, idA);
    await dragOnto(page, page.locator(`[data-pane-id="${idB}"]`).first(), ...await centro(cardAltroGruppo(page)));
    await passataAllAltroGruppo(page, idB);
  });

  test("GDROP-06: dalla RIGA della sidebar dentro la card di un gruppo", async ({ page }) => {
    await scena(page, [idA, idB, idC]);
    await nuovoGruppoCon(page, idA);
    const riga = page.getByTestId("sidebar-groups").getByRole("treeitem", { name: /GDROP-B-/ }).first();
    await expect(riga).toBeVisible({ timeout: 5000 });
    await dragOnto(page, riga, ...await centro(cardAltroGruppo(page)));
    await passataAllAltroGruppo(page, idB);
  });

  test("GDROP-07: dalla TESSERA fissata dentro la card di un gruppo", async ({ page }) => {
    await scena(page, [idA, idB, idPin]);
    await nuovoGruppoCon(page, idA);
    const tessera = page.locator(`[data-pinned-tile="${idPin}"]`).first();
    await expect(tessera).toBeVisible({ timeout: 5000 });
    await dragOnto(page, tessera, ...await centro(cardAltroGruppo(page)));
    await passataAllAltroGruppo(page, idPin);
  });
});
