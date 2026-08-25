/**
 * IL COMANDO IN CODA — misurato dove viene disegnato.
 *
 * «Il tasto chiusura deve essere sempre a fine tab, andando in hover sulle icone
 * invece inutili» (Attilio, 09/08), e alla domanda su come debba comportarsi lo
 * slot: «no, deve andare da sopra nascondendo quelli che stanno sotto inutili».
 *
 * Sono due promesse, e nessuna delle due è verificabile da una costante:
 *
 *  1. il comando sta alla STESSA x su ogni superficie — una riga della colonna e
 *     una tab della barra sono due file diversi, e prima la sua posizione
 *     dipendeva da quanti glifi lo precedevano (una tab che streama e una ferma
 *     mettevano il tasto in due punti diversi);
 *  2. ci passa SOPRA: il binario quieto non si sposta di un pixel fra riposo e
 *     passaggio del mouse, sbiadisce e basta. Il difetto vecchio era l'opposto —
 *     il tempo si nascondeva (`group-hover:hidden`) per liberare il posto, e lo
 *     slot cambiava larghezza a ogni stato.
 *
 * Una costante non può dirlo perché ogni volta le costanti erano coerenti fra
 * loro: il difetto stava nel COMPOSTO, cioè nel rettangolo renderizzato. Quindi
 * si misura lì.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE as BASE } from "./helpers/test-server";

hermetic(test);

/** `ROW_PX` risolto in pixel (lib/selectionStyles.ts) — l'incasso destro del
 *  GLIFO che `.row-actions` promette in `index.css` (`ROW_ACTIONS_INSET_PX`).
 *  La sua SCATOLA sta più a destra apposta: vedi `comandoDi`. */
const ROW_PX = 8;
/** `COLUMN_GAP` (lib/selectionStyles.ts): mezzo passo per card, sei fra due. */
const COLUMN_GAP = 6;
/** Quanto lasco si concede a una misura di layout prima di chiamarla diversa.
 *  Sub-pixel: i rettangoli arrivano da `getBoundingClientRect`, che è frazionario
 *  quando c'è di mezzo uno `zoom` o un fattore di scala del display. */
const EPS = 0.6;

const ids: string[] = [];
const nomi: string[] = [];

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  // Due topic: uno per aprire la tab (la barra vuole almeno una tab) e due
  // righe adiacenti nella colonna per poter misurare il passo verticale.
  for (let i = 0; i < 2; i++) {
    const n = `E2E-CodaComando-${stamp}-${i}`;
    const t = await createTopic(request, n);
    ids.push(t.id);
    nomi.push(n);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of ids) await deleteTopic(request, id).catch(() => {});
});

interface Rett { x: number; y: number; w: number; h: number }

async function rett(l: Locator, nome: string): Promise<Rett> {
  const b = await l.boundingBox();
  if (!b) throw new Error(`nessun rettangolo per ${nome}`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/**
 * The same rectangle, read once the layout has STOPPED: re-read until two
 * consecutive samples agree.
 *
 * Every geometric read here used to sit behind a fixed 200 ms sleep, betting
 * that the hover transition was over. A CSS transition is not on anybody's
 * clock: on a loaded machine that bet samples the rail mid-flight and produces a
 * red nobody can reproduce, on an idle one it burns 200 ms for a rail that had
 * already stopped. "It stopped moving" is the condition the sleep stood for.
 */
async function settledRectangle(l: Locator, nome: string): Promise<Rett> {
  let previous = "";
  let settled: Rett | null = null;
  await expect
    .poll(
      async () => {
        const r = await rett(l, nome);
        const shot = JSON.stringify(r);
        const quiet = shot === previous;
        previous = shot;
        if (quiet) settled = r;
        return quiet;
      },
      { timeout: 5_000, message: `${nome}: il rettangolo non si è mai fermato` },
    )
    .toBe(true);
  return settled!;
}

/**
 * IL COMANDO SI MISURA SUL CERCHIO, NON SULLA SUA SCATOLA.
 *
 * `.row-actions` è la scatola del bersaglio (28px col mouse, 36 col dito) e il
 * cerchio disegnato dentro ne fa 16. Dal 10/08 il CSS incassa la SCATOLA di
 * `8px − (scatola − 16) / 2` proprio perché sia il CERCHIO a fermarsi a
 * `ROW_PX`, allineato ai segnali quieti che copre. Misurare `.row-actions`
 * significa quindi leggere 2px col mouse e chiamarlo difetto: il rettangolo
 * giusto è quello del glifo, cioè lo `<span>` dentro il bottone di
 * `PendingActionRing`, che porta larghezza e altezza inline.
 */
function comandoDi(card: Locator): Locator {
  return card.locator(".row-actions button > span").first();
}

/** La riga della colonna per un topic, cioè la card che porta `.row-card`. */
function rigaDi(page: Page, nome: string): Locator {
  return page.locator(`[role="treeitem"][aria-label="${nome}"]`).first();
}

test.beforeEach(async ({ page, request }) => {
  // Lo store si semina con le pane che servono: chiedere una pane di chat È
  // dichiarare la topic aperta (vedi `resetPaneStore`), quindi le due righe
  // esistono già quando la pagina apre — niente corsa fra apertura e misura.
  await resetPaneStore(request, ids.slice());
  // E LA COLONNA TORNA ALLA VISTA BASE, perché due dei test qui sotto la
  // cambiano (vista «per stato», un fissato) e lo stato è SERVER-SIDE: senza
  // questo azzeramento il primo che scrive detta la scena a tutti quelli che
  // vengono dopo, in ordine di esecuzione — che è come CODA-4 è diventato rosso
  // pur non essendo stato toccato. Un test che dipende da chi ha girato prima
  // non sta misurando quello che dice di misurare.
  await request.put(`${BASE}/api/ui-state/sidebar-state`, {
    data: { viewMode: 'timeline', showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await goToApp(page);
});

test("CODA-1: il comando finisce a ROW_PX dal bordo della card, su riga E tab", async ({ page }) => {

  test.info().annotations.push({ type: "spec", description: "CHROME-05" });
  await openTopic(page, nomi[0]);

  const riga = rigaDi(page, nomi[0]);
  await expect(riga).toBeVisible();
  const tab = page.locator('[role="tab"][data-pane-id]').first();
  await expect(tab).toBeVisible();

  // Il comando esiste solo mentre il mouse è sopra la sua card: si misura una
  // superficie per volta, con il puntatore dove serve.
  const misure: { dove: string; scarto: number }[] = [];

  for (const [dove, card] of [["riga", riga], ["tab", tab]] as const) {
    await card.hover();
    const cmd = comandoDi(card);
    await expect(cmd).toBeVisible();
    const rc = await rett(card, `card ${dove}`);
    const rk = await rett(cmd, `comando ${dove}`);
    misure.push({ dove, scarto: (rc.x + rc.w) - (rk.x + rk.w) });
  }

  // Il messaggio porta i numeri: un `toBeCloseTo` che fallisce senza dire su
  // quale superficie costringe a rimisurare a mano.
  expect(
    misure.map((m) => `${m.dove}=${m.scarto.toFixed(2)}`).join(" "),
  ).toBeTruthy();
  for (const m of misure) {
    expect(Math.abs(m.scarto - ROW_PX), `${m.dove}: il comando finisce a ${m.scarto.toFixed(2)}px dal bordo, atteso ${ROW_PX}`).toBeLessThanOrEqual(EPS);
  }
  // …e le due superfici devono dire lo STESSO numero, non solo due numeri
  // ciascuno vicino al proprio atteso.
  expect(Math.abs(misure[0].scarto - misure[1].scarto)).toBeLessThanOrEqual(EPS);
});

test("CODA-2: il binario quieto non si sposta fra riposo e passaggio del mouse", async ({ page }) => {
  await openTopic(page, nomi[0]);
  const riga = rigaDi(page, nomi[0]);
  await expect(riga).toBeVisible();
  const trail = riga.locator(".row-trail").first();
  await expect(trail).toBeAttached();

  // A riposo: il puntatore va lontano dalla colonna, e si aspetta che il layout
  // si fermi prima di leggere (una transizione in corso dà misure a metà).
  await page.mouse.move(1200, 850);
  const prima = await settledRectangle(trail, "binario a riposo");

  await riga.hover();
  const dopo = await settledRectangle(trail, "binario in hover");

  expect(Math.abs(prima.x - dopo.x), `il binario si è spostato in x di ${(dopo.x - prima.x).toFixed(2)}px`).toBeLessThanOrEqual(EPS);
  expect(Math.abs(prima.w - dopo.w), `il binario ha cambiato larghezza di ${(dopo.w - prima.w).toFixed(2)}px`).toBeLessThanOrEqual(EPS);

  // E sbiadisce: è ciò che vuol dire «ci passa sopra nascondendo quelli sotto».
  const opacita = await trail.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(opacita)).toBeLessThan(0.5);
});

test("CODA-3: il comando è l'ULTIMO — nessun segnale gli sta a destra", async ({ page }) => {
  await openTopic(page, nomi[0]);
  const riga = rigaDi(page, nomi[0]);
  await riga.hover();
  const cmd = comandoDi(riga);
  await expect(cmd).toBeVisible();
  const rk = await rett(cmd, "comando");

  // Ogni figlio del binario quieto deve finire PRIMA del bordo destro del
  // comando. È la definizione operativa di «sempre a fine tab».
  const figli = riga.locator(".row-trail > *");
  const n = await figli.count();
  for (let i = 0; i < n; i++) {
    const f = figli.nth(i);
    if (!(await f.isVisible())) continue;
    const rf = await rett(f, `segnale ${i}`);
    expect(rf.x + rf.w, `il segnale ${i} sborda oltre il comando`).toBeLessThanOrEqual(rk.x + rk.w + EPS);
  }
});

/* L'ALTEZZA DELL'INTESTAZIONE DI SEZIONE NON SI MISURA QUI, ed è una rinuncia
 * dichiarata invece che un buco.
 *
 * Le intestazioni della colonna principale si disegnano solo in vista «per
 * stato» E solo quando almeno una chat è in attesa o al lavoro: con topic
 * appena creati cadono tutte in «il resto», e quel ramo rende una lista NUDA,
 * senza intestazioni (vedi il `soloIlResto` in TopicTree). Un test scritto qui
 * troverebbe zero elementi e passerebbe verde senza aver misurato niente —
 * cioè un'asserzione che non può fallire, che in questo repo è già costata una
 * suite verde su un difetto vivo.
 *
 * Fabbricare uno stato «in attesa» solo per far comparire un'intestazione
 * significherebbe provare la geometria attraverso tre sistemi che non c'entrano
 * (segnali, streaming, soglie di visto). Il numero è invece bloccato dove è
 * davvero verificabile: `selectionStyles.test.ts` ricalcola `SECTION_H` contro
 * `CARD_H` (stessa misura col mouse) e contro `ROW_H` (stessa col dito, i 44 di
 * iOS), e controlla che `SECTION_CARD` la monti. */

test("CODA-6: una tessera fissata è alta ESATTAMENTE quanto una riga", async ({ page, request }) => {
  // Due pixel fra card impilate nella stessa colonna — 36 contro 34 — che
  // venivano da un'invariante tutta della tessera. Si semina un fissato, o non
  // c'è niente da misurare.
  await request.put(`${BASE}/api/ui-state/sidebar-state`, {
    data: { viewMode: 'timeline', showArchived: false, expandedNodes: [], pinnedItems: [ids[1]], pinnedLayout: [] },
  });
  await goToApp(page);

  const tessera = page.locator('[data-testid="sidebar-pinned-section"] [role="treeitem"]').first();
  await expect(tessera, 'nessuna tessera fissata: il seme non ha preso').toBeVisible({ timeout: 15000 });
  const riga = rigaDi(page, nomi[0]);
  await expect(riga).toBeVisible();

  await page.mouse.move(1200, 850);
  const rt = await settledRectangle(tessera, 'tessera fissata');
  const rr = await settledRectangle(riga, 'riga');
  expect(Math.abs(rt.h - rr.h), `tessera ${rt.h.toFixed(1)}px contro riga ${rr.h.toFixed(1)}px`).toBeLessThanOrEqual(EPS);
});

test("CODA-4: fra due card adiacenti della colonna passa COLUMN_GAP", async ({ page }) => {
  await openTopic(page, nomi[0]);
  await openTopic(page, nomi[1]);

  const a = rigaDi(page, nomi[0]);
  const b = rigaDi(page, nomi[1]);
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();

  // Il puntatore fuori: una riga in hover cambia solo il fondo, ma un test
  // geometrico si misura a layout FERMO.
  await page.mouse.move(1200, 850);

  const ra = await settledRectangle(a, "prima riga");
  const rb = await settledRectangle(b, "seconda riga");
  const [sopra, sotto] = ra.y <= rb.y ? [ra, rb] : [rb, ra];
  const varco = sotto.y - (sopra.y + sopra.h);
  expect(Math.abs(varco - COLUMN_GAP), `fra le due card passano ${varco.toFixed(2)}px, attesi ${COLUMN_GAP}`).toBeLessThanOrEqual(EPS);
});
