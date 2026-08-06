import { test, expect, type Page, type Locator } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * Le TESSERE dei Fissati.
 *
 * Quello che si difende qui è ciò che si vede: le tessere stanno affiancate e
 * non impilate, nessuna intestazione le annuncia in nessun modo di vista, il
 * click apre una fascia SOTTO la riga giusta (non in fondo alla sezione), il
 * drag cambia riga e la disposizione sopravvive a un ricarico.
 *
 * La geometria si misura con `boundingBox()` invece di fidarsi delle classi:
 * «affiancate» è un fatto di pixel, e una classe Tailwind che smette di essere
 * emessa non lo cambierebbe nel test ma lo cambierebbe sullo schermo.
 */

hermetic(test);

const created: string[] = [];

/** Fissa una lista di id scrivendo direttamente lo stato sidebar: il percorso
 *  dal menu contestuale è già coperto da `sidebar.spec.ts` (PIN-1/PIN-2), e
 *  qui interessa la GRIGLIA, non come ci si è arrivati. */
async function setPins(page: Page, ids: string[]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      pinnedLayout: [],
    },
  });
}

async function gotoSidebar(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

const section = (page: Page): Locator => page.getByTestId("sidebar-pinned-section");
const tiles = (page: Page): Locator => section(page).getByTestId("pinned-tile");

/** La TESSERA con questo nome accessibile. Ristretta ai `pinned-tile` di
 *  proposito: una fascia aperta contiene le RIGHE delle tab del progetto, che
 *  sono anch'esse `treeitem` con quel nome — cercare per solo ruolo pescherebbe
 *  la riga dentro la fascia invece del quadrato. */
function tileNamed(page: Page, name: string): Locator {
  return section(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name }));
}

/** Il rettangolo di una tessera, per nome accessibile. */
async function boxOf(page: Page, name: string) {
  const box = await tileNamed(page, name).boundingBox();
  expect(box, `la tessera "${name}" deve avere un rettangolo`).not.toBeNull();
  return box!;
}

test.describe("Sidebar — tessere fissate", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-1: le tessere stanno affiancate, e nessuna intestazione le annuncia", async ({ page, request }) => {
    const names = ["E2E-Tile-A", "E2E-Tile-B", "E2E-Tile-C"].map(n => `${n}-${Date.now()}`);
    const ids: string[] = [];
    for (const n of names) {
      const t = await createTopic(request, n);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids);
    await gotoSidebar(page);

    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    // Affiancate: stesso `top`, `left` crescenti. Se tornassero righe piene,
    // i `top` sarebbero diversi e i `left` uguali — cioè l'esatto contrario.
    const boxes = await Promise.all(names.map(n => boxOf(page, n)));
    expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
    expect(boxes[1].y).toBeCloseTo(boxes[2].y, 0);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);

    // Tre tessere costano meno di tre righe: l'altezza del blocco è quella di
    // UNA fila, non della loro somma.
    const sectionBox = (await section(page).boundingBox())!;
    expect(sectionBox.height).toBeLessThan(boxes[0].height * 2);

    // Nessuna etichetta, in NESSUNO dei modi di vista. Il modo si imposta dal
    // lato server invece di cercare il bottone che lo cicla: qui si verifica
    // l'assenza dell'intestazione, e un click che non trova il suo bersaglio
    // renderebbe questo controllo un test che non può fallire.
    for (const viewMode of ["timeline", "grouped", "state"] as const) {
      await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
        data: { viewMode, showArchived: false, expandedNodes: [], pinnedItems: ids, pinnedLayout: [] },
      });
      await gotoSidebar(page);
      await expect(tiles(page), `modo ${viewMode}`).toHaveCount(3, { timeout: 15000 });
      await expect(
        page.getByText(/^\s*(Fissati|Pinned)\s*$/),
        `nessuna intestazione nel modo ${viewMode}`,
      ).toHaveCount(0);
    }
  });

  test("TILE-2: il click apre una fascia SOTTO la riga della tessera, non in fondo", async ({ page, request }) => {
    // Due righe: il progetto sta sulla PRIMA, e la fascia deve infilarsi fra le
    // due — se comparisse in coda alla sezione questo test lo vede.
    //
    // La chat del progetto è fissata anch'essa, e non per comodità: una chat
    // senza tab aperta e senza notifiche non entra fra i figli del progetto
    // (`buildSidebarItems` la salta), e senza figli non c'è niente da espandere.
    // Il pin è l'escape documentato che la tiene in lista — e la stessa chat
    // resta anche una tessera sua, che è la semantica «preferiti del Finder»
    // già scelta per i figli fissati.
    const projectPath = "/tmp/e2e-tile-project";
    const chatName = `E2E-TileProjChat-${Date.now()}`;
    const chat = await createTopic(request, chatName, { projectPath });
    created.push(chat.id);

    const projectKey = `project:${projectPath}`;
    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [projectKey, chat.id],
        pinnedLayout: [
          { keys: [projectKey], widths: [1] },
          { keys: [chat.id], widths: [1] },
        ],
      },
    });
    await gotoSidebar(page);

    const projectTile = tileNamed(page, "e2e-tile-project");
    await expect(projectTile).toBeVisible({ timeout: 15000 });

    const rowTop = (await projectTile.boundingBox())!;
    const loneBefore = await boxOf(page, chatName);
    expect(rowTop.y).toBeLessThan(loneBefore.y); // due righe, il progetto sopra

    await projectTile.click();

    const band = section(page).getByTestId("pinned-expansion");
    await expect(band).toHaveCount(1, { timeout: 10000 });
    const bandBox = (await band.boundingBox())!;
    const loneAfter = await boxOf(page, chatName);

    // La fascia sta FRA la riga del progetto e la riga sotto.
    expect(bandBox.y).toBeGreaterThan(rowTop.y);
    expect(bandBox.y).toBeLessThan(loneAfter.y);
    // E porta la chat del progetto.
    await expect(band.getByText(new RegExp(chatName))).toBeVisible({ timeout: 10000 });
  });

  test("TILE-3: la disposizione a due righe sopravvive al ricarico", async ({ page, request }) => {
    const a = await createTopic(request, `E2E-TileRowA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileRowB-${Date.now()}`);
    created.push(a.id, b.id);

    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [a.id, b.id],
        pinnedLayout: [{ keys: [a.id], widths: [1] }, { keys: [b.id], widths: [1] }],
      },
    });
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    const first = await tiles(page).nth(0).boundingBox();
    const second = await tiles(page).nth(1).boundingBox();
    // Due righe: `top` diversi. È la disposizione salvata, non il wrap naturale.
    expect(second!.y).toBeGreaterThan(first!.y + first!.height / 2);

    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    const firstAfter = await tiles(page).nth(0).boundingBox();
    const secondAfter = await tiles(page).nth(1).boundingBox();
    expect(secondAfter!.y).toBeGreaterThan(firstAfter!.y + firstAfter!.height / 2);
  });

  test("TILE-4: togliere il pin toglie la tessera, e le altre restano dove sono", async ({ page, request }) => {
    const a = await createTopic(request, `E2E-TileDropA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileDropB-${Date.now()}`);
    created.push(a.id, b.id);

    await setPins(page, [a.id, b.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });

    await setPins(page, [b.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });
    await expect(tiles(page)).toHaveAttribute("aria-label", /E2E-TileDropB/);
  });

  test("TILE-5: uno stato salvato senza disposizione non rompe niente", async ({ page, request }) => {
    // È il caso di ogni client che aggiorna: i pin ci sono, il campo del layout
    // no. Le tessere devono uscire nell'ordine di pin, senza errori.
    const a = await createTopic(request, `E2E-TileLegacyA-${Date.now()}`);
    const b = await createTopic(request, `E2E-TileLegacyB-${Date.now()}`);
    created.push(a.id, b.id);

    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [a.id, b.id] },
    });

    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await gotoSidebar(page);

    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    expect(errors, "nessun errore di pagina").toEqual([]);
  });
  test("TILE-6: la tessera porta ancora la chiave che apre il pane nella griglia", async ({ page, request }) => {
    // È il rischio numero uno di questa change. La tessera scrive DUE tipi sullo
    // stesso dataTransfer: `PINNED_TILE` per il riordino dentro la griglia dei
    // fissati, e `PANEL_ID` per la griglia dei pane, che è il drag «apri qui»
    // che esisteva prima. Se il secondo si perdesse, quel gesto morirebbe senza
    // che niente lo dica — nessun errore, solo un drag che non fa nulla.
    const t = await createTopic(request, `E2E-TileToGrid-${Date.now()}`);
    created.push(t.id);
    await setPins(page, [t.id]);
    await gotoSidebar(page);
    await expect(tiles(page).first()).toBeVisible({ timeout: 15000 });

    // Si legge dal `dataTransfer` vero prodotto dal `dragstart` della tessera,
    // non dal sorgente: un `setData` rimosso passerebbe qualunque lettura del
    // codice, non questa.
    const types = await page.evaluate(() => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      if (!el) return [];
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const seen = Array.from(dt.types);
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return seen;
    });
    expect(types).toContain("application/x-pinned-tile");
    expect(types).toContain("application/x-panel-id");
  });
});
