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

    // Nessuna etichetta, in NESSUNO dei modi di vista rimasti (il modo "per
    // tipo" è stato rimosso il 06/08). Il modo si imposta dal
    // lato server invece di cercare il bottone che lo cicla: qui si verifica
    // l'assenza dell'intestazione, e un click che non trova il suo bersaglio
    // renderebbe questo controllo un test che non può fallire.
    for (const viewMode of ["timeline", "state"] as const) {
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

  test("TILE-7: la tessera di un progetto porta l'id della PANE, non quello della riga", async ({ page, request }) => {
    // Le due chiavi servono a due cose diverse: `PINNED_TILE` e' la chiave della
    // RIGA (il layout), `PANEL_ID` quella della PANE — e per un progetto sono
    // due stringhe (path grezzo vs codificato). Chi riceve `PANEL_ID` apre o
    // sposta una pane: con l'id della riga il drop cadrebbe su una pane che non
    // esiste, senza un errore.
    // Path SUO: `/tmp/e2e-tile-project` è già di TILE-2, e `hermetic` riparte
    // dalla baseline una volta per FILE, non per test — condividerlo significa
    // ereditare le pane e i gruppi che gli altri hanno lasciato aperti.
    const projectPath = "/tmp/e2e-tile-paneid";
    const chat = await createTopic(request, `E2E-TilePaneId-${Date.now()}`, { projectPath });
    created.push(chat.id);
    await setPins(page, [`project:${projectPath}`]);
    await gotoSidebar(page);
    await expect(tiles(page).first()).toBeVisible({ timeout: 15000 });

    const payload = await page.evaluate(() => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      if (!el) return null;
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const out = {
        row: dt.getData("application/x-pinned-tile"),
        pane: dt.getData("application/x-panel-id"),
      };
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      return out;
    });
    expect(payload).not.toBeNull();
    expect(payload!.row).toBe(`project:${projectPath}`);
    expect(payload!.pane).toBe(`project:${encodeURIComponent(projectPath)}`);
    expect(payload!.pane).toContain("%2F");
    expect(payload!.pane).not.toBe(payload!.row);
  });

  test("TILE-8: lasciare una tessera CHIUSA su un gruppo la porta dentro quel gruppo", async ({ page, request }) => {
    // Il caso che falliva in silenzio. `movePaneToSpace` sposta una pane
    // ESISTENTE: una tessera fissata con la tab chiusa non ha pane — cioè lo
    // stato normale di un fissato da quando chiuderlo è permesso — quindi il
    // drop non aveva niente da spostare e non faceva nulla, senza un errore.
    const dentro = await createTopic(request, `E2E-TileInGroup-${Date.now()}`);
    const altra = await createTopic(request, `E2E-TileGroupSeed-${Date.now()}`);
    created.push(dentro.id, altra.id);

    // `altra` aperta serve solo a far NASCERE un gruppo: un gruppo si crea
    // portandoci una tab, non da un comando a vuoto.
    await page.request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [altra.id] } });
    await setPins(page, [dentro.id]);
    await gotoSidebar(page);
    await expect(page.locator(`[data-pane-id="${altra.id}"]`).first()).toBeVisible({ timeout: 15000 });

    await page.locator(`[data-pane-id="${altra.id}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
    await expect(page.getByTestId("sidebar-groups")).toBeVisible({ timeout: 10000 });

    const tile = tiles(page).first();
    await expect(tile).toBeVisible({ timeout: 10000 });

    // Il gruppo BERSAGLIO è quello appena nato, non il predefinito: le card
    // sono due, e colpire la prima che capita proverebbe la cosa sbagliata.
    const targetSpaceId = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('[data-testid="space-card"], [data-testid="space-card-active"]'),
      ) as HTMLElement[];
      const target = cards
        .map(c => c.getAttribute("data-space-id") ?? "")
        .find(id => id.startsWith("space:") && id !== "space:default");
      return target ?? null;
    });
    expect(targetSpaceId, "dev'esserci un gruppo diverso dal predefinito").not.toBeNull();

    // Drop sintetico: gli stessi eventi che manda il browser, con il
    // dataTransfer prodotto dalla tessera. Playwright non guida un drag HTML5
    // nativo in modo affidabile, e qui interessa il CONTRATTO, non il gesto.
    await page.evaluate((spaceId) => {
      const el = document.querySelector("[data-pinned-tile]") as HTMLElement | null;
      const card = document.querySelector(`[data-space-id="${spaceId}"]`) as HTMLElement | null;
      if (!el || !card) throw new Error("tessera o card mancante");
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      card.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      card.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    }, targetSpaceId);

    // La cosa fissata è ora una pane VIVA, e vive in QUEL gruppo.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`);
          const env = await res.json();
          const store = env?.value ?? env;
          const pane = store?.panes?.[dentro.id];
          if (!pane) return "nessuna pane";
          return pane.spaceId ?? "gruppo predefinito";
        },
        { timeout: 15000 },
      )
      .toBe(targetSpaceId);
  });

  test("TILE-9: lasciare una tab sui fissati la fissa", async ({ page, request }) => {
    // Il gesto inverso di trascinarla via. Senza, l'unica strada per fissare era
    // il menu contestuale — che dentro una card di gruppo non tutte le righe
    // hanno, quindi da lì una cosa non si poteva proprio fissare.
    const t = await createTopic(request, `E2E-TileAdopt-${Date.now()}`);
    const gia = await createTopic(request, `E2E-TileAdoptSeed-${Date.now()}`);
    created.push(t.id, gia.id);

    // Un fissato serve solo a far esistere la griglia su cui lasciar cadere.
    await page.request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [t.id] } });
    await setPins(page, [gia.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${t.id}"]`).first()).toBeVisible({ timeout: 10000 });

    await page.evaluate((paneId) => {
      const tab = document.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement | null;
      const grid = document.querySelector('[data-testid="sidebar-pinned-section"]') as HTMLElement | null;
      if (!tab || !grid) throw new Error("tab o griglia mancante");
      const dt = new DataTransfer();
      tab.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      grid.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      grid.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      tab.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    }, t.id);

    await expect(tiles(page)).toHaveCount(2, { timeout: 10000 });
    await expect(
      section(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name: new RegExp("E2E-TileAdopt-") })),
    ).toBeVisible({ timeout: 10000 });

    // E il pin è arrivato al server, non solo allo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedItems ?? []).includes(t.id);
      }, { timeout: 15000 })
      .toBe(true);
  });

  test("TILE-10: riordinare dentro una riga mostra l'anteprima, non solo il risultato", async ({ page, request }) => {
    // Il caso più comune — spostare due tessere vicine — non mostrava niente:
    // l'anteprima scattava solo quando la riga GUADAGNAVA una cella, e dentro
    // la stessa riga il conteggio non cambia. Si trascinava alla cieca.
    const ids: string[] = [];
    for (const n of ["E2E-Ord-A", "E2E-Ord-B", "E2E-Ord-C"]) {
      const t = await createTopic(request, `${n}-${Date.now()}`);
      created.push(t.id);
      ids.push(t.id);
    }
    await setPins(page, ids);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(3, { timeout: 15000 });

    const ordine = () => tiles(page).evaluateAll(els =>
      els.map(e => e.getAttribute("data-pinned-tile") ?? ""),
    );
    expect(await ordine()).toEqual(ids);

    // Un GESTO solo, in una evaluate sola: dragstart → dragover → drop → dragend
    // sullo stesso `DataTransfer`. Separarli in piu' evaluate significherebbe
    // fabbricarne uno nuovo per il drop — senza i tipi che il dragstart ci ha
    // messo — e il drop verrebbe ignorato, che e' un difetto del test travestito
    // da difetto del prodotto.
    const [durante, dopo] = await page.evaluate(async (key) => {
      const due = (r: HTMLElement) =>
        Array.from(r.querySelectorAll("[data-pinned-tile]")).map(e => e.getAttribute("data-pinned-tile") ?? "");
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const tile = document.querySelector(`[data-pinned-tile="${key}"]`) as HTMLElement;
      const row = tile.parentElement!.parentElement as HTMLElement;
      const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();

      tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const mentreTrascini = due(row);

      row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      tile.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return [mentreTrascini, due(row)];
    }, ids[2]);

    // L'anteprima e' gia' l'ordine finale…
    expect(durante, "l'anteprima deve mostrare l'ordine finale").toEqual([ids[2], ids[0], ids[1]]);
    // …e rilasciando resta esattamente cio' che si vedeva.
    expect(dopo, "il drop deve confermare l'anteprima").toEqual([ids[2], ids[0], ids[1]]);

    // E la disposizione e' arrivata al server, non solo allo schermo.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).flatMap((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([ids[2], ids[0], ids[1]]);
  });
});

/**
 * Il drop che arriva da FUORI, e la Board generale.
 *
 * Sono lo stesso pezzo visto da due lati: la board si fissa perché la sua riga è
 * trascinabile e i Fissati sanno accogliere una pane qualunque — non perché sia
 * stato scritto un percorso apposta per lei.
 */
test.describe("Sidebar — fissare da fuori, e la Board generale", () => {
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("TILE-11: trascinare un progetto sui Fissati mostra dove finisce, e ci finisce", async ({ page, request }) => {
    // Il difetto: sul drag esterno si accendeva solo il riquadro dell'intera
    // sezione — «cade qui dentro», non DOVE. E il drop accodava comunque, perché
    // fissare e disporre sono due scritture che riconciliano l'una sull'altra e
    // la cella della cosa appena fissata veniva scartata.
    const projectPath = "/tmp/e2e-tile-dropin";
    const projChat = await createTopic(request, `E2E-DropIn-Proj-${Date.now()}`, { projectPath });
    const solo = await createTopic(request, `E2E-DropIn-Pinned-${Date.now()}`);
    created.push(projChat.id, solo.id);

    await setPins(page, [solo.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    // La sorgente è la RIGA VERA del progetto nell'albero: il payload lo produce
    // il suo `dragstart`, non il test. Un `setData` rimosso fallisce qui.
    const projectRow = page.locator('[draggable="true"]').filter({ hasText: "e2e-tile-dropin" }).first();
    await expect(projectRow).toBeVisible({ timeout: 15000 });

    const esito = await projectRow.evaluate(async (src) => {
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const section = document.querySelector('[data-testid="sidebar-pinned-section"]') as HTMLElement;
      const row = (section.querySelector("[data-pinned-tile]") as HTMLElement).parentElement!.parentElement as HTMLElement;
      const box = (row.querySelector("[data-pinned-tile]") as HTMLElement).getBoundingClientRect();
      // A sinistra della metà della prima tessera ⇒ posizione 0.
      const punto = { clientX: box.left + 2, clientY: box.top + 5 };
      const dt = new DataTransfer();

      src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      const tipi = Array.from(dt.types);
      row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      await attendi();
      const durante = {
        fantasma: !!row.querySelector('[data-testid="pinned-drop-ghost"]'),
        celle: row.children.length,
        // Il riquadro sull'INTERA sezione si spegne: l'anteprima precisa c'è già,
        // e due segnali per lo stesso fatto ne fanno uno muto.
        sezioneAccesa: section.className.includes("ring-primary/40"),
      };

      row.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...punto }));
      src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
      await attendi();
      return { tipi, durante };
    });

    expect(esito.tipi, "la riga del progetto deve portare la chiave della PANE").toContain("application/x-panel-id");
    expect(esito.durante.fantasma, "l'anteprima deve disegnare la cella che nascerà").toBe(true);
    expect(esito.durante.celle, "la riga deve mostrarsi con una cella in più").toBe(2);
    expect(esito.durante.sezioneAccesa, "il riquadro dell'intera sezione deve spegnersi").toBe(false);

    // Fissato E in prima posizione: quella scelta col cursore, non in coda.
    await expect(tiles(page)).toHaveCount(2, { timeout: 15000 });
    await expect
      .poll(async () => {
        const res = await page.request.get(`${E2E_BASE}/api/ui-state/sidebar-state`);
        const env = await res.json();
        const v = env?.value ?? env;
        return (v?.pinnedLayout ?? []).flatMap((r: { keys: string[] }) => r.keys);
      }, { timeout: 15000 })
      .toEqual([`project:${projectPath}`, solo.id]);
  });

  test("TILE-12: la riga della Board e il filo divisore stanno sulla stessa colonna delle altre", async ({ page, request }) => {
    // La board era l'UNICA riga a filo dei bordi (px-3, niente card) e il filo
    // l'unico elemento rientrato di 12px: due colonne diverse nello stesso
    // elenco, che è esattamente ciò che si vedeva come «padding incoerente».
    const solo = await createTopic(request, `E2E-Pad-Pinned-${Date.now()}`);
    const altra = await createTopic(request, `E2E-Pad-Row-${Date.now()}`);
    created.push(solo.id, altra.id);
    await setPins(page, [solo.id]);
    await gotoSidebar(page);
    await expect(tiles(page)).toHaveCount(1, { timeout: 15000 });

    // La board compare quando la sua tab è aperta, anche a zero task.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
    const boardRow = page.getByTestId("sidebar-board-generale");
    await expect(boardRow).toBeVisible({ timeout: 15000 });

    const sidebar = page.locator('[aria-label="Topics sidebar"]');
    const bordo = (await sidebar.boundingBox())!.x;
    const sinistra = async (l: Locator) => Math.round((await l.boundingBox())!.x - bordo);

    const tessera = await sinistra(tiles(page).first());
    const board = await sinistra(boardRow);
    const filo = await sinistra(page.getByTestId("pinned-divider").first());

    // Un'unica colonna: ROW_INSET = 6px, la stessa per la card di ogni riga.
    expect(board, "la riga della board deve rientrare come una card").toBe(tessera);
    expect(filo, "il filo deve rientrare come le tessere sopra e le righe sotto").toBe(tessera);
  });

  test("TILE-13: la Board si fissa, diventa tessera e mostra i task PER STATO", async ({ page, request }) => {
    const stamp = Date.now();
    const inReview = await request.post(`${E2E_BASE}/api/boards/_none/tasks`, {
      data: { text: `E2E-Board-Review-${stamp}`, status: "review" },
    });
    expect(inReview.ok(), "il task in review deve nascere").toBe(true);
    const daFare = await request.post(`${E2E_BASE}/api/boards/_none/tasks`, {
      data: { text: `E2E-Board-Backlog-${stamp}`, status: "backlog" },
    });
    expect(daFare.ok()).toBe(true);
    const ids = [(await inReview.json()).id as string, (await daFare.json()).id as string];

    try {
      await setPins(page, []);
      await gotoSidebar(page);
      const boardRow = page.getByTestId("sidebar-board-generale");
      await expect(boardRow, "con task attivi la riga c'è anche a tab chiusa").toBeVisible({ timeout: 15000 });

      // Il menu della riga: una voce sola, e dice il verso GIUSTO.
      await boardRow.click({ button: "right" });
      const voce = page.getByTestId("pin-toggle-item");
      await expect(voce).toHaveText(/Aggiungi ai Fissati/, { timeout: 5000 });
      await voce.click();

      // Fissata è una TESSERA, e la riga sparisce: mai la stessa cosa in due posti.
      const tessera = tileNamed(page, "Board generale");
      await expect(tessera).toBeVisible({ timeout: 15000 });
      await expect(boardRow).toHaveCount(0);

      // La fascia sotto la tessera: i task, raggruppati per stato.
      await tessera.click();
      const band = page.getByTestId("board-state-band");
      await expect(band).toBeVisible({ timeout: 15000 });
      await expect(band.getByTestId("board-state-group-review")).toBeVisible();
      await expect(band.getByTestId("board-state-group-backlog")).toBeVisible();
      await expect(band.getByText(`E2E-Board-Review-${stamp}`)).toBeVisible();
      await expect(band.getByText(`E2E-Board-Backlog-${stamp}`)).toBeVisible();

      // Chi aspetta te sta in cima: l'ordine della fascia è di priorità, non
      // quello del kanban da sinistra a destra.
      const ordine = await band.locator('[data-testid^="board-state-group-"]').evaluateAll(els =>
        els.map(e => e.getAttribute("data-testid")),
      );
      expect(ordine.indexOf("board-state-group-review")).toBeLessThan(ordine.indexOf("board-state-group-backlog"));

      // E si torna indietro dalla stessa voce, col verso opposto.
      await tessera.click({ button: "right" });
      await expect(page.getByTestId("pin-toggle-item")).toHaveText(/Rimuovi dai Fissati/, { timeout: 5000 });
      await page.getByTestId("pin-toggle-item").click();
      await expect(page.getByTestId("sidebar-board-generale")).toBeVisible({ timeout: 15000 });
    } finally {
      for (const id of ids) {
        await request.delete(`${E2E_BASE}/api/boards/_none/tasks/${id}`).catch(() => {});
      }
    }
  });
});
