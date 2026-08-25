import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna, isClipRun } from "./helpers/clip";

/**
 * LO SLOT DEL «+» CEDE FINCHÉ IL «+» NON SI VEDE.
 *
 * La tessera di un progetto porta un comando — il «+» che apre una tab dentro
 * quel progetto — disegnato come FRATELLO assoluto sopra la tessera. La tessera
 * non lo rende e non lo può misurare: gli lascia uno SLOT vuoto
 * (`pinned-tile-action-slot`, largo quanto il bottone) perché il nome non gli
 * finisca sotto.
 *
 * Il difetto che questa spec recinta: quello slot era rigido
 * (`flex-shrink-0`), quindi tagliava il nome ventiquattro ore su ventiquattro
 * per un bottone che si vede solo al passaggio del mouse. La regola nuova sta
 * tutta nei fattori di contrazione — slot `shrink-[9999]` contro il nome
 * `flex-auto` (shrink 1), e `group-hover/cell:shrink-0` sullo slot:
 *
 *  · A RIPOSO chi si stringe è lo slot, per primo e fino a zero. Se il nome ci
 *    sta, non cambia niente; se non ci sta, il nome si prende quei pixel.
 *  · ALL'HOVER lo slot torna rigido e il nome gli ridà esattamente la larghezza
 *    del bottone che sta per apparire.
 *  · CON UN NOME CORTO non deve muoversi NIENTE fra i due stati: non c'è
 *    nessun disavanzo da distribuire, quindi lo slot resta largo e il nome
 *    resta identico al pixel.
 *
 * Si misura con `getBoundingClientRect`, non leggendo le classi: `shrink-[9999]`
 * è un valore arbitrario di Tailwind, e una regola che smettesse di essere
 * emessa lascerebbe il sorgente identico e lo schermo diverso.
 *
 * @covers LAYOUT-02
 */

hermetic(test);

/** Un nome che NON ci sta: la tessera è larga ~244px, questo ne chiede ~400. */
const LUNGO = "/tmp/e2e-slot-progetto-dal-nome-esageratamente-lungo-che-non-entra";
/** Un nome che ci sta con l'aria che avanza: il controllo di non-regressione. */
const CORTO = "/tmp/e2e-slot-corto";

/** Il nome mostrato dalla tessera di un progetto è il basename della cartella. */
const nomeDi = (path: string): string => path.split("/").pop()!;

/** La larghezza dello slot sopra i 768px: `md:w-7` di `PINNED_TILE_ACTION_SLOT`,
 *  che è per contratto la stessa di `ROW_ACTION_BOX` — il box del «+». Il test
 *  la ricontrolla comunque contro il bottone VERO, che è ciò che lo slot deve
 *  riservare: due numeri uguali per costruzione non proverebbero niente. */
const SLOT_MD = 28;

const created: string[] = [];

/** Una cartella con dentro una `favicon.png` vera, così il progetto prende il
 *  ramo «icona reale» e il suo ingombro a sinistra è STABILE: senza icona la
 *  tessera tiene un segnaposto da 18px mentre sonda e lo toglie dopo, cioè il
 *  nome scivolerebbe di 18px nel mezzo di una misura. Copiata da
 *  `sidebar-pinned-tiles.spec.ts`: un PNG 1×1 basta, il server serve il file e
 *  non lo giudica. */
function mkdirWithIcon(dir: string): void {
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/favicon.png`, Buffer.from(PNG_1x1, "base64"));
}

/**
 * Fissa i due progetti su DUE RIGHE, una per uno.
 *
 * Una riga sola per tessera non è un dettaglio: è l'unica leva sulla larghezza
 * (`reconcilePinnedLayout` pareggia le larghezze dentro una riga), e sotto i
 * 200px la tessera cambia allineamento — sotto i 104 lo slot non si disegna
 * proprio. Due tessere sulla stessa riga sarebbero larghe ~119px e proverebbero
 * un altro caso.
 */
async function seed(page: Page): Promise<void> {
  const chiavi = [`project:${LUNGO}`, `project:${CORTO}`];
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: chiavi,
      pinnedLayout: chiavi.map(k => ({ keys: [k], widths: [1] })),
    },
  });
}

async function gotoSidebar(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

const section = (page: Page): Locator => page.getByTestId("sidebar-pinned-section");

/** La TESSERA di quel progetto — ristretta ai `pinned-tile` perché una fascia
 *  aperta contiene le righe delle tab, anch'esse `treeitem` con quel nome. */
function tileNamed(page: Page, name: string): Locator {
  return section(page).getByTestId("pinned-tile").and(page.getByRole("treeitem", { name }));
}

/** La CELLA che porta quella tessera: è lei il `group/cell` da cui dipende
 *  `group-hover/cell:shrink-0`, ed è lei che si passa col mouse. */
function cellNamed(page: Page, name: string): Locator {
  return section(page)
    .locator("div.group\\/cell")
    .filter({ has: page.getByRole("treeitem", { name }) });
}

interface Misura {
  /** Larghezza dello slot vuoto del «+». */
  slot: number;
  /** Larghezza della scatola del nome. */
  nome: number;
  /** Quanto resta fra la fine del nome e il bordo INTERNO della tessera (cioè
   *  dentro il padding): è lo spazio che il nome NON usa. */
  coda: number;
  tessera: number;
  /** Il nome eccede davvero la sua scatola? Senza, il test proverebbe la
   *  geometria di un caso che non è quello sotto esame. */
  troncato: boolean;
}

async function misura(page: Page, name: string): Promise<Misura> {
  return await tileNamed(page, name).evaluate((tile): Misura => {
    const slot = tile.querySelector('[data-testid="pinned-tile-action-slot"]');
    const nome = tile.querySelector('[data-testid="pinned-tile-name"]') as HTMLElement;
    const t = tile.getBoundingClientRect();
    const n = nome.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(tile).paddingRight);
    return {
      slot: slot ? slot.getBoundingClientRect().width : Number.NaN,
      nome: n.width,
      coda: t.right - padRight - n.right,
      tessera: t.width,
      troncato: nome.scrollWidth > nome.clientWidth + 0.5,
    };
  });
}

/**
 * I NUMERI, a schermo.
 *
 * Un'asserzione verde dice «il conto torna», non QUANTO: e qui la revisione è
 * proprio sui pixel — quanto lo slot cede, quanto il nome guadagna, quanto resta
 * fra il nome e il bordo. Senza questa riga bisogna rimettere le mani nel test
 * per rileggerli, che è il modo classico di non rileggerli mai.
 */
function stampa(caso: string, riposo: Misura, hover: Misura): void {
  const n = (v: number) => v.toFixed(1).padStart(6);
  // eslint-disable-next-line no-console -- è l'unico canale con cui la misura arriva a chi ha lanciato il test
  console.log(
    `[slot] ${caso} — tessera ${n(riposo.tessera)}px\n` +
      `[slot]   riposo: slot ${n(riposo.slot)}  nome ${n(riposo.nome)}  coda ${n(riposo.coda)}\n` +
      `[slot]   hover : slot ${n(hover.slot)}  nome ${n(hover.nome)}  coda ${n(hover.coda)}\n` +
      `[slot]   delta : slot ${n(hover.slot - riposo.slot)}  nome ${n(hover.nome - riposo.nome)}`,
  );
}

/** Porta il mouse FUORI dalla griglia dei fissati, senza toccare nient'altro di
 *  colpibile: il centro del pannello a destra della colonna. */
async function viaIlMouse(page: Page): Promise<void> {
  const v = page.viewportSize()!;
  await page.mouse.move(Math.round(v.width * 0.75), Math.round(v.height * 0.75));
}

test.describe("Sidebar — lo slot del «+» sulla tessera fissata", () => {
  test.beforeAll(async ({ request }) => {
    for (const path of [LUNGO, CORTO]) {
      mkdirWithIcon(path);
      const t = await createTopic(request, `E2E-Slot-${nomeDi(path)}-${Date.now()}`, { projectPath: path });
      created.push(t.id);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    created.length = 0;
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
  });

  test("SLOT-1: col nome lungo lo slot cede a riposo e riprende i suoi pixel all'hover", async ({ page }) => {
    await seed(page);
    await gotoSidebar(page);

    const nome = nomeDi(LUNGO);
    const tessera = tileNamed(page, nome);
    await expect(tessera).toBeVisible({ timeout: 15000 });
    // L'icona è arrivata: da qui in poi l'ingombro a sinistra non si muove più.
    await expect(tessera.locator("img"), "la favicon regge l'ingombro a sinistra").toHaveCount(1, { timeout: 15000 });

    const cella = cellNamed(page, nome);
    const piu = cella.getByTestId("pane-add-menu-trigger");
    // Il «+» esiste (è una tessera di PROGETTO, l'unica che porta comandi) ma a
    // riposo non si vede: è tutta la ragione per cui lo slot deve cedere.
    await expect(piu, "la tessera di un progetto porta il «+»").toHaveCount(1, { timeout: 15000 });
    await expect(piu, "…che a riposo non si vede").toBeHidden();

    const riposo = await misura(page, nome);
    expect(riposo.tessera, "forma RIGA: una tessera sola sulla sua riga").toBeGreaterThan(200);
    expect(riposo.troncato, "il nome deve davvero eccedere, o non c'è niente da contendersi").toBe(true);
    // A RIPOSO LO SLOT NON C'È: si è stretto fino a zero.
    expect(riposo.slot, `slot a riposo = ${riposo.slot}`).toBeLessThanOrEqual(0.5);

    await cella.hover();
    await expect(piu, "passando il mouse il «+» compare").toBeVisible();
    // La geometria è già quella finale (nessuna transizione su flex), ma la si
    // aspetta invece di leggerla al volo: un solo frame di ritardo qui sarebbe
    // un rosso che non parla del prodotto.
    await expect
      .poll(async () => Math.round((await misura(page, nome)).slot), { timeout: 5000 })
      .toBe(SLOT_MD);

    const hover = await misura(page, nome);
    const box = (await piu.boundingBox())!;
    stampa("nome lungo", riposo, hover);

    // LO SLOT VALE ESATTAMENTE IL BOTTONE che deve ospitare. Misurato contro il
    // «+» vero e non contro la costante: è QUESTO che lo slot promette.
    expect(hover.slot, "lo slot all'hover è largo quanto il «+»").toBeCloseTo(box.width, 0);
    expect(hover.slot, "e a questa larghezza di finestra sono i 28px di `md:w-7`").toBeCloseTo(SLOT_MD, 0);

    // E IL NOME CEDE ESATTAMENTE QUEI PIXEL, né uno di più.
    expect(riposo.nome - hover.nome, "il nome cede al «+» la larghezza del «+»").toBeCloseTo(SLOT_MD, 0);
    expect(hover.coda - riposo.coda, "…e lo spazio lasciato libero è lo stesso").toBeCloseTo(SLOT_MD, 0);

    // A riposo il nome arriva al bordo interno della tessera: resta solo il
    // `gap-2` della riga, che separa il nome dallo slot ormai a zero. Non è
    // zero — un gap flex si disegna anche fra un elemento e uno largo 0 — ma è
    // l'unica cosa rimasta: prima qui c'erano gap + 28px di slot rigido.
    expect(riposo.coda, `coda a riposo = ${riposo.coda}px (solo il gap della riga)`).toBeLessThan(SLOT_MD / 2);

    // Togliendo il mouse si torna esattamente allo stato di prima: il gesto è
    // reversibile, non una riga che si assesta a una misura nuova.
    await viaIlMouse(page);
    await expect(piu).toBeHidden();
    await expect
      .poll(async () => Math.round((await misura(page, nome)).nome), { timeout: 5000 })
      .toBe(Math.round(riposo.nome));
  });

  test("SLOT-2: col nome corto fra riposo e hover non si muove niente", async ({ page }) => {
    // È il controllo di non-regressione, e il motivo per cui la leva sono i
    // fattori di contrazione e non un `display` che appare all'hover: senza
    // disavanzo da distribuire lo slot resta largo, e il nome non ha nessun
    // motivo di saltare quando ci passi accanto.
    await seed(page);
    await gotoSidebar(page);

    const nome = nomeDi(CORTO);
    const tessera = tileNamed(page, nome);
    await expect(tessera).toBeVisible({ timeout: 15000 });
    await expect(tessera.locator("img")).toHaveCount(1, { timeout: 15000 });

    const cella = cellNamed(page, nome);
    const piu = cella.getByTestId("pane-add-menu-trigger");
    await expect(piu).toHaveCount(1, { timeout: 15000 });

    const riposo = await misura(page, nome);
    expect(riposo.troncato, "questo nome ci sta per intero").toBe(false);
    expect(riposo.slot, "a riposo lo slot è già largo: non c'è niente da cedere").toBeCloseTo(SLOT_MD, 0);

    await cella.hover();
    await expect(piu).toBeVisible();
    const hover = await misura(page, nome);
    stampa("nome corto", riposo, hover);

    expect(hover.slot, "e all'hover resta largo uguale").toBeCloseTo(riposo.slot, 1);
    expect(hover.nome, "il nome non si muove di un pixel").toBeCloseTo(riposo.nome, 1);
    expect(hover.coda, "e nemmeno lo spazio che gli sta dietro").toBeCloseTo(riposo.coda, 1);

    await viaIlMouse(page);
  });

  test("SLOT-3: la clip di consegna", async ({ page }) => {
    // GIRA SOLO QUANDO PRODUCE DAVVERO LA CLIP.
    //
    // Le due asserzioni che appartengono a SLOT-3 stanno dentro `if (clip)`, e
    // `clipDiConsegna` ritorna `null` fuori da `E2E_CLIP=1` (helpers/clip.ts):
    // in una passata normale non venivano MAI eseguite. Quello che restava era
    // la scena — 9,5 secondi di `waitForTimeout` per far vedere i tre stati a
    // una telecamera spenta — e le sue asserzioni di contorno (tessera
    // visibile, una favicon, «+» all'hover, «+» nascosto dopo) sono le stesse
    // che SLOT-1 fa gia', misurando anche i pixel invece di guardarli.
    //
    // Costo tolto dalla passata: 11,4s misurati. Copertura persa: nessuna.
    // Verificato caso per caso sulle altre cinque spec che usano
    // `clipDiConsegna` — hanno da 12 a 22 asserzioni FUORI da `if (clip)` e
    // zero sonni fissi: sono test veri che per giunta producono una clip, e
    // vanno lasciati dove sono.
    test.skip(!isClipRun(), "produce la clip di consegna: gira solo con E2E_CLIP=1");
    // La scena: tessera a riposo col nome più lungo che si riesca a leggere →
    // il mouse entra, il «+» compare e il nome gli cede i suoi 28px → il mouse
    // se ne va e il nome torna intero. Registra solo sotto `E2E_CLIP=1`; senza,
    // gira identica e non salva niente (vedi `helpers/clip.ts`).
    await seed(page);

    const nome = nomeDi(LUNGO);
    const clip = await clipDiConsegna({
      nome: "pinned-tile-action-slot",
      budgetMs: 15_000,
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1000, height: 620 },
      },
      // Il prologo scalda cache e `localStorage` su una pagina il cui video
      // viene buttato: la scena parte già sull'app montata.
      prologo: async (p) => {
        await p.goto("/");
        await p.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
        await expect(tileNamed(p, nome)).toBeVisible({ timeout: 15000 });
      },
      scena: async (p) => {
        await p.goto("/");
        const tessera = tileNamed(p, nome);
        await expect(tessera).toBeVisible({ timeout: 15000 });
        await expect(tessera.locator("img")).toHaveCount(1, { timeout: 15000 });
        const cella = cellNamed(p, nome);
        const piu = cella.getByTestId("pane-add-menu-trigger");

        // 1. A riposo: nessun «+», il nome arriva al bordo.
        await p.waitForTimeout(3000);
        // 2. Il mouse entra: il «+» compare e il nome si accorcia.
        await cella.hover();
        await expect(piu).toBeVisible();
        await p.waitForTimeout(3500);
        // 3. Il mouse se ne va: il nome torna intero.
        await p.mouse.move(750, 460);
        await expect(piu).toBeHidden();
        await p.waitForTimeout(3000);
      },
    });

    if (clip) {
      expect(fs.existsSync(clip.path), `la clip deve stare su disco: ${clip.path}`).toBe(true);
      expect(clip.durataMs, "e durare abbastanza da leggersi").toBeGreaterThan(5_000);
    }
  });
});
