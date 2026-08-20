/**
 * IL TOOLTIP DELL'APP AL POSTO DI QUELLO DEL SISTEMA, ovunque.
 *
 * COSA PROVA, e perche' serve un E2E. Il delegato vive sugli eventi del
 * documento: intercetta `mouseover`, toglie `title` all'elemento (cosi' il
 * nativo non ha piu' niente da mostrare), disegna il proprio, e all'uscita
 * RIMETTE l'attributo. Nessuna di queste cose e' osservabile da un test di
 * funzione — sono tutte «cosa succede nel DOM vero quando il mouse passa».
 *
 * IL DIFETTO CHE TIENE CHIUSO. Un `title` tolto e non rimesso e' una
 * regressione di accessibilita' silenziosa: a schermo tutto sembra a posto
 * (anzi, meglio), e intanto i lettori di schermo hanno perso il testo. E'
 * l'unica cosa che questo cambiamento puo' rompere in modo invisibile, quindi
 * e' la prima cosa che viene misurata qui.
 */
import { test, expect } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';

hermetic(test);

/** Un elemento che porta un `title` e sta di sicuro a schermo: la barra di
 *  stato in fondo alla sidebar, che e' montata su ogni pagina. */
const CON_TITLE = '[data-testid="metrics-total"]';

test.describe('il tooltip e\' quello dell\'app, non quello del sistema', () => {
  test('passando il mouse compare il nostro, e il nativo viene disinnescato', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    const el = page.locator(CON_TITLE).first();
    await expect(el).toBeVisible({ timeout: 20_000 });
    // Prima: l'attributo c'e' (e senza delegato sarebbe il sistema a mostrarlo).
    await expect.poll(async () => (await el.getAttribute('title')) ?? '', { timeout: 15_000 })
      .not.toBe('');

    await el.hover();

    // Il NOSTRO tooltip compare…
    const tip = page.locator('[data-testid="app-tooltip"]');
    await expect(tip).toBeVisible({ timeout: 5_000 });
    expect((await tip.innerText()).trim().length).toBeGreaterThan(0);

    /* …e il nativo NON parte: l'attributo non c'e' piu' mentre il mouse e'
     * sopra. E' questa la differenza fra «ne abbiamo due» e «ne abbiamo uno».
     *
     * `expect.poll` E NON UNA LETTURA SECCA. Questo elemento si ri-renderizza
     * mentre lo si guarda — porta gli fps, e l'hover stesso chiede un campione
     * fresco — quindi React riscrive `title` e l'osservatore lo ritoglie in un
     * microtask. Una lettura secca cade a caso dentro quella finestra e
     * fallisce per il funzionamento normale invece che per un difetto.
     *
     * Cio' che conta e' che l'attributo NON RESTI: il tooltip di sistema parte
     * dopo circa un secondo di quiete, quindi un `title` che sparisce entro
     * quel tempo non lo fa mai comparire. Se invece il delegato non lo togliesse
     * affatto, questo `poll` scadrebbe. */
    /* IL TEMPO E' GENEROSO DI PROPOSITO. Al primo caricamento la pagina e'
     * ancora sotto carico — misurato nel rosso: «4 fotogrammi al secondo» —
     * quindi React ri-renderizza a raffica e riscrive `title` piu' volte al
     * secondo. L'osservatore lo ritoglie ogni volta, ma una lettura che cade
     * fra la riscrittura e il microtask lo trova presente.
     *
     * Cio' che conta non e' l'istante: e' che l'attributo non RESTI. Il
     * tooltip di sistema parte dopo circa un secondo di quiete sul medesimo
     * elemento, quindi un `title` che sparisce e riappare per microtask non lo
     * fa mai comparire. Otto secondi coprono anche il caricamento; se il
     * delegato non lo togliesse affatto, il poll scadrebbe lo stesso. */
    await expect.poll(async () => await el.getAttribute('title'), { timeout: 8_000 }).toBeNull();
    expect(await el.getAttribute('data-tip')).not.toBeNull();
  });

  test('uscendo, il `title` TORNA: i lettori di schermo non perdono il testo', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    const el = page.locator(CON_TITLE).first();
    await expect(el).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await el.getAttribute('title')) ?? '', { timeout: 15_000 }).not.toBe('');
    // La PRIMA RIGA e non il testo intero: questo tooltip e' vivo — porta i MB
    // e gli fps, che cambiano fra una lettura e l'altra. Confrontare la
    // stringa intera faceva fallire il test per un aggiornamento dei numeri,
    // cioe' per il funzionamento normale invece che per un difetto.
    const primaRiga = (await el.getAttribute('title'))!.split('\n')[0];

    await el.hover();
    await expect(page.locator('[data-testid="app-tooltip"]')).toBeVisible({ timeout: 5_000 });

    // Via il mouse, in un punto che non ha tooltip.
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await el.getAttribute('title'))?.split('\n')[0], { timeout: 5_000 })
      .toBe(primaRiga);
    // E il rettangolo se n'e' andato con lui.
    await expect(page.locator('[data-testid="app-tooltip"]')).toBeHidden({ timeout: 5_000 });
  });

  test('un click lo chiude subito, invece di lasciarlo appeso', async ({ page }) => {
    // Chi preme un bottone ha finito di leggere. Un tooltip che sopravvive al
    // click resta sopra la cosa che compare dopo.
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    const el = page.locator(CON_TITLE).first();
    await expect(el).toBeVisible({ timeout: 20_000 });
    await el.hover();
    await expect(page.locator('[data-testid="app-tooltip"]')).toBeVisible({ timeout: 5_000 });
    await el.click();
    await expect(page.locator('[data-testid="app-tooltip"]')).toBeHidden({ timeout: 5_000 });
  });

  test('il tooltip e\' MULTIRIGA: e\' meta\' della ragione per cui esiste', async ({ page }) => {
    /* Il nativo tronca a una riga. Il nostro no, e questo caso lo misura.
     *
     * NON CONFRONTA PIU' IL TESTO CON L'ATTRIBUTO. Provato, ed era instabile:
     * questo tooltip e' vivo — memoria, CPU e fps cambiano fra la lettura
     * dell'attributo e il disegno del rettangolo, e il delegato mostra di
     * proposito il valore AGGIORNATO. Il test falliva sul funzionamento
     * normale e passava al secondo tentativo, che e' il modo peggiore di
     * fallire: sembra un caso, e nasconde un difetto vero il giorno che c'e'.
     *
     * La domanda stabile e' un'altra, ed e' quella che conta: quante righe
     * arrivano, e sono prosa o una chiave i18n non risolta? */
    await page.goto('/');
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    const el = page.locator(CON_TITLE).first();
    await expect(el).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await el.getAttribute('title')) ?? '', { timeout: 15_000 }).not.toBe('');
    await el.hover();

    const tip = page.locator('[data-testid="app-tooltip"]');
    await expect(tip).toBeVisible({ timeout: 5_000 });
    const righe = (await tip.innerText()).split('\n').map(r => r.trim()).filter(Boolean);

    // Piu' di due righe: il nativo non ci arriverebbe.
    expect(righe.length, `il tooltip ha ${righe.length} righe: non e' multiriga`).toBeGreaterThan(2);
    // Ed e' PROSA, non una chiave i18n rimasta grezza — il difetto che una
    // traduzione mancante produce, invisibile a un test di funzione.
    expect(righe.join(' ')).not.toMatch(/\b(statusBar|perf|board)\.[a-zA-Z.]+/);
  });
});
