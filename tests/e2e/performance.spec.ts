import { test, expect, Page, Locator } from '@playwright/test';
import { createTopic, deleteTopic } from './helpers/api-fixtures';
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// Pause that exists ONLY to pace the delivery video, never to synchronise.
// playwright.config.ts records video on demand (E2E_EVIDENCE=1); on the default
// fast path there is no clip to pace, so these are 8s of dead sleep per run.
// Anything that actually needs to wait for the app uses a condition instead.
const EVIDENCE = process.env.E2E_EVIDENCE === '1';
// DELIBERATE FIXED WAIT: the pause IS the deliverable here. It paces the clip
// so a person can watch it, and it is off on the default fast path.
const videoPause = (page: Page, ms: number) =>
  EVIDENCE ? page.waitForTimeout(ms) : Promise.resolve();

/**
 * Waits until an element's x stops moving — the honest end of a CSS transform
 * animation (the sidebar slide), which has no event we can await. Two identical
 * consecutive samples mean the transition has landed; a fixed sleep would either
 * cut the animation short or pad every run with slack.
 */
async function waitForSettledX(locator: Locator, timeoutMs = 3000): Promise<number> {
  let last = Number.NaN;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const x = (await locator.boundingBox())?.x ?? Number.NaN;
    if (x === last) return x;
    last = x;
    // DELIBERATE FIXED WAIT: this is the sampling interval of a stability
    // poll, not a bet that 100 ms is enough. The condition is the loop.
    await locator.page().waitForTimeout(100);
  }
  return last;
}

/**
 * Measure Cumulative Layout Shift during an action.
 */
async function measureCLS(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    (window as any).__cls = 0;
    // `buffered: true` REPLAYS gli shift avvenuti PRIMA che l'observer
    // esistesse: ogni misura si portava dietro il CLS del caricamento della
    // pagina (~0.107), e i quattro test PERF-01 fallivano tutti con lo stesso
    // numero qualunque azione misurassero. Qui interessa lo shift causato
    // DALL'AZIONE, quindi si osserva solo da adesso in poi.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          (window as any).__cls += (entry as any).value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });
  await action();
  // DELIBERATE FIXED WAIT: the CLS observer scores what shifts INSIDE a window.
  // The window is the measurement. Shortening it on a condition would score a
  // different thing and silently lower the number.
  await page.waitForTimeout(1000);
  return page.evaluate(() => (window as any).__cls);
}

/**
 * CLS del CARICAMENTO: qui `buffered: true` è voluto — si vuole il replay di
 * tutto quello che si è mosso da quando la pagina è partita. Torna anche CHI
 * si è mosso, perché un numero da solo non dice dove guardare.
 */
async function readLoadCLS(page: Page): Promise<{ cls: number; sources: string[] }> {
  return page.evaluate(
    () =>
      new Promise<{ cls: number; sources: string[] }>((resolve) => {
        let cls = 0;
        const sources: string[] = [];
        const label = (el: Element): string => {
          const testid = el.getAttribute('data-testid');
          const aria = el.getAttribute('aria-label');
          const role = el.getAttribute('role');
          const cn = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.');
          return `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ''}${aria ? `{${aria}}` : ''}${role ? `<${role}>` : ''}${cn ? `.${cn}` : ''}`;
        };
        /** Il nodo che shifta spesso è un div anonimo: si risale finché non si
         *  trova un antenato riconoscibile, altrimenti non si sa dove guardare. */
        const describe = (el: Element | null): string => {
          if (!el) return '(sconosciuto)';
          const chain: string[] = [label(el)];
          let cur: Element | null = el.parentElement;
          let hops = 0;
          while (cur && hops < 6) {
            chain.push(label(cur));
            if (cur.getAttribute('data-testid') || cur.getAttribute('aria-label') || cur.getAttribute('role')) break;
            cur = cur.parentElement;
            hops++;
          }
          return chain.reverse().join(' > ');
        };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as any;
            if (e.hadRecentInput) continue;
            cls += e.value;
            for (const src of e.sources ?? []) {
              sources.push(`${e.value.toFixed(4)} ← ${describe(src.node as Element)}`);
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve({ cls, sources }), 500);
      }),
  );
}

/**
 * "L'interfaccia si è assestata" MISURATO SUL DOM, non sui pixel.
 *
 * La versione precedente (`assertVisualStability`) confrontava due screenshot
 * JPEG byte per byte e rapportava i byte diversi al totale. È una metrica che
 * non misura quello che dice: un JPEG è un flusso compresso, un pixel che
 * cambia in alto sposta tutti i byte successivi, e il "cambiamento" schizza a
 * numeri senza senso — misurati 83.9% dopo un toggle di sidebar e 220.6% dopo
 * l'invio di un messaggio, dove il massimo teorico sarebbe 100. Per giunta
 * bocciava il contenuto che ARRIVA (una risposta che streamma) trattandolo
 * come instabilità di layout.
 *
 * Qui si campiona la geometria reale (`getBoundingClientRect`) dei contenitori
 * strutturali a distanza di `windowMs` e si torna l'elenco di chi si è mosso.
 * Il testo che cresce DENTRO un contenitore non lo muove: il rettangolo dello
 * scroller resta quello. Torna [] quando è tutto fermo.
 */
async function assertLayoutSettled(page: Page, windowMs = 1500): Promise<string[]> {
  const snapshot = () =>
    page.evaluate(() => {
      const selectors = [
        '[aria-label="Topics sidebar"]',
        '[role="main"]',
        '[data-testid="panel-tab-bar"]',
        '[data-testid="chat-message-list"]',
      ];
      const out: Record<string, string> = {};
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el, i) => {
          const r = el.getBoundingClientRect();
          out[`${sel}#${i}`] = [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(',');
        });
      }
      return out;
    });

  const before = await snapshot();
  // DELIBERATE FIXED WAIT: the assertion is that NOTHING moved between the two
  // snapshots. With no window there is nothing to have failed to happen.
  await page.waitForTimeout(windowMs);
  const after = await snapshot();

  const moved: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) {
      moved.push(`${key}: ${before[key] ?? '(assente)'} → ${after[key] ?? '(assente)'}`);
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Topic di questa spec
// ---------------------------------------------------------------------------

/**
 * Le PERF vivevano di topic ALTRUI: non ne creavano nessuna e
 * `getByRole('treeitem')` pescava quel che gli altri file avevano lasciato nel
 * DB condiviso. Girate da sole trovavano la sidebar vuota (due rossi), e
 * quando per caso i topic c'erano, metà delle asserzioni stava dietro a
 * `if (count > 0)` e non girava comunque. Ora la spec si porta i suoi due.
 */
let perfTopics: { id: string; name: string }[] = [];

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  perfTopics = [
    await createTopic(request, `E2E-Perf-A-${stamp}`),
    await createTopic(request, `E2E-Perf-B-${stamp}`),
  ];
});

test.afterAll(async ({ request }) => {
  for (const t of perfTopics) await deleteTopic(request, t.id).catch(() => {});
  perfTopics = [];
});

// ---------------------------------------------------------------------------
// PERF-01 — Layout Stability & Visual Quality
// ---------------------------------------------------------------------------

/**
 * L'app è pronta quando la sidebar è montata, non quando la rete tace.
 *
 * `networkidle` è sconsigliato da Playwright, e qui era letale: il client
 * ritenta la WebSocket del gateway e polla `/api/context/analyze`, quindi i
 * 500ms di silenzio di rete non arrivano MAI. Ogni `beforeEach` di PERF-01
 * moriva nei 30s di timeout — sei test rossi che non misuravano niente.
 */
async function waitForAppReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('PERF-01 — Layout Stability & Visual Quality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await videoPause(page, 1500);
  });

  test('Topic switch has no visible layout shift', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'spec', description: 'PERF-01' });
    // Click the first topic in sidebar (uses role="treeitem" like other E2E tests)
    const topics = page.getByRole('treeitem');
    await expect(topics.first()).toBeVisible({ timeout: 15_000 });
    await videoPause(page, 1000);
    await topics.first().click();
    // The topic is loaded when its pane exists — not after 1.5s of hoping.
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await videoPause(page, 1500);

    // Now measure CLS while switching to a different topic. Due topic ci sono
    // per costruzione (beforeAll), quindi niente `if`: l'asserzione gira sempre.
    await expect
      .poll(() => topics.count(), { timeout: 10_000 })
      .toBeGreaterThan(1);
    const cls = await measureCLS(page, async () => {
      await topics.nth(1).click();
      // DELIBERATE FIXED WAIT: inside a CLS measurement, so the shifts that the
      // click causes are given time to be scored rather than raced past.
      await page.waitForTimeout(500);
    });
    expect(cls).toBeLessThan(0.1);

    // Layout stability: i contenitori non si muovono dopo il cambio topic.
    const moved = await assertLayoutSettled(page);
    expect(moved, `layout ancora in movimento dopo il cambio topic:\n${moved.join('\n')}`).toEqual([]);
  });

  test('Initial page load has no white flash', async ({ page }) => {
    // Create a new page to observe from scratch
    const newPage = await page.context().newPage();

    // Inject a script that captures bg color on first animation frame
    await newPage.addInitScript(() => {
      requestAnimationFrame(() => {
        (window as any).__firstBg = getComputedStyle(document.documentElement).backgroundColor;
      });
    });

    await newPage.goto('/');
    await newPage.waitForLoadState('domcontentloaded');
    // DELIBERATE FIXED WAIT: what is under test is the FIRST painted frame, so
    // the probe must be read after a paint and before nothing in particular.
    // Any condition to wait on here would be downstream of the frame itself.
    await newPage.waitForTimeout(200);

    const firstBg = await newPage.evaluate(() => (window as any).__firstBg || getComputedStyle(document.documentElement).backgroundColor);

    // The first background should NOT be white (rgb(255, 255, 255))
    expect(firstBg).not.toBe('rgb(255, 255, 255)');
    expect(firstBg).not.toBe('rgba(0, 0, 0, 0)'); // transparent also bad — means no bg set

    // Layout stability: i contenitori non si muovono dopo il caricamento.
    const moved = await assertLayoutSettled(newPage);
    expect(moved, `layout ancora in movimento dopo il load:\n${moved.join('\n')}`).toEqual([]);

    await newPage.close();
  });

  test('Sidebar toggle does not cause content shift', async ({ page }) => {
    // Must open a topic first — the sidebar toggle only matters with tabs open.
    const topics = page.getByRole('treeitem');
    await expect(topics.first()).toBeVisible({ timeout: 15_000 });
    await topics.first().click();
    // La topic è aperta quando la sua tab bar è a schermo (era 1500ms fissi).
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // The redesign removed the persistent "Toggle sidebar" button: the sidebar is
    // position:fixed with a CONSTANT width and collapses via a composited
    // translateX(-100%) (App.tsx:746-758), so there is no width reflow and no
    // always-present toggle button — collapse/expand is driven by ⌘B
    // (useKeyboardShortcuts: isMod && key === 'b' → toggleSidebar). We therefore
    // toggle via keyboard and detect state by the sidebar sliding OFF-SCREEN
    // (x goes negative), not by visibility (translateX keeps it "visible").
    const sidebar = page.locator('[aria-label="Topics sidebar"]').first();
    await expect(sidebar).toBeVisible();
    const xBefore = (await sidebar.boundingBox())?.x ?? 0;

    await videoPause(page, 1000);
    await page.screenshot({ path: 'test-results/sidebar-BEFORE-toggle.png' });

    // Toggle sidebar (⌘B)
    const cls = await measureCLS(page, async () => {
      await page.keyboard.press('Meta+b');
      // This one is NOT video pacing — it's the CLS measurement window, so it
      // must cover the whole slide. Ends when the sidebar stops moving.
      await waitForSettledX(sidebar);
    });
    expect(cls).toBeLessThan(0.1);

    await page.screenshot({ path: 'test-results/sidebar-AFTER-toggle.png' });

    // Verify sidebar actually changed state — it slid off-screen (x < before).
    const xAfter = (await sidebar.boundingBox())?.x ?? xBefore;
    expect(xAfter, 'Sidebar should slide off-screen (x decreases) on collapse').toBeLessThan(xBefore);

    // Toggle back
    await page.keyboard.press('Meta+b');
    await waitForSettledX(sidebar);
    await videoPause(page, 1500);

    // Non `sidebar-AFTER-restore`: il verbo dopo AFTER- deve avere un BEFORE-
    // gemello, e qui non c'è (il «prima» della riapertura è lo scatto
    // AFTER-toggle). Marcato come mezza coppia, finiva fuori dalla review senza
    // un avviso — vedi scripts/ai-review-screenshots.py. È uno stato a sé: si
    // chiama per quello che è e viene rivisto come singolo.
    await page.screenshot({ path: 'test-results/sidebar-restored.png' });

    // Layout stability: riaperta la sidebar, tutto torna fermo dov'era.
    const moved = await assertLayoutSettled(page);
    expect(moved, `layout ancora in movimento dopo il toggle sidebar:\n${moved.join('\n')}`).toEqual([]);
  });

  test('Panel split does not cause layout shift', async ({ page }) => {
    // Preconditions are ASSERTED, not tiptoed around. This test used to wrap
    // every assertion in `if (await x.count() > 0)`: with no topic, no tab bar,
    // no tab or no split entry it ran zero expects and reported green — the one
    // outcome a layout-shift guard must never produce, because "the UI didn't
    // render" is precisely the regression it exists to catch.
    const topics = page.getByRole('treeitem');
    await expect(topics.first()).toBeVisible({ timeout: 10_000 });
    await topics.first().click();

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 10_000 });
    const tab = tabBar.locator('[draggable="true"]').first();
    await expect(tab).toBeVisible({ timeout: 10_000 });

    // Il conteggio è RELATIVO: uno split aggiunge una cella a quelle che ci
    // sono, e quante ce ne siano dipende da cosa ha lasciato aperto la spec
    // precedente (la suite condivide il DB). Pretendere `toHaveCount(2)` in
    // assoluto faceva rosso a 3 celle, cioè per uno split perfettamente riuscito.
    const barsBefore = await page.locator('[data-testid="panel-tab-bar"]').count();
    const cls = await measureCLS(page, async () => {
      await tab.click({ button: 'right' });
      const splitOption = page.getByText('Dividi a destra', { exact: true });
      await expect(splitOption).toBeVisible({ timeout: 5_000 });
      await splitOption.click();
      // The split is done when a new pane exists — not after a fixed sleep.
      await expect(page.locator('[data-testid="panel-tab-bar"]')).toHaveCount(barsBefore + 1, {
        timeout: 10_000,
      });
    });
    expect(cls).toBeLessThan(0.1);

    // Layout stability: dopo lo split le due celle stanno ferme.
    const moved = await assertLayoutSettled(page);
    expect(moved, `layout ancora in movimento dopo lo split:\n${moved.join('\n')}`).toEqual([]);
  });

  test('Chat message list does not shift on new message', async ({ page }) => {
    // Select a topic first — and a TOPIC, not merely the first thing in the tree.
    // On 26/08 `d4bcd2771` gave the board row a `role="treeitem"` it was missing
    // (axe-core was right: a tree must contain treeitems). That row sorts first,
    // so `.first()` started opening the BOARD, which has no composer, and this
    // test failed ten seconds later on a `Message input` that was never going to
    // appear — reading like a layout regression while nothing about layout had
    // changed.
    const topics = page
      .getByRole('treeitem')
      .and(page.locator(':not([data-testid="sidebar-board-generale"])'));
    await expect(topics.first()).toBeVisible({ timeout: 15_000 });
    await topics.first().click();
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // Get message area (role="main" as used in chat.spec.ts)
    const mainArea = page.locator('[role="main"]');
    await mainArea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // Type a message using the same input selector as chat.spec.ts
    const input = page.getByRole('textbox', { name: /Message input/ });
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Set up CLS measurement before sending
    await page.evaluate(() => {
      (window as any).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            (window as any).__cls += (entry as any).value;
          }
        }
      }).observe({ type: 'layout-shift', buffered: false });
    });

    await input.fill('test perf message');
    await input.press('Enter');
    // Finestra di misura del CLS: qui il tempo è la variabile misurata, non
    // un'attesa di comodo.
    await page.waitForTimeout(1000);

    const cls = await page.evaluate(() => (window as any).__cls ?? 0);
    expect(cls).toBeLessThan(0.1);

    // La lista che riceve la risposta non deve MUOVERE i contenitori: il
    // contenuto cresce dentro lo scroller, il rettangolo dello scroller no.
    const moved = await assertLayoutSettled(page);
    expect(moved, `layout ancora in movimento dopo l'invio:\n${moved.join('\n')}`).toEqual([]);
  });

  test('Initial load CLS never enters the "poor" band', async ({ page }, testInfo) => {
    await page.goto('/');
    await waitForAppReady(page);

    const { cls, sources } = await readLoadCLS(page);
    const detail = `CLS di caricamento ${cls.toFixed(4)} — chi si è mosso:\n${sources.slice(0, 10).join('\n')}`;
    testInfo.annotations.push({ type: 'cls-load', description: detail });

    // Il CLS è ADVISORY per decisione di progetto (2026-07-12), quindi la soglia
    // che fa rosso è la banda "poor" di Google (>0.25), non la "good" (<0.1).
    // Misurato oggi con due chat aperte: 0.144 — banda "needs improvement". Le
    // sorgenti sono tre `div[chat-message-list] > div > div`, cioè i messaggi
    // che si assestano dopo il primo paint: sta in <MessageList>, che è lavoro
    // strutturale in corso su un'altra sessione — annotato, non toccato qui.
    expect(cls, detail).toBeLessThan(0.25);
  });

  test('No repeated state changes during initial load', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    const mutations = await page.evaluate(() => {
      return new Promise<number>(resolve => {
        let count = 0;
        const observer = new MutationObserver((records) => {
          count += records.length;
        });
        observer.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, characterData: true
        });
        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 3000);
      });
    });

    // A shell montata, le mutazioni del DOM devono essere pochissime
    // High mutation count = UI is thrashing/reconnecting
    expect(mutations, 'DOM should be stable after load — too many mutations suggest reconnect loops or state thrashing').toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// PERF-02 — Load Performance
// ---------------------------------------------------------------------------

test.describe('PERF-02 — Load Performance', () => {
  test('App loads within 3 seconds', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'spec', description: 'PERF-02' });
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - start;

    expect(loadTime).toBeLessThan(3000);
  });

  test('Topic switch completes within 500ms', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    const topics = page.getByRole('treeitem');
    await expect
      .poll(() => topics.count(), { timeout: 15_000 })
      .toBeGreaterThan(1);

    // Click first topic to be in a chat
    await topics.first().click();
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const start = Date.now();
    await topics.nth(1).click();

    // Lo switch è finito quando la tab della SECONDA topic è quella attiva —
    // `[role="main"]` era già visibile prima del click, quindi il vecchio
    // `waitFor` tornava subito e il tempo misurato era quasi zero.
    await expect(
      page.locator('[role="main"] [draggable="true"][data-active="true"]').first(),
    ).toBeVisible({ timeout: 5_000 });
    const switchTime = Date.now() - start;

    expect(switchTime).toBeLessThan(500);
  });

  test('No render-blocking long tasks after initial load', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Start observing long tasks. Si raccolgono anche le DURATE: "3 task lunghi"
    // non dice se sono tre da 52ms o tre da 400ms, e sono due bug diversi.
    const longTasks = await page.evaluate(() => {
      return new Promise<{ count: number; durations: number[] }>((resolve) => {
        const durations: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) durations.push(Math.round(e.duration));
        });
        observer.observe({ type: 'longtask', buffered: false });

        // Simulate normal interaction for 2 seconds
        setTimeout(() => {
          observer.disconnect();
          resolve({ count: durations.length, durations });
        }, 2000);
      });
    });

    // Budget: main thread libero almeno al 90% nella finestra di 2s. Il vecchio
    // "al massimo 1 long task" era un numero inventato — e il test non girava
    // mai (moriva prima su `networkidle`), quindi nessuno l'aveva verificato.
    // Misurato col CPU profiler: nei 3s dopo il mount il thread è idle al 95%
    // (2979ms su 3128), con un solo task da ~153ms di lavoro di boot del
    // browser (compile dei chunk + primo paint), zero JS applicativo pesante.
    // Il totale BLOCCANTE (parte di ogni task oltre i 50ms) è la metrica che si
    // sente davvero come scatto, non il conteggio dei task.
    const blocking = longTasks.durations.reduce((a, d) => a + Math.max(0, d - 50), 0);
    expect(
      blocking,
      `long task a riposo: ${longTasks.count} (${longTasks.durations.join('ms, ')}ms) — blocking ${blocking}ms`,
    ).toBeLessThanOrEqual(200);
  });
});
