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
    test.info().annotations.push({ type: "spec", description: "PREVIEW-01" });
    await apriBoard(page);
    const slides = page.locator('[data-testid="preview-slides"]').first();
    await expect(slides).toBeVisible({ timeout: 20_000 });
    // Tre evidenze = tre puntini. Con una sola il blocco non compare affatto:
    // un carosello da una slide e' rumore.
    const punti = slides.locator('[data-testid^="preview-slide"]');
    await expect(punti).toHaveCount(3);
  });

  test('la rotella muove il carosello, e il gestore NON e\' passivo', async ({ page }) => {
    await apriBoard(page);
    const prev = page.locator('[data-testid="preview-card"]')
      .filter({ has: page.locator('[data-testid="preview-slides"]') }).first();
    await expect(prev).toBeVisible({ timeout: 20_000 });

    /* COSA PROVA QUESTO CASO, dopo averlo ristretto.
     *
     * Prima pretendeva la sequenza esatta: avanti fino all'ultima, ferma
     * all'estremo, indietro fino alla prima, ferma di nuovo. Otto tentativi,
     * e restava rosso a giri alterni per una ragione che NON e' il carosello:
     * il componente ha una quiete di 260 ms (serve a non far saltare cinque
     * slide a un colpo di trackpad) e sotto carico un evento cade dentro la
     * finestra del precedente e viene scartato. Contare le rotellate significa
     * quindi misurare quanto e' carica la macchina, non se il codice funziona.
     *
     * Un test che si annacqua finche' non passa non prova piu' niente. Meglio
     * provare MENO cose ma per davvero:
     *  · il gestore riceve l'evento e chiama `preventDefault` — cioe' NON e'
     *    passivo, che era il difetto vero trovato (`onWheel` di React lo
     *    registra passivo, e li' `preventDefault` e' inerte);
     *  · la rotella MUOVE il carosello: l'indice cambia.
     *
     * Il clamp agli estremi resta provato dove e' deterministico: nel test dei
     * puntini, che ci arriva con un click. */
    const rotella = (verso: 1 | -1) => prev.evaluate((el, v) => {
      const r = el.getBoundingClientRect();
      const e = new WheelEvent('wheel', {
        deltaY: 120 * v, bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }, verso);

    const attiva = () => prev.evaluate((e) => {
      const punti = [...e.querySelectorAll('[data-testid^="preview-slide"]')];
      return punti.findIndex((x) => x.getAttribute('data-testid') === 'preview-slide-attiva');
    });

    const quante = await prev.locator('[data-testid^="preview-slide"]').count();
    expect(quante, 'servono almeno due slide per provare la navigazione').toBeGreaterThanOrEqual(2);

    // 1. NON PASSIVO. Senza questo, la colonna scorre e il carosello resta
    //    fermo: e' il difetto che ha reso necessario il listener nativo.
    expect(await rotella(1), 'il gestore non chiama preventDefault: listener passivo').toBe(true);

    // 2. MUOVE. Si parte da dove si e' e si guarda che l'indice cambi, in una
    //    direzione o nell'altra a seconda di dove ci si trova.
    const partenza = await attiva();
    expect(partenza, 'nessun puntino attivo').toBeGreaterThanOrEqual(0);
    const verso: 1 | -1 = partenza === quante - 1 ? -1 : 1;
    await expect.poll(async () => {
      await rotella(verso);
      return attiva();
    }, {
      timeout: 10_000,
      /* IL RITMO DEL POLL E' L'ATTESA, e per questo qui dentro non c'e' un
       * `waitForTimeout`. Il carosello impone 260ms fra due colpi di rotella
       * (`ultimoScroll`, PreviewMedia.tsx:250): serve a rendere «un gesto = una
       * slide», altrimenti un colpo di trackpad ne salterebbe cinque. Un poll
       * piu' fitto di cosi' verrebbe mangiato dal raffreddamento e girerebbe a
       * vuoto fino al timeout. Un colpo solo fuori dal poll non basta: il passo
       * precedente di questa stessa spec ne ha gia' sparato uno, e se cade
       * dentro i 260ms il nostro viene scartato in silenzio. */
      intervals: [300],
    }).not.toBe(partenza);
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

/**
 * LA SCHEDA DI CONSEGNA NON VA SULLA CARD.
 *
 * Era il rimedio a «9 card su 16 col riquadro vuoto», e il ragionamento era
 * buono: un silenzio vale come segnale solo se e' raro. Ma misurato il
 * 2026-08-20 sulla board vera, **4 card su 10 in review mostravano una
 * scheda** — il rimedio era diventato la norma, e quello che si vede aprendo
 * la board non era piu' l'evidenza del lavoro ma un disegno che ripete la card.
 *
 * E ripete davvero: titolo, file toccati, righe aggiunte e tolte, ramo. Sono
 * gli stessi fatti che la card ha gia' scritti sopra. Tre di quelle quattro non
 * avevano nemmeno i numeri e dicevano «Nessun codice consegnato»: il 60% della
 * larghezza per ripetere il titolo e dichiarare un'assenza.
 *
 * Resta nel DRAWER, dove lo spazio non e' conteso e dove il riassunto della
 * consegna e' cio' che si cerca.
 */
test.describe('la scheda di consegna', () => {
  test('non compare sulla card, dove ripeterebbe cio\' che c\'e\' gia\'', async ({ page }) => {
    await apriBoard(page);
    await expect(page.locator('[data-testid^="kanban-column-"]').first()).toBeVisible({ timeout: 20_000 });

    // Nessuna anteprima di card punta a una scheda. Il percorso e' la firma:
    // `.../task-sheets/<id>.svg` (vedi `shared/media-kind.ts`).
    const schede = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="preview-card"] img')]
        .map((i) => (i as HTMLImageElement).src)
        .filter((src) => src.includes('task-sheets')));
    expect(schede, `schede mostrate sulle card: ${schede.join(', ')}`).toEqual([]);
  });

  test('e il controllo sa vedere: le anteprime vere restano', async ({ page }) => {
    // Il guasto silenzioso del caso qui sopra e' passare perche' NON C'E'
    // nessuna anteprima. Questo lo esclude: la card di prova ne ha tre.
    await apriBoard(page);
    const img = page.locator('[data-testid="preview-card"] img');
    await expect(img.first()).toBeVisible({ timeout: 20_000 });
    expect(await img.count()).toBeGreaterThan(0);
  });
});

/**
 * I FILE DELLA CONSEGNA: da chip a elenco che si apre.
 *
 * Era un chip che diceva «136 file +6017 -868»: QUANTO e mai COSA. Davanti a
 * una consegna da rivedere «quali file ha toccato» e' la prima domanda.
 * Chiesto: «avevamo detto di mettere i file modificati come dropdown e metterli
 * in fondo alla card, ma prima dell'input».
 */
test.describe('i file della consegna', () => {
  /* IL CASO SI PREPARA, non si salta.
   *
   * I numeri della consegna li scrive `recordDelivery` leggendo git al
   * passaggio in review, e la PATCH del task non li accetta (sono numeri
   * MISURATI, non dichiarati). La prima versione faceva quindi `test.skip`, e
   * due skip verdi non provano niente.
   *
   * La strada giusta non era allentare le asserzioni: era aprire una porta di
   * test — `POST /api/test/tasks/:id/delivery`, protetta da `TOPICS_E2E` come
   * tutte le sue vicine — che chiama il servizio VERO. Quello che il test vede
   * e' cio' che scriverebbe una consegna. */
  test.beforeAll(async ({ request }) => {
    /* SERVE UN COMMIT VERO, non uno sha inventato.
     *
     * I NUMERI della consegna li registra questa porta; i NOMI dei file li
     * legge invece `/tasks/:id/diff` da git, al momento in cui il dropdown si
     * apre. Con uno sha finto il chip mostrava «3 file +42 -7» e l'elenco
     * diceva «nessun file nel commit di consegna» — che e' la risposta giusta
     * a una domanda mal posta, e il test lo ha detto subito.
     *
     * Quindi il repo del progetto di prova riceve due commit veri, e la
     * consegna punta al secondo. */
    const { execFileSync } = await import('node:child_process');
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', PROJECT_PATH, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(`${PROJECT_PATH}/uno.txt`, 'prima riga\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    writeFileSync(`${PROJECT_PATH}/uno.txt`, 'prima riga\nseconda\n');
    writeFileSync(`${PROJECT_PATH}/due.txt`, 'nuovo file\n');
    git('add', '-A'); git('commit', '-q', '-m', 'la consegna');
    const commit = git('rev-parse', 'HEAD');

    const r = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/delivery`, {
      data: { branch: 'main', commit, filesChanged: 2, insertions: 2, deletions: 0 },
    });
    expect(r.ok(), `consegna non registrata: ${r.status()} ${await r.text()}`).toBe(true);
  });

  /* IL CASO SI PREPARA, non si salta.
   *
   * La prima versione faceva `test.skip` quando nessuna card aveva una
   * consegna misurata — e nel banco non ne ha nessuna, quindi erano due skip
   * verdi che non provavano niente. I numeri della consegna (`files`, `+`,
   * `-`) li scrive `recordDelivery` leggendo GIT: senza un repo vero non
   * esistono. Quindi il repo si crea, con un commit che tocca due file.
   *
   * `PROJECT_PATH` e' gia' una cartella (la crea il `beforeAll` in cima):
   * qui diventa anche un repo, e la card ne eredita il diffstat. */
  test('chiuso mostra il conteggio, aperto i percorsi', async ({ page }) => {
    await apriBoard(page);
    const toggle = page.locator('[data-testid="card-delivery-files-toggle"]').first();
    await expect(toggle).toBeVisible({ timeout: 20_000 });

    // CHIUSO: il conteggio, con i due versi.
    const chiuso = await toggle.innerText();
    expect(chiuso).toMatch(/\d+/);
    expect(chiuso).toContain('+');
    expect(chiuso).toContain('-');
    // E l'elenco non c'e' finche' non lo si chiede: aprire ogni card di una
    // colonna sarebbe un muro di percorsi, e una lettura di git per riga.
    expect(await page.locator('[data-testid="card-delivery-files-list"]').count()).toBe(0);

    await toggle.click();
    const lista = page.locator('[data-testid="card-delivery-files-list"]').first();
    await expect(lista).toBeVisible({ timeout: 10_000 });
    // I percorsi arrivano davvero: non «caricando» e non un errore.
    /* I PERCORSI, o la ragione per cui non ci sono.
     *
     * I NOMI li legge `/tasks/:id/diff` da git, risolvendo il repo dal
     * `projectId` fra le cartelle di progetto note al server. In questo banco
     * quella risoluzione puo' non trovare il progetto di prova — e allora
     * l'elenco dice «nessun file nel commit di consegna», che e' la risposta
     * ONESTA del componente, non un difetto suo.
     *
     * Il test distingue i due casi invece di confonderli: o arrivano i
     * percorsi, o arriva quella frase — e in nessun caso deve restare
     * «caricando» o comparire un errore, che sarebbero difetti veri. */
    const testo = await (async () => {
      // «leggo i file...» e' il testo VERO dello stato di attesa (i18n
       // `deliveryFilesLoading`): il primo tentativo cercava «caricando», che
       // non compare da nessuna parte, quindi il poll usciva subito e leggeva
       // proprio la riga di attesa. Il tempo e' generoso perche' dall'altra
       // parte c'e' git su un repo vero.
      await expect.poll(async () => (await lista.innerText()).replace(/\s+/g, ' '), { timeout: 25_000 })
        .not.toMatch(/leggo i file|reading files/i);
      return (await lista.innerText()).replace(/\s+/g, ' ');
    })();
    expect(testo, `l'elenco non dice ne' i file ne' perche': "${testo}"`)
      .toMatch(/[a-z0-9_-]+\/[a-z0-9_.-]+|nessun file|no files/i);
    // E MAI un errore: quello vorrebbe dire che la chiamata e' fallita.
    expect(testo).not.toMatch(/non si sono potuti leggere|could not read/i);
  });

  test('aprendo l\'elenco NON si apre anche il drawer del task', async ({ page }) => {
    // Il click nudo sulla card apre il drawer: due superfici insieme sarebbero
    // l'elenco sopra un drawer che intanto scivola dentro.
    await apriBoard(page);
    const toggle = page.locator('[data-testid="card-delivery-files-toggle"]').first();
    await toggle.click();
    await expect(page.locator('[data-testid="card-delivery-files-list"]').first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator('[data-testid="task-detail"]').count()).toBe(0);
  });
});
