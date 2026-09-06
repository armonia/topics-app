/**
 * @covers PERFPANEL-01
 */
import { test, expect } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';
import { openPerfPanel, openProfileMenu } from "./helpers/open-perf-panel";

/**
 * IL PANNELLO PRESTAZIONI, SUL PERCORSO CHE L'UTENTE PERCORRE DAVVERO.
 *
 * PERCHÉ ESISTE. Il 2026-08-19 il pannello ha guadagnato una riga: quando il
 * grosso del footprint è già stato compresso o mandato in swap, lo dice, invece
 * di lasciar credere che l'app tenga tutto. La decisione è provata da
 * `verdict.test.ts` — ma quello prova una FUNZIONE, e una funzione giusta
 * dietro un pannello che non si apre, o una chiave i18n che non risolve, è
 * indistinguibile da niente.
 *
 * Questo file esercita la catena vera: aprire il pannello dalla barra di stato,
 * leggere quello che c'è scritto.
 *
 * COME FA A VEDERE LA RIGA, visto che lo swap non si comanda. Il primo tentativo
 * si limitava ad aprire il pannello e sperare, e non poteva funzionare: fuori da
 * Tauri `usePerfMetrics` non ha nessuna fonte (`getMetrics` è `null`), quindi il
 * verdetto non compariva mai e il file restava verde anche con una chiave i18n
 * rotta di proposito — verificato. Una prova che non sa fallire non è una prova.
 *
 * Qui il guscio Tauri viene simulato al confine giusto: `__TAURI_INTERNALS__`,
 * l'oggetto che Tauri stesso inietta e che `detectShell()` interroga. Da lì in
 * giù gira TUTTO il codice vero — l'hook, `computeTopicsFootprint`,
 * `scegliVerdetto`, le stringhe, la JSX. Non è uno stub del componente: è
 * l'unico ingresso che una macchina di test non può avere, sostituito con i
 * numeri MISURATI sulla finestra dell'utente il 2026-08-19.
 */
hermetic(test);

test.describe('pannello prestazioni', () => {
  // THE DOOR ONLY EXISTS WHEN PAIRED. The panel opens from the user card
  // (SIDEBAR-STATUS-01), and the card is drawn only for a paired session.
  // Under the shell mock these tests install, the client rewrites every
  // `/api` call to the desktop server's loopback port, where the E2E server
  // is not: the session would come back unpaired and the door would not be
  // there. So the session is answered here, with the same stub every
  // identity spec uses. Nothing else in the file cares who is signed in.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/session', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ paired: true, as: 'loopback', name: 'Questo computer',
                               role: 'owner', personId: 'io' }) }));
  });

  test('si apre dalla barra di stato e mostra numeri, non chiavi', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERFPANEL-01" });
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    // The real gesture, now in two steps: the bar lives in the «Topics» menu.
    await openPerfPanel(page);

    // «Quanto costa» è la riga che porta il numero della memoria — quella che
    // ha prodotto la segnalazione «1,8 GB».
    const costo = page.locator('[data-testid="perf-cost"]');
    await expect(costo).toBeVisible({ timeout: 10_000 });
    const testoCosto = await costo.innerText();
    expect(testoCosto).toMatch(/\d/); // c'è un numero, non un trattino solo

    // NESSUNA CHIAVE GREZZA, da nessuna parte nel pannello. È il difetto che
    // una traduzione mancante produce, ed è invisibile a un test di funzione.
    const pannello = page.locator('[data-testid="perf-cost"]').locator('xpath=ancestor::div[3]');
    const testo = await pannello.innerText();
    expect(testo).not.toMatch(/\bperf\.[a-zA-Z.]+/);

    // Se il verdetto compare (dipende dallo stato della macchina, quindi non lo
    // si pretende), deve essere una frase — non una chiave, non un vuoto.
    const verdetto = page.locator('[data-testid="perf-verdict"]');
    if (await verdetto.count()) {
      const v = (await verdetto.innerText()).trim();
      expect(v.length).toBeGreaterThan(0);
      expect(v).not.toMatch(/\bperf\.[a-zA-Z.]+/);
    }
  });

  test('col footprint quasi tutto in swap, il pannello lo DICE invece di lasciarlo credere', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERFPANEL-01" });
    // I numeri sono quelli misurati sulla finestra dell'utente: 1.788 MB di
    // footprint contro 517 residenti. Prima di questo lavoro il pannello
    // mostrava «1,8 GB» e nient'altro — la sola riga che parlava di swap si
    // accendeva sopra i 2 GB, quindi 1.271 MB compressi non la raggiungevano.
    await page.addInitScript(() => {
      const MB = { total_mb: 1788, resident_mb: 517 };
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        invoke: async (cmd: string) => {
          if (cmd !== 'perf_metrics') throw new Error(`comando non simulato: ${cmd}`);
          return {
            version: 'e2e', ...MB,
            renderer_mb: 1200, gpu_mb: 88, other_mb: 500,
            cpu_percent: 12, cpu_renderer: 6, cpu_gpu: 2,
            cpu_sampled: 3, cpu_pids: 3, process_count: 3,
            partial: false, // misura completa: senza questo la riga tace, ed è giusto
          };
        },
      };
    });

    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await openPerfPanel(page);

    const verdetto = page.locator('[data-testid="perf-verdict"]');
    await expect(verdetto).toBeVisible({ timeout: 10_000 });
    const testo = await verdetto.innerText();

    // 1.271 su 1.788 = 71%, e i 517 MB sono la risposta alla domanda vera:
    // quanto di questo numero è memoria che qualcun altro non può avere.
    expect(testo).toContain('71');
    expect(testo).toContain('517');
    // E NON consiglia di chiudere niente: quel consiglio appartiene al caso
    // della pressione vera, e qui manderebbe a fare una cosa inutile.
    expect(testo.toLowerCase()).not.toContain('chiudi');
    expect(testo).not.toMatch(/\bperf\.[a-zA-Z.]+/);
  });

  test('sotto PRESSIONE vera dice la cosa opposta: chiudi qualcosa', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERFPANEL-01" });
    // L'altro ramo, e il motivo per cui le righe sono due invece di una. Qui la
    // memoria compressa e' tanta in valore ASSOLUTO (2,9 GB), cioe' la macchina
    // sta davvero paginando: il consiglio di chiudere qualcosa e' azionabile.
    // Nel caso precedente sarebbe stato sbagliato, perche' la memoria se n'era
    // gia' andata da sola.
    //
    // Senza questo caso, una regressione che facesse vincere sempre la riga
    // informativa passerebbe: l'altro test continuerebbe a essere verde.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        invoke: async (cmd: string) => {
          if (cmd !== 'perf_metrics') throw new Error(`comando non simulato: ${cmd}`);
          return {
            version: 'e2e', total_mb: 6000, resident_mb: 3000,
            renderer_mb: 4000, gpu_mb: 200, other_mb: 1800,
            cpu_percent: 10, cpu_renderer: 5, cpu_gpu: 1,
            cpu_sampled: 3, cpu_pids: 3, process_count: 3, partial: false,
          };
        },
      };
    });

    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await openPerfPanel(page);

    const verdetto = page.locator('[data-testid="perf-verdict"]');
    await expect(verdetto).toBeVisible({ timeout: 10_000 });
    const testo = (await verdetto.innerText()).toLowerCase();
    expect(testo).toContain('chiudi');
    expect(testo).not.toMatch(/\bperf\.[a-zA-Z.]+/);
  });

  test('la PRIMA RIGA del menu dice quanta memoria, senza espandere il pannello', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERFPANEL-01" });
    // Il numero che l'utente vede per primo è quello della riga CHIUSA, non
    // quello del pannello: fino al 2026-08-20 la spiegazione stava due clic più
    // in là, e chi leggeva «1,8 GB» restava con un numero che significa altro.
    //
    // It said «the BAR, without opening anything», and that bar is gone from
    // the desktop: its contents are inside the «Topics» menu
    // (SIDEBAR-STATUS-01). The half that mattered was not «without opening» —
    // it was that the number not sit under a SECOND gesture, because a cost
    // paid to read a datum is a datum nobody reads. That half is still here:
    // the menu opens and the number is already there, panel still closed.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        invoke: async (cmd: string) => {
          if (cmd !== 'perf_metrics') throw new Error(`comando non simulato: ${cmd}`);
          return {
            version: 'e2e', total_mb: 1989, resident_mb: 594,
            renderer_mb: 1400, gpu_mb: 130, other_mb: 459,
            cpu_percent: 8, cpu_renderer: 4, cpu_gpu: 1,
            cpu_sampled: 3, cpu_pids: 3, process_count: 8, partial: false,
          };
        },
      };
    });

    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    // ONE gesture: open the menu. The panel stays closed — that is the point.
    await openProfileMenu(page);
    // The TOTAL's tooltip, the big number on the row: read by hovering it,
    // without expanding the panel. Scoped to the menu, because the user card
    // now carries a `metrics-total` of its own (STATUSLINE-04) and that one
    // has no tooltip: it IS the glance.
    const totale = page.locator('[data-testid="sidebar-system-menu"] [data-testid="metrics-total"]');
    await expect(totale).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await totale.getAttribute('title')) ?? '', { timeout: 10_000 })
      .toContain('594');
    const titolo = (await totale.getAttribute('title'))!;
    expect(titolo).toMatch(/in RAM adesso|in RAM right now/);
    expect(titolo).not.toMatch(/\bstatusBar\.[a-zA-Z.]+/);
  });

  test('una misura PARZIALE non produce nessuna riga, invece di inventarne una', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERFPANEL-01" });
    // `partial: true` = la shell non ha potuto misurare tutti i processi (e' il
    // caso non-macOS, che il payload dichiara invece di fingere). Una
    // percentuale calcolata su una misura parziale sarebbe una piccola bugia
    // detta con precisione, e il pannello preferisce tacere.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        invoke: async (cmd: string) => {
          if (cmd !== 'perf_metrics') throw new Error(`comando non simulato: ${cmd}`);
          return {
            version: 'e2e', total_mb: 1788, resident_mb: 517,
            renderer_mb: 1200, gpu_mb: 88, other_mb: 500,
            cpu_percent: 10, cpu_renderer: 5, cpu_gpu: 1,
            cpu_sampled: 1, cpu_pids: 3, process_count: 3,
            partial: true, // <- l'unica differenza dal primo caso
          };
        },
      };
    });

    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    await openPerfPanel(page);
    // Il pannello si apre lo stesso e mostra il costo…
    await expect(page.locator('[data-testid="perf-cost"]')).toBeVisible({ timeout: 10_000 });
    // …ma sugli stessi numeri del primo caso NON dice il 71%: la misura non
    // regge quell'affermazione.
    const verdetto = page.locator('[data-testid="perf-verdict"]');
    if (await verdetto.count()) {
      expect(await verdetto.innerText()).not.toContain('71');
    }
  });
});
