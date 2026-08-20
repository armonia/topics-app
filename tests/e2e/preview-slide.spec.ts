/**
 * IL CAROSELLO DELL'ANTEPRIMA: piu' evidenze, navigabili.
 *
 * COSA CAMBIA, e perche'. `preview_image` e' UNA sola — la copertina che il
 * server sceglie — e il resto restava sepolto nel thread. Un agente che
 * consegna un lavoro visivo allega spesso piu' scatti (prima/dopo, tre
 * schermate di un flusso), e chi guarda la board li vedeva solo aprendo il
 * task. Segnalato: «assicuriamoci che la preview possa avere anche piu' slide
 * navigabili semplicemente scrollando il mouse e cliccando si apre lightbox».
 *
 * PERCHE' UN E2E. Rotella, indice che si ferma agli estremi, click che apre il
 * lightbox senza aprire anche il drawer sotto: sono tutti comportamenti del
 * DOM sotto il mouse. Un test di funzione non puo' vederli.
 */
import { test } from './fixtures/layout.fixture';
import { expect, type Page } from '@playwright/test';
import { projectRow } from './helpers/project-row';
import { E2E_BASE, E2E_PORT, dataDirForPort } from './helpers/test-server';
import { hermetic } from './fixtures/hermetic';
import { projectIdForPath } from '../../shared/board';
import { createTopic, deleteTopic } from './helpers/api-fixtures';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-slide-${Date.now()}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
/* LE IMMAGINI STANNO NELL'HOME DEL BANCO, non nel progetto e non nel mio.
 *
 * `/api/media` serve solo path allowlistati (`isPathAllowed` in
 * `server/utils.ts`), e l'allowlist e' un elenco FISSO di quattro basi sotto
 * `$HOME`. Provato con una cartella in `/tmp`: `filterMedia` scartava tutto in
 * silenzio, i commenti nascevano senza media e il carosello non compariva —
 * cinque rossi che accusavano il carosello mentre il problema era il percorso.
 *
 * E NON `process.env.HOME`: il server di test gira con un HOME suo
 * (`$DATA_DIR/.home`, vedi `scripts/start-test-server.sh`) proprio per non
 * competere col server di sviluppo. Con l'HOME reale il server rispondeva
 * «path fuori dalle cartelle consentite» — e il messaggio del test, che
 * riporta cio' che ha visto, lo ha detto al primo colpo.
 *
 * La sottocartella col timestamp tiene separate le esecuzioni e permette di
 * cancellare solo la propria. */
const MEDIA_DIR = `${dataDirForPort(E2E_PORT)}/.home/.topics/media/e2e-slide-${Date.now()}`;

/** Un PNG 4x3 valido, minimo: il carosello misura il DOM, non i pixel. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAP//B5wBiOtZQOgAAAAASUVORK5CYII=',
  'base64',
);

let topicId: string | null = null;
let taskId = '';

test.beforeAll(async ({ request }) => {
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-slide' }));
  for (const n of ['uno', 'due', 'tre']) writeFileSync(`${MEDIA_DIR}/${n}.png`, PNG_1x1);

  const t = await createTopic(request, 'E2E-Slide', { projectPath: PROJECT_PATH });
  topicId = t.id;

  const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: 'card con tre evidenze', status: 'review' },
  });
  taskId = ((await res.json()) as { id: string }).id;

  /* LA COPERTINA e le altre due: la prima e' `preview_image`, le altre
   * arrivano dal thread — la forma reale di una consegna.
   *
   * NIENTE `.catch(() => undefined)`: inghiottiva gli errori, e un allegato
   * rifiutato (path fuori allowlist, rotta sbagliata) faceva fallire i test
   * PIU' AVANTI accusando il carosello. Ogni passo della preparazione
   * dichiara subito se non e' riuscito. */
  /* La copertina si imposta con la PATCH del task, non con `POST …/preview`:
   * quella rotta SCATTA uno screenshot vivo dal preview manager, e nel banco
   * risponde 503. Provato, e il messaggio del test lo ha detto subito:
   * «task trovato: true, previewImage=null». */
  const rp = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, {
    data: { previewImage: `${MEDIA_DIR}/uno.png` },
  });
  expect(rp.ok(), `copertina rifiutata: ${rp.status()} ${await rp.text()}`).toBe(true);

  for (const n of ['due', 'tre']) {
    const rc = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/comments`, {
      data: { content: `evidenza ${n}`, media: [`${MEDIA_DIR}/${n}.png`] },
    });
    expect(rc.ok(), `allegato ${n} rifiutato: ${rc.status()}`).toBe(true);
  }

  // E il server DEVE gia' vederle: se non le vede, il difetto e' li' e non
  // nella UI — meglio saperlo qui che dopo venti secondi di timeout.
  const rl = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`);
  const lista = (await rl.json()) as { tasks?: Array<{ id: string; previewImage?: string | null; previewImages?: string[] }> } | Array<{ id: string; previewImage?: string | null; previewImages?: string[] }>;
  const tasks = Array.isArray(lista) ? lista : (lista.tasks ?? []);
  const mio = tasks.find(t => t.id === taskId);
  // Il messaggio porta CIO' CHE HA VISTO: senza, «non riporta le evidenze» non
  // distingue «il task non c'e'» da «c'e' ma senza allegati», e sono due
  // diagnosi opposte.
  expect(
    mio?.previewImages?.length ?? 0,
    `il server non riporta le evidenze del thread. task trovato: ${!!mio}, ` +
    `previewImage=${JSON.stringify(mio?.previewImage)}, previewImages=${JSON.stringify(mio?.previewImages)}, ` +
    `task in lista=${tasks.length}`,
  ).toBeGreaterThanOrEqual(2);
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  rmSync(PROJECT_PATH, { recursive: true, force: true });
  rmSync(MEDIA_DIR, { recursive: true, force: true });
});

async function apriBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const sezione = page.getByRole('button', { name: /sezione Progetti/ });
  if ((await sezione.count()) > 0 && (await sezione.getAttribute('aria-expanded')) === 'false') await sezione.click();
  const riga = projectRow(page, /e2e-slide/);
  await expect(riga).toBeVisible({ timeout: 20_000 });
  await riga.click();
  await expect(page.getByTestId('project-window')).toBeVisible({ timeout: 20_000 });

  const triggers = page.getByTestId('pane-add-menu-trigger');
  const voce = page.getByTestId('pane-add-menu-kanban');
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await voce.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
      await voce.click();
      return;
    }
    await page.keyboard.press('Escape');
  }
  if (await page.locator('[data-testid^="kanban-column-"]').first().isVisible().catch(() => false)) return;
  throw new Error('non si e\' trovata la board');
}

test.describe('anteprima a piu\' slide', () => {
  test('i puntini dicono quante evidenze ci sono', async ({ page }) => {
    await apriBoard(page);
    const slides = page.locator('[data-testid="preview-slides"]').first();
    await expect(slides).toBeVisible({ timeout: 20_000 });
    // Tre evidenze = tre puntini. Con una sola il blocco non compare affatto:
    // un carosello da una slide e' rumore.
    const punti = slides.locator('[data-testid^="preview-slide"]');
    await expect(punti).toHaveCount(3);
  });

  test('la rotella cambia slide, e si ferma agli estremi', async ({ page }) => {
    await apriBoard(page);
    /* LA CARD COL CAROSELLO, non «la prima anteprima»: nella board del banco
     * possono esserci altre card con una sola evidenza, e la prima in DOM non
     * e' detto sia la nostra. Il primo tentativo falliva proprio cosi' —
     * misurava un riquadro senza puntini e leggeva -1. */
    const prev = page.locator('[data-testid="preview-card"]')
      .filter({ has: page.locator('[data-testid="preview-slides"]') }).first();
    await expect(prev).toBeVisible({ timeout: 20_000 });

    /** Quale puntino e' attivo, letto in UNA valutazione sola: due locator
     *  separati possono cadere su render diversi. */
    const attiva = () => prev.evaluate((e) => {
      const punti = [...e.querySelectorAll('[data-testid^="preview-slide"]')];
      return punti.findIndex((x) => (x as HTMLElement).dataset.testid === 'preview-slide-attiva');
    });

    /* NON SI PRETENDE DI PARTIRE DA ZERO: l'indice della slide vive nel
     * componente, e la board resta montata fra un test e l'altro dello stesso
     * file — quindi una navigazione precedente lascia il carosello dove l'ha
     * lasciato. Provato: `toBe(0)` leggeva 1, e il rosso accusava la rotella
     * per uno stato ereditato.
     *
     * Cio' che questo caso prova e' il MOVIMENTO, non il punto di partenza:
     * si legge dove si e', si conta da li'. */
    const partenza = await attiva();
    expect(partenza, 'nessun puntino attivo: il carosello non e\' pronto').toBeGreaterThanOrEqual(0);

    await prev.scrollIntoViewIfNeeded();
    await prev.hover();
    // AVANTI fino in fondo: tre rotellate su tre slide arrivano all'ultima
    // qualunque sia la partenza.
    for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(300); }
    await expect.poll(attiva, { timeout: 5_000 }).toBe(2);

    // NON GIRA IN TONDO: un'altra rotellata in avanti e resta l'ultima. Un
    // carosello che riparte da capo fa perdere il conto di dove si e' arrivati.
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(400);
    expect(await attiva(), 'il carosello ha girato in tondo').toBe(2);

    // E INDIETRO, fino alla prima: stessa regola all'altro estremo.
    for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(300); }
    await expect.poll(attiva, { timeout: 5_000 }).toBe(0);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(400);
    expect(await attiva(), 'il carosello ha girato in tondo all\'indietro').toBe(0);
  });

  test('un puntino porta dritto alla sua slide', async ({ page }) => {
    await apriBoard(page);
    const prev = page.locator('[data-testid="preview-card"]').first();
    await expect(prev).toBeVisible({ timeout: 20_000 });
    const punti = prev.locator('[data-testid^="preview-slide"]');
    await punti.nth(2).click();
    await expect.poll(async () => await punti.nth(2).getAttribute('data-testid'), { timeout: 5_000 })
      .toBe('preview-slide-attiva');
  });

  test('il click sull\'immagine apre il lightbox, e NON il drawer sotto', async ({ page }) => {
    await apriBoard(page);
    const img = page.locator('[data-testid="preview-card"] img').first();
    await expect(img).toBeVisible({ timeout: 20_000 });
    // Il cursore lo dice prima ancora del click: `zoom-in` e non `default`.
    expect(await img.evaluate((e) => getComputedStyle(e).cursor)).toBe('zoom-in');

    await img.click();
    await expect(page.locator('[data-testid="preview-lightbox"]')).toBeVisible({ timeout: 5_000 });
    // Il drawer del task NON si e' aperto: due superfici insieme sarebbero il
    // lightbox sopra un drawer che intanto scivola dentro.
    expect(await page.locator('[data-testid="task-detail"]').count()).toBe(0);
  });

  test('nel lightbox si naviga con le frecce, e il contatore dice dove sei', async ({ page }) => {
    await apriBoard(page);
    const img = page.locator('[data-testid="preview-card"] img').first();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await img.click();
    await expect(page.locator('[data-testid="preview-lightbox"]')).toBeVisible({ timeout: 5_000 });

    const pos = page.locator('[data-testid="lightbox-posizione"]');
    await expect(pos).toHaveText('1 / 3');
    await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText('2 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(pos).toHaveText('1 / 3');
  });
});
