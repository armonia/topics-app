/**
 * @covers RES-ATTR-11
 */
import { test, expect } from '@playwright/test';
import { tooltipText } from './helpers/tooltip';
import { hermetic } from './fixtures/hermetic';
import { createTopic } from './helpers/api-fixtures';

/**
 * L'INVENTARIO DEL PESO, SUL PERCORSO CHE L'UTENTE PERCORRE DAVVERO.
 *
 * PERCHE' ESISTE. `featureWeight.test.ts` prova il registro, `featureUsage` la
 * trasformazione e `featureWeightText` le stringhe. Sono tre funzioni giuste —
 * e tre funzioni giuste dietro un pannello che non le monta, o dietro una
 * chiave i18n che non risolve, sono indistinguibili da niente. Questo file
 * esercita la catena intera: aprire, guardare, leggere.
 *
 * COME FA A VEDERE DEI NUMERI. Le voci MISURATE vengono dalla flotta, cioe' da
 * `/api/system/status`: qui la risposta viene intercettata con numeri veri
 * (quelli letti sull'app viva il 2026-08-20) invece di sperare che la macchina
 * di test abbia dei terminali aperti. Le voci TRATTENUTE non hanno bisogno di
 * niente: nascono dallo stato che l'app ha davvero, che nel test e' poco ma non
 * e' zero.
 */
hermetic(test);

/**
 * La risposta di stato con una flotta dentro, misurata sull'app viva il
 * 2026-08-20.
 *
 * RISPONDE DA SOLA, senza `route.fetch()` verso il server di test. Il primo
 * tentativo inoltrava e poi fondeva la flotta nella risposta vera: leggibile,
 * ma la richiesta reale a volte arrivava DOPO che il test era finito
 * («Target page closed»), e la barra — che ricampiona ogni 60 s — restava per
 * sempre col primo campione senza flotta. Un payload completo e sincrono
 * toglie la corsa: quello che si prova qui e' l'inventario, non la capacita'
 * del server di test di rispondere in fretta.
 */
async function conFlotta(page: import('@playwright/test').Page, fleet?: unknown) {
  await page.route('**/api/system/status', async (route) => {
    await route.fulfill({
      json: {
        timestamp: new Date().toISOString(),
        gateway: { online: true, status: 'online', latencyMs: 3, lastCheckedAt: new Date().toISOString() },
        server: {
          uptimeMs: 3_600_000, startedAt: new Date().toISOString(),
          memoryMB: 372, heapUsedMB: 52, heapTotalMB: 80,
          fleet: fleet === undefined ? {
            processCount: 3, memoryMB: 461, cpuPercent: 4, cpuCores: 12,
            memMetric: 'footprint',
            roots: [
              { kind: 'server', pid: 1, processCount: 1, memoryMB: 372, cpuPercent: 2 },
              { kind: 'pty-bridge', pid: 2, processCount: 1, memoryMB: 21, cpuPercent: 1 },
              { kind: 'ai-bridge', pid: 3, processCount: 1, memoryMB: 68, cpuPercent: 1 },
            ],
            sessions: [
              { sessionId: 's1', name: 'claude-uno', pid: 10, processCount: 3, memoryMB: 396, cpuPercent: 3 },
              { sessionId: 's2', name: 'claude-due', pid: 11, processCount: 2, memoryMB: 353, cpuPercent: 1 },
            ],
            scriptsMB: 91, scriptsProcessCount: 4,
            supported: true,
          } : fleet,
        },
        connections: { wsClients: 1, activeStreams: 0, streamKeys: [] },
        topics: { activeCount: 0, totalCount: 0 },
        cronJobs: { enabled: 0, disabled: 0, total: 0 },
        sessions: { total: 0, byType: {} },
      },
    });
  });
}

test.describe('inventario del peso per funzionalita', () => {
  test('il pannello dice COSA tiene il numero, non solo quanto', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="connection-status"]').click();

    const inventario = page.locator('[data-testid="perf-inventory"]');
    await expect(inventario).toBeVisible({ timeout: 10_000 });
    // ASPETTA IL CAMPIONE CON LA FLOTTA. Il pannello si monta sul primo
    // `/api/system/status`, che puo' arrivare prima che la rotta simulata sia
    // in piedi: l'inventario compare subito con le sole voci trattenute, e le
    // misurate entrano al giro dopo (3s di poll). Senza questa attesa il test
    // leggerebbe il pannello un istante troppo presto — e sarebbe rosso per
    // una ragione che non c'entra con cio' che prova.
    await expect.poll(async () => inventario.innerText(), { timeout: 15_000 })
      .toContain('Terminali e sessioni');
    const testo = await inventario.innerText();

    // LE VOCI MISURATE, con i nomi che l'utente riconosce — non `pty-bridge`.
    expect(testo).toContain('749 MB'); // 396 + 353, aggregate in UNA riga
    expect(testo).toContain('Ponte dei terminali');
    expect(testo).toContain('Comandi lanciati dagli agenti');

    // NESSUNA CHIAVE GREZZA: e' il difetto che una traduzione mancante produce,
    // invisibile a un test di funzione.
    expect(testo).not.toMatch(/\bperf\.[a-zA-Z.]+/);
  });

  test('le due nature restano distinte: conteggi e MB non si mescolano', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="connection-status"]').click();

    const inventario = page.locator('[data-testid="perf-inventory"]');
    await expect(inventario).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => inventario.innerText(), { timeout: 15_000 })
      .toContain('Terminali e sessioni');
    const testo = await inventario.innerText();

    // L'intestazione che separa le due nature esiste ed e' una frase, non una
    // chiave. Senza, due colonne di numeri una sopra l'altra si leggono come
    // la stessa cosa — e MB e conteggi non si sommano.
    //
    // CASE-INSENSITIVE di proposito: quella riga ha `uppercase` nel CSS, e
    // `innerText` restituisce il testo COME RESO, non come scritto nel
    // sorgente. Un confronto esatto proverebbe la regola del foglio di stile
    // invece del contenuto.
    expect(testo).toMatch(/trattenuto|held/i);

    // Le righe trattenute NON portano «MB»: e' la regola per cui questa
    // feature esiste in questa forma (RES-ATTR-07).
    const righeTrattenute = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="perf-inventory"]');
      if (!box) return [];
      const figli = [...box.children];
      const i = figli.findIndex(el => /trattenuto|held/i.test(el.textContent ?? ''));
      if (i < 0) return [];
      return figli.slice(i + 1).map(el => el.textContent ?? '');
    });
    expect(righeTrattenute.length).toBeGreaterThan(0);
    for (const r of righeTrattenute) expect(r).not.toContain('MB');

    /* E NEI TOOLTIP DELLE RIGHE, che sono l'altra meta' della superficie.
     *
     * Trovato provando: iniettando un difetto che scriveva i byte stimati come
     * «MB» dentro `rigaVoce`, questo file restava VERDE — perche' guardava solo
     * la colonna visibile, e `rigaVoce` vive nel `title` di ogni riga. Il testo
     * piu' facile da sbagliare era quello non guardato da nessuno. */
    const tooltipTrattenuti = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="perf-inventory"]');
      if (!box) return [];
      const figli = [...box.children];
      const i = figli.findIndex(el => /trattenuto|held/i.test(el.textContent ?? ''));
      if (i < 0) return [];
      return figli.slice(i + 1).map(el => el.getAttribute('title') ?? '');
    });
    expect(tooltipTrattenuti.length).toBeGreaterThan(0);
    // Ogni riga trattenuta HA un tooltip (se mancasse, il test passerebbe a
    // vuoto su stringhe vuote) e nessuno di essi parla di megabyte.
    for (const t of tooltipTrattenuti) {
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toContain('MB');
    }

    // Le righe MISURATE, al contrario, i MB li hanno: senza questo controllo
    // un «togli MB da tutte le righe» passerebbe come una correzione.
    const tooltipMisurati = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="perf-inventory"]');
      if (!box) return [];
      const figli = [...box.children];
      const i = figli.findIndex(el => /trattenuto|held/i.test(el.textContent ?? ''));
      return figli.slice(0, i < 0 ? figli.length : i).map(el => el.getAttribute('title') ?? '');
    });
    expect(tooltipMisurati.length).toBeGreaterThan(0);
    for (const t of tooltipMisurati) expect(t).toContain('MB');
  });

  test('l\'ordine mette il misurato davanti: sono MB veri', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="connection-status"]').click();

    const inventario = page.locator('[data-testid="perf-inventory"]');
    await expect(inventario).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => inventario.innerText(), { timeout: 15_000 })
      .toContain('Terminali e sessioni');
    const testo = await inventario.innerText();
    // La riga piu' pesante in cima, e comunque tutte le misurate prima
    // dell'intestazione del trattenuto.
    const iSessioni = testo.indexOf('Terminali e sessioni');
    const iTrattenuto = testo.search(/trattenuto|held/i);
    expect(iSessioni).toBeGreaterThanOrEqual(0);
    expect(iTrattenuto).toBeGreaterThan(iSessioni);
  });

  test('il recap si legge anche dalla BARRA, senza aprire niente', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    const totale = page.locator('[data-testid="metrics-total"]');
    await expect(totale).toBeVisible({ timeout: 15_000 });

    // PRIMA DELL'HOVER il tooltip NON porta l'inventario: si raccoglie solo
    // quando qualcuno guarda (RES-ATTR-08), e questa e' la prova che la regola
    // e' rispettata invece di dichiarata.
    const primaDellHover = (await totale.getAttribute('title')) ?? '';
    expect(primaDellHover).not.toContain('Cosa tiene questo numero');

    await totale.hover();
    // L'inventario compare all'hover; le voci MISURATE ci entrano quando il
    // campione con la flotta e' arrivato. Si aspetta quella, non «un
    // inventario qualsiasi»: senza, il test leggerebbe le sole voci trattenute
    // e sarebbe rosso per una corsa invece che per un difetto.
    await expect.poll(() => tooltipText(totale), { timeout: 15_000 })
      .toContain('Terminali e sessioni');

    const titolo = await tooltipText(totale);
    expect(titolo).toContain('Cosa tiene questo numero');
    // Il numero del totale resta PRIMA dell'inventario: chi passa il mouse
    // cerca quello, e il dettaglio e' la domanda dopo.
    expect(titolo.indexOf('Topics in tutto')).toBeLessThan(titolo.indexOf('Cosa tiene questo numero'));
    expect(titolo).not.toMatch(/\bstatusBar\.[a-zA-Z.]+/);
  });

  test('senza flotta il pannello non mostra una sezione vuota di zeri', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    // Nessuna flotta: le voci misurate spariscono. Le trattenute restano (l'app
    // ha comunque delle schede), ma nessuna riga deve comparire a «0 MB» — uno
    // zero che sembra una misura.
    await conFlotta(page, null);

    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="connection-status"]').click();
    await expect(page.locator('[data-testid="perf-cost"]')).toBeVisible({ timeout: 10_000 });

    const inventario = page.locator('[data-testid="perf-inventory"]');
    if (await inventario.count()) {
      const testo = await inventario.innerText();
      expect(testo).not.toMatch(/\b0 MB\b/);
      expect(testo).not.toContain('Terminali e sessioni');
    }
  });
});

test.describe('il consumo sulla TAB', () => {
  /* IL DIFETTO SEGNALATO, sul percorso vero. Passando il mouse su una tab di
   * chat usciva soltanto «questa scheda non ha un processo proprio»: una frase
   * che risponde a com'e' implementata la scheda invece che a cosa costa.
   * Riportato come «non vedo dove esce il consumo».
   *
   * SERVE UN E2E, e non basta l'unitario: la funzione riceve la `sessionKey`
   * dalla tab bar, e se quel filo non e' attaccato la funzione resta giusta e
   * il tooltip resta muto — cioe' esattamente com'era prima.
   *
   * E NON PUO' SALTARE quando non trova tab. Il primo tentativo faceva
   * `test.skip` sull'ambiente vuoto: due skip verdi che non provavano niente,
   * e un `test.skip` in un file che gira in CI e' un test che non esiste. Qui
   * la chat viene CREATA (che apre anche la sua tab) e la sua cronologia
   * intercettata con messaggi veri.
   */

  /** Una chat con `n` messaggi in cronologia, e la sua tab aperta. */
  async function chatConMessaggi(page: import('@playwright/test').Page, n: number) {
    const nome = `peso-tab-${Date.now()}`;
    // `createTopic` e non un POST nudo: oltre a creare il topic SEMINA la sua
    // pane nello snapshot di `pane-store-v2`, che e' cio' che ne fa comparire
    // la tab. Un POST diretto crea il topic e basta — provato, e la tab non
    // arrivava mai.
    const topic = await createTopic(page.request, nome) as { id: string; sessionKey?: string };
    const sessionKey = topic.sessionKey ?? `topic:${topic.id.slice(0, 8)}`;

    // La cronologia: e' da qui che il client riempie `messageStore`, cioe' la
    // sorgente che il tooltip conta.
    await page.route(`**/api/history/${encodeURIComponent(sessionKey)}`, async (route) => {
      await route.fulfill({
        json: {
          messages: Array.from({ length: n }, (_, i) => ({
            id: `m${i}`,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `messaggio ${i}`,
            timestamp: new Date().toISOString(),
          })),
        },
      });
    });
    return { id: topic.id, sessionKey, nome };
  }

  test('una chat con messaggi dice quanti ne tiene, non solo cosa non e\'', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    const chat = await chatConMessaggi(page, 7);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    // La tab della chat appena creata: `createTopic` ne apre una, e il titolo
    // porta il nome del topic.
    const tab = page.locator('[role="main"] [data-testid="pane-tab-label"]')
      .filter({ hasText: chat.nome }).first();
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await tab.click(); // aprirla e' cio' che ne carica la cronologia
    await tab.hover();

    await expect.poll(() => tooltipText(tab), { timeout: 20_000 })
      .toContain('In memoria');
    const titolo = await tooltipText(tab);
    expect(titolo).toContain('7 messaggi');
    // E NON MISURA in MB: quelli non si attribuiscono a un componente dentro
    // un renderer condiviso. La frase che lo SPIEGA contiene «MB» di proposito.
    expect(titolo).not.toMatch(/\d+\s*MB/);
    expect(titolo).toContain('Nessun processo proprio');
  });

  test('ogni tab aperta ha un tooltip che parla di consumo, nessuna resta muta', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'RES-ATTR-11' });
    await conFlotta(page);
    await chatConMessaggi(page, 3);
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    const tabs = page.locator('[role="main"] [data-testid="pane-tab-label"]');
    await expect(tabs.first()).toBeVisible({ timeout: 20_000 });
    const n = await tabs.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const t = (await tabs.nth(i).getAttribute('title')) ?? '';
      expect(t).toMatch(/In memoria:|Consumo:/);
    }
  });
});
