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
import { openProfileMenu } from './helpers/open-perf-panel';

hermetic(test);

/** An element that carries a `title` and is surely on screen once the menu
 *  is open: the performance row of the system menu. Scoped to the menu on
 *  purpose, because the user card at the foot of the column carries a
 *  `metrics-total` of its own (STATUSLINE-04) and that one has no tooltip. */
const CON_TITLE = '[data-testid="sidebar-system-menu"] [data-testid="metrics-total"]';

test.describe('il tooltip e\' quello dell\'app, non quello del sistema', () => {
  test('passando il mouse compare il nostro, e il nativo viene disinnescato', async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TOOLTIP-01" });
    await page.goto('/');
    // The number lives behind the one door of the chrome since the status
    // bar moved there (SIDEBAR-STATUS-01), and the tooltip this test watches
    // is its own: the menu has to be open before anything can hover it.
    await openProfileMenu(page);

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
    /* SI GUARDA `data-tip`, NON L'ASSENZA DI `title`.
     *
     * `data-tip` e' il segnale STABILE: viene scritto nello stesso istante in
     * cui `title` viene tolto, e nessuno lo riscrive — quindi o c'e' o non
     * c'e'. La sua presenza prova esattamente cio' che conta: il delegato ha
     * preso questo elemento e il testo e' passato di la'.
     *
     * `title` invece e' CONTESO, e pretenderlo assente rendeva il test
     * instabile (un rosso ogni due giri, misurato). Il componente sotto si
     * ri-renderizza a ogni fotogramma — porta gli fps — e React riscrive la
     * prop; l'osservatore la ritoglie in un microtask, ma una lettura che cade
     * in quella finestra la trova presente.
     *
     * E non e' un difetto: il tooltip di SISTEMA parte dopo circa un secondo
     * di quiete sullo stesso elemento, e un attributo tolto e rimesso per
     * microtask non gliela concede mai. Un test che pretende l'istante misura
     * la fortuna; questo misura il fatto. La prova che il nativo resti muto
     * sta nel caso «uscendo, il title TORNA», dove l'attributo e' fermo. */
    /* THE HOVER REPEATS UNTIL IT TAKES, and that is not fussiness.
     *
     * The delegate lives on a capturing `mouseover` on the document
     * (`TooltipDelegate.tsx`): for it to write `data-tip`, that event has to
     * arrive AFTER the listener is registered and on the right element. A
     * single `hover()` gives one chance, and under load that is a dice roll:
     * the component underneath re-renders every frame (it carries the fps), so
     * the node the mouse entered can be replaced right after — the pointer
     * stays where it is, no new `mouseover` fires, and the attribute never
     * arrives.
     *
     * Measured: green at load 5.5, red at load 10.7 and above — same suite,
     * same code, with four shards instead of two. The 10s poll was waiting for
     * an event that was never coming again.
     *
     * Moving the mouse away and back on every round makes each attempt produce
     * a NEW `mouseover`: if the first lands in the wrong window, the next one
     * repairs it. On an idle machine it takes on the first try and nothing
     * changes. */
    await expect
      .poll(
        async () => {
          const already = await el.getAttribute('data-tip');
          if (already !== null) return already;
          // Out and back in: it is the RETURN that produces a fresh
          // `mouseover`, which is what is needed when the previous node was
          // replaced by a re-render while the pointer already sat on it.
          await page.mouse.move(0, 0);
          await el.hover();
          // Then wait for the ATTRIBUTE, not a duration: `data-tip` is written
          // in the `mouseover` handler, so either it lands within a few frames
          // or that `mouseover` never arrived and another round is needed.
          return await el
            .getAttribute('data-tip', { timeout: 2_000 })
            .catch(() => null);
        },
        {
          message: 'il delegato non ha preso questo elemento: `data-tip` mai scritto',
          timeout: 20_000,
        },
      )
      .not.toBeNull();
    expect(await el.getAttribute('data-tip')).toContain('Topics');
  });

  test('uscendo, il `title` TORNA: i lettori di schermo non perdono il testo', async ({ page }) => {
    await page.goto('/');
    // The number lives behind the one door of the chrome since the status
    // bar moved there (SIDEBAR-STATUS-01), and the tooltip this test watches
    // is its own: the menu has to be open before anything can hover it.
    await openProfileMenu(page);

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
    // The number lives behind the one door of the chrome since the status
    // bar moved there (SIDEBAR-STATUS-01), and the tooltip this test watches
    // is its own: the menu has to be open before anything can hover it.
    await openProfileMenu(page);
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
    // The number lives behind the one door of the chrome since the status
    // bar moved there (SIDEBAR-STATUS-01), and the tooltip this test watches
    // is its own: the menu has to be open before anything can hover it.
    await openProfileMenu(page);
    const el = page.locator(CON_TITLE).first();
    await expect(el).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await el.getAttribute('title')) ?? '', { timeout: 15_000 }).not.toBe('');

    const tip = page.locator('[data-testid="app-tooltip"]');
    /* Repeated hover, BUT WITH THE PAUSE.
     *
     * The delegate opens after 350 ms of the mouse held STILL over the element
     * (`TooltipDelegate.tsx`): a loop that enters and leaves continuously
     * resets that timer every round and the box never appears — the first
     * hardening attempt did exactly that, and failed saying "the tooltip never
     * appeared" precisely because it never gave it time to appear.
     *
     * So: re-enter (to generate a fresh `mouseover`, needed when the node
     * underneath was replaced by a re-render) and THEN stay still past the
     * threshold. The poll re-checks, and under load the next round repairs
     * it. */
    await expect
      .poll(
        async () => {
          if (await tip.isVisible()) return true;
          await page.mouse.move(0, 0);
          await el.hover();
          // `toBeVisible` ALREADY waits: the 350 ms opening delay fits inside
          // it with no need to sleep. If it times out, the `mouseover` did not
          // take and the next poll round re-enters from scratch.
          return await expect(tip)
            .toBeVisible({ timeout: 2_000 })
            .then(() => true, () => false);
        },
        { message: 'il tooltip non e\' mai comparso', timeout: 20_000 },
      )
      .toBe(true);
    const righe = (await tip.innerText()).split('\n').map(r => r.trim()).filter(Boolean);

    // Piu' di due righe: il nativo non ci arriverebbe.
    expect(righe.length, `il tooltip ha ${righe.length} righe: non e' multiriga`).toBeGreaterThan(2);
    // Ed e' PROSA, non una chiave i18n rimasta grezza — il difetto che una
    // traduzione mancante produce, invisibile a un test di funzione.
    expect(righe.join(' ')).not.toMatch(/\b(statusBar|perf|board)\.[a-zA-Z.]+/);
  });
});
