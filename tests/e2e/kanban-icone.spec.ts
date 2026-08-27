/**
 * QUANTO DISEGNO STA IN UN'ICONA PICCOLA, misurato invece che giudicato a occhio.
 *
 * IL DIFETTO CHE HA PRODOTTO QUESTA REGOLA. La card della kanban mostrava
 * «Spostata a mano» con l'icona `hand` a 12px, ed e' stata segnalata come
 * «sgranata». Il primo sospetto — il tratto troppo sottile — era sbagliato, e
 * la misura lo ha escluso: `stroke-width: 2` in un viewBox 24 reso a 12px fa
 * scala 0,5, cioe' 1px CSS, che su un display a dpr 2 sono 2 pixel FISICI
 * pieni. Nitido.
 *
 * Il problema era la DENSITA'. Misurata la lunghezza totale del tratto di ogni
 * icona della card (`getTotalLength` sommato su tutti i path: quanto disegno
 * c'e' davvero, non quante forme):
 *
 *     hand                45,7 px di linea in 12 px di lato
 *     move                37,0
 *     arrow-right-left    27,3
 *     user-round          12,6
 *
 * Cinque dita in dodici pixel non ci stanno: i tratti si toccano e l'occhio
 * legge una macchia. Nessuno spessore diverso lo ripara.
 *
 * PERCHE' UN CANCELLO E NON SOLO IL FIX. Sostituire `hand` chiude il caso di
 * oggi; la prossima icona densa entrerebbe allo stesso modo, perche' nessuno
 * misura `getTotalLength` prima di scegliere un glifo. Il difetto si vede solo
 * su uno schermo, di sfuggita, e viene segnalato settimane dopo.
 *
 * SI PREPARA I PROPRI DATI. La prima versione apriva la board se c'era e
 * `test.skip` altrimenti: nel banco di test non c'e', quindi il file era due
 * skip verdi che non provavano niente. Qui il progetto, la board e le card
 * vengono creati, cosi' le icone misurate sono quelle vere.
 *
 * LA SOGLIA E' RICAVATA, NON SCELTA: 40px di linea per 12px di lato. Sta sopra
 * ogni icona che oggi si legge e sotto quella segnalata. Se un giorno una sotto
 * soglia risultasse illeggibile, la soglia scende con la misura di quel caso.
 */
import { test } from './fixtures/layout.fixture';
import { expect, type Page } from '@playwright/test';
import { projectRow } from './helpers/project-row';
import { E2E_BASE } from './helpers/test-server';
import { hermetic } from './fixtures/hermetic';
import { projectIdForPath } from '../../shared/board';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createTopic, deleteTopic } from './helpers/api-fixtures';

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-icone-${Date.now()}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

/** Linea totale ammessa per ogni pixel di lato. `hand` faceva 3,8. */
const LINEA_PER_PX = 40 / 12;

let topicId: string | null = null;

test.beforeAll(async ({ request }) => {
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-icone' }, null, 2));
  // Un progetto NASCE da un topic che lo nomina: non esiste un endpoint che lo
  // crei da solo. Provato: `POST /api/projects` non esiste, e la riga nella
  // sidebar non compariva mai.
  const t = await createTopic(request, 'E2E-Icone', { projectPath: PROJECT_PATH });
  topicId = t.id;
  // Card in stati diversi: ogni stato accende chip diversi, e sono i chip a
  // portare le icone. Una card sola misurerebbe due glifi.
  for (const [text, status] of [
    ['card in backlog', 'backlog'],
    ['card in corso', 'in_progress'],
    ['card in review', 'review'],
  ] as const) {
    await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status } }).catch(() => undefined);
  }
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  rmSync(PROJECT_PATH, { recursive: true, force: true });
});

/** Apre la board del progetto di prova dal menu «+» della sua finestra. */
async function apriBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const sezione = page.getByRole('button', { name: /sezione Progetti/ });
  if ((await sezione.count()) > 0 && (await sezione.getAttribute('aria-expanded')) === 'false') await sezione.click();
  const riga = projectRow(page, /e2e-icone/);
  await expect(riga).toBeVisible({ timeout: 20_000 });
  await riga.click();
  await expect(page.getByTestId('project-window')).toBeVisible({ timeout: 20_000 });

  // Solo il menu «+» della finestra di progetto elenca la voce Board: si
  // provano i trigger visibili dal piu' recente, chiudendo quelli sbagliati.
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
  // NESSUN MENU CON LA VOCE BOARD: quasi sempre perche' la board E' GIA'
  // APERTA — il menu «+» non offre di aprire due volte la stessa pane
  // singleton. Il secondo test di questo file falliva proprio cosi': la board
  // lasciata aperta dal primo. Se e' li', il lavoro e' fatto.
  if (await page.locator('[data-testid^="kanban-column-"]').first().isVisible().catch(() => false)) return;
  throw new Error('non si e\' trovato il menu «+» con la voce Board, e nessuna board risulta aperta');
}

/** Le icone rese nelle card, con quanta linea stipano per pixel di lato. */
async function densityIcons(page: Page) {
  return page.evaluate(() => {
    const out: { icona: string; lato: number; linea: number; rapporto: number }[] = [];
    const viste = new Set<string>();
    for (const svg of document.querySelectorAll('[data-testid^="card-"] svg')) {
      const nome = (svg.getAttribute('class') || '').match(/lucide-([a-z0-9-]+)/)?.[1] ?? '?';
      if (viste.has(nome)) continue;
      viste.add(nome);
      const lato = svg.getBoundingClientRect().width;
      if (lato === 0) continue; // non visibile: non e' una domanda di leggibilita'
      let linea = 0;
      for (const p of svg.querySelectorAll('path,line,polyline,circle,rect')) {
        const el = p as unknown as SVGGeometryElement;
        if (typeof el.getTotalLength === 'function') linea += el.getTotalLength();
      }
      // La lunghezza sta nel sistema del viewBox: si riporta ai px resi.
      const vb = (svg.getAttribute('viewBox') || '0 0 24 24').split(/\s+/).map(Number);
      const scala = lato / (vb[2] || 24);
      const lineaResa = linea * scala;
      out.push({ icona: nome, lato: +lato.toFixed(1), linea: +lineaResa.toFixed(1), rapporto: +(lineaResa / lato).toFixed(2) });
    }
    return out;
  });
}

test.describe('le icone piccole della kanban restano leggibili', () => {
  test('nessuna icona stipa piu\' disegno di quanto il suo lato regga', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-48" });
    await apriBoard(page);
    await expect(page.locator('[data-testid^="card-"]').first()).toBeVisible({ timeout: 20_000 });

    const tutte = await densityIcons(page);
    /* IL CONTROLLO CHE IL CONTROLLO VEDA: misurare zero icone e passare e' il
     * guasto silenzioso di una regola come questa.
     *
     * La soglia e' DUE e non piu': misurato su card appena create, i glifi
     * distinti sono esattamente due (il tipo della card e il menu). I chip di
     * stato — checks, consegna, attesa — nascono dal lavoro di un agente, che
     * qui non gira. Chiedere di piu' vorrebbe dire montare mezzo dispatcher
     * per provare una regola sul DISEGNO, e il test misurerebbe altro. */
    expect(tutte.length, 'nessuna icona misurata: il controllo non sta guardando niente').toBeGreaterThanOrEqual(2);

    const dense = tutte.filter(d => d.rapporto > LINEA_PER_PX);
    expect(
      dense,
      `Icone troppo dense per la loro dimensione (limite ${LINEA_PER_PX.toFixed(2)} px di linea per px di lato):\n` +
      dense.map(d => `  ${d.icona}: ${d.linea}px di linea in ${d.lato}px → ${d.rapporto}`).join('\n') +
      '\nScegli un glifo piu\' semplice, o rendilo piu\' grande.',
    ).toEqual([]);
  });

  test('la misura e\' viva: legge il disegno, non una costante', async ({ page }) => {
    /* Senza questo, «nessuna icona sopra soglia» potrebbe voler dire che la
     * misura torna sempre zero — un controllo verde che non guarda niente.
     *
     * NON confronta piu' due icone fra loro: provato, e' instabile. Card
     * appena create mostrano pochi glifi e capita che i due presenti abbiano
     * lo stesso rapporto, quindi «il massimo supera il minimo» falliva per un
     * pareggio invece che per un difetto. La domanda vera e' un'altra: il
     * numero e' PLAUSIBILE? Un rapporto positivo e sotto una decina significa
     * che `getTotalLength` ha risposto e la scala del viewBox e' stata
     * applicata. Zero o infinito vorrebbero dire che la misura e' rotta. */
    await apriBoard(page);
    await expect(page.locator('[data-testid^="card-"]').first()).toBeVisible({ timeout: 20_000 });
    const tutte = await densityIcons(page);
    expect(tutte.length).toBeGreaterThanOrEqual(2);
    for (const d of tutte) {
      expect(d.lato, `${d.icona}: lato zero, non e\' stata misurata`).toBeGreaterThan(0);
      expect(d.linea, `${d.icona}: nessuna linea letta, getTotalLength non ha risposto`).toBeGreaterThan(0);
      expect(d.rapporto, `${d.icona}: rapporto fuori scala (${d.rapporto})`).toBeLessThan(10);
    }
  });
});
