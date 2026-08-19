/**
 * COSA SI VEDE MENTRE TRASCINO, misurato nel documento.
 *
 * La segnalazione da cui nasce tutto: «fra tabbar splittate e' difficile fare
 * il drop perche' non c'e' nessuna anteprima». La meccanica del rilascio era
 * gia' a posto: mancava il riscontro DURANTE il gesto, cioe' i due segni che
 * questo file misura, uno per meta' della segnalazione.
 *
 *   1. COSA HO IN MANO: esiste un nodo `[data-drag-preview]`, si vede, e porta
 *      il nome della cosa presa. Non una stringa qualunque: il nome viene letto
 *      dalla superficie e poi cercato dentro l'anteprima, cosi' un'anteprima
 *      che mostrasse la cosa SBAGLIATA sarebbe rossa quanto una che non c'e'.
 *   2. DOVE CADRA': il bersaglio sotto il puntatore si marca `data-drop-active`
 *      con uno dei quattro intenti del contratto.
 *
 * Il contratto sta in `client/src/lib/dragPreview.ts` e ha gia' il suo test
 * unitario: quello prova che le funzioni facciano il loro mestiere. Qui si
 * prova l'altra meta', che nessun test di unita' puo' dire: che le SUPERFICI
 * lo chiamino davvero, nell'app montata.
 *
 * TRE SUPERFICI, e sono tre perche' arrivano al contratto per tre strade
 * diverse. Le prime due usano il drag HTML5; la terza no, e la differenza
 * decide come si scrive il gesto (vedi `iniziaGestoHtml5` piu' sotto).
 *
 *   a) le TAB BAR SPLITTATE, il caso letterale della segnalazione;
 *   b) le TESSERE della sidebar, righe dell'albero e Fissati;
 *   c) le CARD della board kanban, dove l'anteprima la disegna dnd-kit e il
 *      contratto si adotta MARCANDO quel nodo (vedi il commento sul
 *      `DragOverlay` in `KanbanBoardPane.tsx`).
 *
 * E, a gesto finito, che l'anteprima SPARISCA. Non e' un dettaglio di pulizia:
 * una scheda rimasta accesa resta incollata sopra l'interfaccia, e il contratto
 * ha cinque porte di spegnimento proprio perche' nella WKWebView `dragend` e
 * `drop` non sono garantiti. Qui se ne provano tre, una per superficie:
 * `dragend`, `drop`, e il sollevamento del pulsante.
 *
 * PERCHE' ANCHE IN WEBKIT. Vedi `docs/drag-preview.md`: `setDragImage` su un
 * nodo fuori dal viewport torna VUOTA solo li', ed e' il difetto da cui nasce
 * il contratto. Il progetto `webkit` di `playwright.config.ts` fa girare questo
 * file, e solo questo, nel motore del guscio.
 */
import { test, expect, type JSHandle, type Locator, type Page } from "@playwright/test";
import { existsSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna, isClipRun } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import {
  createTopic,
  deleteTask,
  deleteTopic,
  resetPaneStore,
  seedPaneStore,
  unarchiveTopic,
} from "./helpers/api-fixtures";
import { splitViaContextMenu } from "./helpers/layout";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

const BASE = E2E_BASE;

/** I quattro intenti di `DropIntent` (`lib/dragPreview`). Ripetuti qui e non
 *  importati: le spec non compilano contro i sorgenti del client, e un elenco
 *  divergente lo fa notare il test unitario del contratto, che li confronta con
 *  le regole di `index.css`. */
type Intento = "into" | "before" | "after" | "split";

/** L'anteprima. Il contratto dice UNO SOLO, e non piu' di uno alla volta. */
const anteprima = (page: Page): Locator => page.locator("[data-drag-preview]");

/**
 * Il primo dei due segni: c'e' una scheda, si vede, e dice cosa ho in mano.
 *
 * `toHaveCount(1)` non e' zelo: due anteprime insieme sono il difetto che il
 * contratto evita tenendo un nodo solo, e senza questa riga una superficie che
 * ne montasse una seconda passerebbe.
 */
async function anteprimaMostra(page: Page, nome: string): Promise<void> {
  const card = anteprima(page);
  await expect(card, "durante il gesto c'e' UNA anteprima sola").toHaveCount(1);
  await expect(card, "e si vede").toBeVisible();
  await expect(card, `e porta il nome della cosa presa (${nome})`).toContainText(nome);
}

/** Il secondo segno: il bersaglio dice che tipo di atterraggio sarebbe. */
async function bersaglioDichiara(bersaglio: Locator, attesi: readonly Intento[]): Promise<void> {
  await expect(
    bersaglio,
    `il bersaglio si dichiara con uno fra ${attesi.join(" / ")}`,
  ).toHaveAttribute("data-drop-active", new RegExp(`^(?:${attesi.join("|")})$`));
}

/** A gesto finito la scheda non resta incollata sopra l'interfaccia. */
async function anteprimaSpenta(page: Page): Promise<void> {
  await expect(anteprima(page), "a gesto finito l'anteprima sparisce").toHaveCount(0);
}

/** Un punto dentro la scatola di `loc`, in coordinate del viewport. */
async function punto(loc: Locator, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  const b = await loc.boundingBox();
  if (!b) throw new Error("elemento senza scatola: non c'e' niente da trascinare");
  return { x: Math.round(b.x + b.width * fx), y: Math.round(b.y + b.height * fy) };
}

/**
 * IL GESTO HTML5, con un `DataTransfer` costruito NELLA pagina.
 *
 * Perche' non col mouse vero, che altrove in questa suite funziona. Il mouse
 * fa nascere un drag di sistema, e da quel momento chi riceve gli eventi lo
 * decide l'hit test: sopra la cella accanto c'e' la zona di rilascio della
 * griglia, che copre la barra delle tab di quella cella. Misurato: portando il
 * puntatore sulla tab dell'altra barra, ogni `dragover` arrivava alla zona
 * della griglia e la barra non ne vedeva nemmeno uno. Il difetto vero e' un
 * altro discorso, ma un test che vuole misurare la BARRA non puo' dipendere da
 * chi le sta davanti.
 *
 * Con `dispatchEvent` l'evento si consegna all'elemento, e resta un evento
 * vero: il `DataTransfer` e' lo stesso oggetto dall'inizio alla fine, quindi i
 * tipi che il bersaglio legge sono ESATTAMENTE quelli che la sorgente ha
 * scritto nel suo `dragstart` (compreso l'ambito, che e' generato a runtime e
 * a mano non si saprebbe ricostruire). Ed e' anche l'unico modo che regge in
 * WebKit, dove il drag di sistema non si pilota.
 */
interface GestoHtml5 {
  /** Porta il puntatore sopra `bersaglio` (un `dragenter` e un `dragover` con
   *  le coordinate vere del punto). */
  sopra(bersaglio: Locator, fx?: number, fy?: number): Promise<void>;
  /** Lascia cadere: e' la porta `drop` dello spegnimento. */
  rilascia(bersaglio: Locator, fx?: number, fy?: number): Promise<void>;
  /** Chiude il gesto senza rilasciare: e' la porta `dragend`. */
  annulla(): Promise<void>;
}

async function iniziaGestoHtml5(page: Page, sorgente: Locator): Promise<GestoHtml5> {
  const dt: JSHandle<DataTransfer> = await page.evaluateHandle(() => new DataTransfer());
  const p = await punto(sorgente);
  await sorgente.dispatchEvent("dragstart", { dataTransfer: dt, clientX: p.x, clientY: p.y });
  // Se la sorgente non ha scritto niente sul trasporto, il gesto che segue
  // sarebbe una pantomima: ogni bersaglio si tirerebbe indietro sul tipo che
  // non trova, e le asserzioni sul bersaglio direbbero il falso in verde.
  const tipi = await dt.evaluate((d) => Array.from(d.types));
  expect(tipi.length, "il `dragstart` della sorgente ha riempito il trasporto").toBeGreaterThan(0);

  const consegna = async (tipo: string, bersaglio: Locator, fx: number, fy: number) => {
    const q = await punto(bersaglio, fx, fy);
    await bersaglio.dispatchEvent(tipo, { dataTransfer: dt, clientX: q.x, clientY: q.y });
  };

  return {
    async sopra(bersaglio, fx = 0.7, fy = 0.5) {
      await consegna("dragenter", bersaglio, fx, fy);
      await consegna("dragover", bersaglio, fx, fy);
    },
    async rilascia(bersaglio, fx = 0.7, fy = 0.5) {
      await consegna("drop", bersaglio, fx, fy);
    },
    async annulla() {
      await sorgente.dispatchEvent("dragend", { dataTransfer: dt });
    },
  };
}

// -- (a) LE TAB BAR SPLITTATE ------------------------------------------------

test.describe("Anteprima del trascinamento: le barre delle tab", () => {
  let idA = "";
  let idB = "";
  let idC = "";

  test.beforeAll(async ({ request }) => {
    idA = (await createTopic(request, "DPREV-A-" + Date.now())).id;
    idB = (await createTopic(request, "DPREV-B-" + Date.now())).id;
    idC = (await createTopic(request, "DPREV-C-" + Date.now())).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idA, idB, idC]) if (id) await deleteTopic(request, id).catch(() => {});
  });

  /** L'indice della barra che tiene la tab `id`. Serve a PROVARE che sorgente e
   *  bersaglio stanno in due barre diverse: senza, il test parlerebbe di
   *  riordino dentro una barra, non del caso della segnalazione. */
  async function barraDi(page: Page, id: string): Promise<number> {
    const idx = await page
      .locator('[role="main"] [data-testid="panel-tab-bar"]')
      .evaluateAll((barre, paneId) => barre.findIndex((b) => !!b.querySelector(`[data-pane-id="${paneId}"]`)), id);
    expect(idx, `la tab ${id} sta in una barra`).toBeGreaterThanOrEqual(0);
    return idx;
  }

  test("DPREV-01: una tab portata sull'altra barra mostra la sua scheda, e la barra di arrivo dice dove cade", async ({ page }) => {
    await resetPaneStore(page.request, [idA, idB, idC]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10_000 });

    await splitViaContextMenu(page, "Dividi a destra");
    await expect(page.getByTestId("panel-tab-bar")).toHaveCount(2, { timeout: 5_000 });

    const sorgente = page.locator(`[role="main"] [data-pane-id="${idC}"]`).first();
    const bersaglio = page.locator(`[role="main"] [data-pane-id="${idA}"]`).first();
    await expect(sorgente).toBeVisible();
    await expect(bersaglio).toBeVisible();
    expect(
      await barraDi(page, idC),
      "sorgente e bersaglio devono stare in DUE barre diverse, altrimenti non e' il caso segnalato",
    ).not.toBe(await barraDi(page, idA));

    // Il nome si legge DALLA TAB, non dal topic seminato: l'anteprima deve dire
    // la stessa parola che sta scritta sulla tab, e leggerla dall'API
    // proverebbe una cosa diversa.
    const nome = (await sorgente.getByTestId("pane-tab-label").innerText()).trim();
    expect(nome.length, "la tab ha un'etichetta da mostrare").toBeGreaterThan(0);

    const gesto = await iniziaGestoHtml5(page, sorgente);
    await anteprimaMostra(page, nome);
    await gesto.sopra(bersaglio);
    await anteprimaMostra(page, nome);
    // `before` / `after`: sulla barra si INSERISCE accanto a una tab, non si
    // entra dentro. Il lato dipende da dove cade il puntatore ed e' il drop a
    // deciderlo, non questo test.
    await bersaglioDichiara(bersaglio, ["before", "after"]);

    await gesto.annulla();
    await anteprimaSpenta(page);
  });
});

// -- (b) LE TESSERE DELLA SIDEBAR --------------------------------------------

/**
 * Il bersaglio qui e' la CARD DI UN GRUPPO, e il gruppo si semina invece di
 * crearlo dal menu: la voce di menu e' una frase tradotta, e un locator
 * agganciato a una frase la congela (vedi `tests/e2e/CONVENTIONS.md`). Il
 * gruppo e' il registro `spaces` del pane-store piu' una pane che ci vive
 * dentro: una card si disegna finche' tiene qualcosa.
 */
test.describe("Anteprima del trascinamento: le tessere della sidebar", () => {
  const SPAZIO = "space:dprev";
  let idRiga = "";
  let idTessera = "";
  let idAltrove = "";
  let nomeRiga = "";
  let nomeTessera = "";

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    nomeRiga = "DPREV-RIGA-" + stamp;
    nomeTessera = "DPREV-TESSERA-" + stamp;
    idRiga = (await createTopic(request, nomeRiga)).id;
    idTessera = (await createTopic(request, nomeTessera)).id;
    idAltrove = (await createTopic(request, "DPREV-ALTROVE-" + stamp)).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idRiga, idTessera, idAltrove]) {
      if (id) await deleteTopic(request, id).catch(() => {});
    }
  });

  /** Tre chat aperte, una delle quali vive in un SECONDO gruppo: e' quella che
   *  fa esistere la card da usare come bersaglio. Piu' una tessera fissata. */
  async function scena(page: Page): Promise<void> {
    const aperte = [idRiga, idTessera, idAltrove];
    await Promise.all(aperte.map((id) => unarchiveTopic(page.request, id)));
    await seedPaneStore(page.request, () => {
      const openedAt = Date.now();
      const pane = (id: string, spaceId?: string) => ({
        id,
        type: "chat",
        title: "",
        topicId: id,
        openedAt,
        ...(spaceId ? { spaceId } : {}),
      });
      return {
        panes: {
          [idRiga]: pane(idRiga),
          [idTessera]: pane(idTessera),
          [idAltrove]: pane(idAltrove, SPAZIO),
        },
        groups: {
          "group:default": { id: "group:default", paneIds: aperte, splitRatio: 1, splitAxis: "horizontal" },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
        spaces: { [SPAZIO]: { id: SPAZIO, name: "DPREV Gruppo", order: 1, updatedAt: openedAt } },
      };
    });
    await page.request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [idTessera],
        pinnedLayout: [{ keys: [idTessera], widths: [1] }],
      },
    }).catch(() => {});
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
  }

  /** La card dell'ALTRO gruppo. Quella attiva porta un testid diverso
   *  (`space-card-active`), quindi questo locator non puo' pescarla per sbaglio. */
  const cardAltroGruppo = (page: Page): Locator => page.getByTestId("space-card").first();

  test("DPREV-02: la riga dell'albero mostra il nome della chat, e la card del gruppo si dichiara", async ({ page }) => {
    await scena(page);
    // Il locator per nome accessibile E' la lettura dalla superficie: risolve
    // solo se e' la riga a portare quel nome.
    //
    // L'antenato e' la sidebar intera e NON `sidebar-timeline`. Quel contenitore
    // vive nel ramo SENZA gruppi di `TopicTree`, e i due rami si escludono a
    // vicenda. Questa scena un gruppo ce l'ha per forza, perche' la card
    // bersaglio esiste solo li': quindi la timeline non viene disegnata affatto,
    // e le righe fuori dai gruppi finiscono in `sidebar-loose`. Misurato sul DOM
    // della scena: `sidebar-timeline` assente, e la riga presente come
    // `treeitem` con il nome giusto. La sidebar come antenato tiene fuori la
    // barra delle tab e l'intestazione della pane, che portano lo stesso testo
    // ma non sono righe dell'albero.
    const riga = page
      .locator('[aria-label="Topics sidebar"]')
      .getByRole("treeitem", { name: new RegExp(nomeRiga) })
      .first();
    await expect(riga).toBeVisible({ timeout: 10_000 });
    const card = cardAltroGruppo(page);
    await expect(card, "il secondo gruppo ha la sua card").toBeVisible({ timeout: 10_000 });

    const gesto = await iniziaGestoHtml5(page, riga);
    await anteprimaMostra(page, nomeRiga);
    await gesto.sopra(card, 0.5, 0.4);
    await anteprimaMostra(page, nomeRiga);
    // `into`: il rilascio porta la chat DENTRO il gruppo, non accanto.
    await bersaglioDichiara(card, ["into"]);

    // Qui si chiude col rilascio VERO, che e' un'altra delle cinque porte di
    // spegnimento: `dragend` e `drop` non arrivano sempre entrambi.
    await gesto.rilascia(card, 0.5, 0.4);
    await anteprimaSpenta(page);
  });

  test("DPREV-03: la tessera FISSATA mostra il suo nome, che sulla tessera quadrata e' proprio la cosa che sparisce", async ({ page }) => {
    await scena(page);
    const tessera = page.locator(`[data-pinned-tile="${idTessera}"]`).first();
    await expect(tessera).toBeVisible({ timeout: 10_000 });
    const nome = (await tessera.getByTestId("pinned-tile-name").innerText()).trim();
    expect(nome, "la tessera mostra il nome della cosa fissata").toContain(nomeTessera);
    const card = cardAltroGruppo(page);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const gesto = await iniziaGestoHtml5(page, tessera);
    await anteprimaMostra(page, nome);
    await gesto.sopra(card, 0.5, 0.4);
    await anteprimaMostra(page, nome);
    await bersaglioDichiara(card, ["into"]);

    await gesto.annulla();
    await anteprimaSpenta(page);
  });
});

// -- (c) LE CARD DELLA BOARD -------------------------------------------------

/**
 * La board non usa il drag HTML5: dnd-kit ascolta i POINTER events, quindi qui
 * il gesto e' il mouse vero (down / move / up) e non ci sono `DragEvent` da
 * consegnare. Cambia anche chi disegna l'anteprima: la scheda e' il
 * `DragOverlay` di dnd-kit, che il contratto adotta MARCANDOLA invece di
 * montarne una seconda sotto lo stesso puntatore.
 */
test.describe("Anteprima del trascinamento: le card della board", () => {
  // 1600 come il banco dei fotogrammi: a 1280 le cinque colonne non ci stanno e
  // la colonna di arrivo finisce dietro uno scorrimento orizzontale.
  test.use({ viewport: { width: 1600, height: 900 } });

  const BOARD_ID = "dprev-e2e001";
  let idTask = "";
  let testoTask = "";

  test.beforeAll(async ({ request }) => {
    testoTask = "DPREV Card " + Date.now();
    const res = await request.post(`${BASE}/api/boards/${BOARD_ID}/tasks`, {
      data: { text: testoTask, status: "todo" },
    });
    expect(res.ok(), "la board accetta il task seminato").toBe(true);
    idTask = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (idTask) await deleteTask(request, BOARD_ID, idTask).catch(() => {});
  });

  test("DPREV-04: la card presa in mano mostra la sua scheda, e la colonna di arrivo si dichiara", async ({ page }) => {
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });

    const card = page.locator(`[data-task-card="${idTask}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card, "la card mostra il testo del task").toContainText(testoTask);
    // La colonna di arrivo dev'essere VUOTA: `boardCollision` preferisce una
    // card alla colonna che la contiene, quindi con dentro qualcosa il
    // bersaglio dichiarato sarebbe la card e non la colonna.
    const colonna = page.getByTestId("kanban-column-backlog");
    await expect(colonna).toBeVisible();
    const corpo = page.getByTestId("kanban-column-body-backlog");
    await expect(corpo.locator("[data-task-card]"), "il Backlog parte vuoto").toHaveCount(0);

    const presa = await punto(card, 0.5, 0.15);
    const arrivo = await punto(corpo, 0.5, 0.5);
    await page.mouse.move(presa.x, presa.y);
    await page.mouse.down();
    // I sensori partono dopo quattro pixel: questo e' il movimento che apre il
    // gesto e monta il `DragOverlay`.
    await page.mouse.move(presa.x + 8, presa.y + 8);
    await page.mouse.move(arrivo.x, arrivo.y, { steps: 12 });
    await page.mouse.move(arrivo.x, arrivo.y + 1, { steps: 2 });

    await anteprimaMostra(page, testoTask);
    await bersaglioDichiara(colonna, ["into"]);

    // Terza porta di spegnimento: il pulsante che si solleva.
    await page.mouse.up();
    await anteprimaSpenta(page);
  });

  /**
   * LA CLIP DI CONSEGNA, e perche' e' un video e non una fotografia.
   *
   * Cio' che va provato qui sono DUE stati in fila: la scheda che compare al
   * cursore mentre il gesto e' in corso, e la stessa scheda che SPARISCE quando
   * il gesto finisce. Un fermo immagine puo' mostrare il primo e non dice
   * niente del secondo, che e' meta' del difetto (un'anteprima rimasta accesa
   * resta incollata sopra l'interfaccia).
   *
   * Gira SOLO sotto `E2E_CLIP=1`, come `SLOT-3`: senza registrazione le pause
   * di lettura sarebbero secondi spesi davanti a una telecamera spenta, e le
   * asserzioni che restano sono le stesse quattro di DPREV-04, che le fa gia'.
   * Il tetto dei 20s del protocollo lo misura `clipDiConsegna` sul .webm.
   */
  test("DPREV-05: la clip di consegna (scheda al cursore, poi spenta)", async ({ page }) => {
    test.skip(!isClipRun(), "produce la clip di consegna: gira solo con E2E_CLIP=1");
    // Il progetto `webkit` fa girare questo stesso file, ma la clip apre un
    // browser TUTTO SUO (Chromium, vedi helpers/clip.ts): registrarla due volte
    // darebbe due file identici e il secondo sovrascriverebbe il primo.
    test.skip(test.info().project.name === "webkit", "la clip la registra il progetto chromium");
    await resetPaneStore(page.request, ["__board__"]);

    const clip = await clipDiConsegna({
      nome: "drag-preview",
      // Il contesto e' NOSTRO: niente del `use` di playwright.config arriva qui
      // da solo. 1280x720 = 0,563 di rapporto, sotto lo 0,70 oltre il quale la
      // card taglia la clip dal basso invece di rimpicciolirla; e a 268px di
      // larghezza — la misura a cui una card la mostra — la didascalia resta
      // leggibile, cosa che a 1600 non sarebbe piu' vera.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 720 },
      },
      // Fuori dalla registrazione: aprire la board e montarla e' lavoro di
      // scena, non la scena. Il layout resta scritto sul server e nel
      // `localStorage` del contesto, che la pagina della scena condivide.
      prologo: async (p) => {
        await p.goto("/");
        await p.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
        await p.locator('[data-pane-id="__board__"]').first().click();
        await expect(p.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
        await expect(p.locator(`[data-task-card="${idTask}"]`)).toBeVisible({ timeout: 20_000 });
      },
      scena: async (p) => {
        await p.goto("/");
        const card = p.locator(`[data-task-card="${idTask}"]`);
        await expect(card).toBeVisible({ timeout: 20_000 });
        const colonna = p.getByTestId("kanban-column-backlog");
        const corpo = p.getByTestId("kanban-column-body-backlog");
        await expect(colonna).toBeVisible({ timeout: 10_000 });

        await didascalia(p, "Prendo la card");
        await beat(p, 1400);

        const presa = await punto(card, 0.5, 0.15);
        const arrivo = await punto(corpo, 0.5, 0.35);
        await p.mouse.move(presa.x, presa.y);
        await p.mouse.down();
        await p.mouse.move(presa.x + 8, presa.y + 8);
        await p.mouse.move(presa.x + 40, presa.y + 24, { steps: 8 });
        await anteprimaMostra(p, testoTask);
        await didascalia(p, "La scheda intera segue il cursore");
        await beat(p, 2200);

        await p.mouse.move(arrivo.x, arrivo.y, { steps: 24 });
        await p.mouse.move(arrivo.x, arrivo.y + 1, { steps: 2 });
        await anteprimaMostra(p, testoTask);
        await bersaglioDichiara(colonna, ["into"]);
        await didascalia(p, "La colonna di arrivo dice dove cade");
        await beat(p, 2200);

        await p.mouse.up();
        await anteprimaSpenta(p);
        await didascalia(p, "A gesto finito la scheda sparisce");
        await beat(p, 2000);
      },
    });

    if (clip) {
      expect(existsSync(clip.path), `la clip deve stare su disco: ${clip.path}`).toBe(true);
      expect(clip.durataMs, "e durare abbastanza da leggersi a 268px").toBeGreaterThan(5_000);
    }
  });
});
