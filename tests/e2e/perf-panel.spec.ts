import { test, expect } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';

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
 * COSA NON PUÒ FARE, detto qui perché una prova che non sa fallire va nominata
 * invece che sottintesa. Lo swap non si comanda: su una macchina di test la
 * riga del verdetto non compare, e verificato — rompendo di proposito una
 * chiave i18n e rieseguendo — **questo file resta verde**. Quindi NON è il
 * cancello del verdetto: quello è `verdict.test.ts`, che prova la decisione,
 * più il controllo sulle chiavi di `i18n-keys.test.ts`, che prova che le
 * stringhe esistono in entrambe le lingue.
 *
 * Quello che questo file prende, e che nessuno dei due prende, è la CATENA: il
 * bottone della barra di stato apre davvero il pannello, e il pannello mostra
 * numeri invece di trattini. Un pannello che non si apre più renderebbe inutile
 * ogni riga che ci abbiamo messo dentro, e nessun test di funzione se ne
 * accorgerebbe.
 */
hermetic(test);

test.describe('pannello prestazioni', () => {
  test('si apre dalla barra di stato e mostra numeri, non chiavi', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    // Il gesto vero: la barra di stato in fondo alla sidebar.
    const bottone = page.locator('[data-testid="connection-status"]');
    await expect(bottone).toBeVisible({ timeout: 15_000 });
    await bottone.click();

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
});
