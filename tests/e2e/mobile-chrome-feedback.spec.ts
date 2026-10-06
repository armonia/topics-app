/**
 * IL GIRO DI FEEDBACK SULLA CHROME DEL TELEFONO (05/10/2026, msg 3862).
 *
 * Provando Topics dal telefono: la riga in alto deve rivelarsi scorrendo con
 * le sessioni da subito dopo la safe area, il menu Topics deve stare nel menu
 * utente, la fila in basso tiene le sue misure, Cerca sta nel design system,
 * «In attesa» non resta mai muta e la matita apre subito una chat nuova.
 *
 * Ogni voce qui è un numero letto dal DOM su 390x844 col dito:
 *
 *  MOBILE-CHROME-07  in cima la riga è compatta (44), scorrendo si rivela
 *                    intera (56), le righe partono da `--sat`; il foglio ha
 *                    due piani e il menu Topics si raggiunge dalla radice
 *  MOBILE-CHROME-08  primo/ultimo tasto col raggio basso esterno sopra 12px,
 *                    PASSO fra i tasti, SOPRA sopra, glifi al centro (±1px)
 *                    e la parola sotto, fuori dal flusso
 *  MOBILE-CHROME-09  il toggle Cerca sta allo stesso passo degli altri tasti
 *                    (bordi e centri dei glifi, ±1px)
 *  MOBILE-CHROME-10  Cerca ha il fondo dell'app (mai il grigio dei popover),
 *                    dipinto da y=0, e il contenuto dentro la safe area
 *  MOBILE-CHROME-11  «In attesa» è sempre abilitata: a coda vuota apre il Now
 *                    (il passo con la coda resta di CHAT-WAIT-04, provato lì)
 *  MOBILE-CHROME-12  tap sulla matita = bozza nuova a fuoco; pressione lunga
 *                    = l'intero menu «+», senza nessuna chat
 *
 * La fascia inferiore, il raggio e la tacca si FORZANO (`--sab`,
 * `--screen-corner-radius`, `--sat`): è per questo che vivono in variabili CSS
 * invece che in `env()` nude — `env()` non si sovrascrive.
 *
 * @covers MOBILE-CHROME-07, MOBILE-CHROME-08, MOBILE-CHROME-09, MOBILE-CHROME-10, MOBILE-CHROME-11, MOBILE-CHROME-12
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BAR = '[data-testid="mobile-chrome-bar"]';
const CERCA = '[data-testid="mobile-chrome-search"]';
const MATITA = '[data-testid="pane-add-menu-trigger"]';
const ATTESA = '[data-testid="mobile-chrome-waiting"]';
const COLONNA = '[aria-label="Topics sidebar"]';
const SCROLLER = `${COLONNA} .sidebar-column`;
/** La fascia dell'home indicator e il raggio di un iPhone in verticale. */
const BAND = 34;
const RADIUS = 55;
/** Una tacca da forzare: `--sat` a zero non distingue «dopo la safe area» da «da y=0». */
const NOTCH = 24;
/** Abbastanza righe da straripare a 844px da sole (vedi mobile-list-under-chrome). */
const CROWD = 20;

let ids: string[] = [];

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < CROWD; i++) ids.push((await createTopic(request, `Chrome feedback ${i}`)).id);
  await resetPaneStore(request, ids);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  for (const id of ids) await deleteTopic(request, id);
  ids = [];
});

async function open(page: Page): Promise<void> {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
  await page.evaluate(([band, radius]) => {
    const s = document.documentElement.style;
    s.setProperty("--sab", `${band}px`);
    s.setProperty("--screen-corner-radius", `${radius}px`);
    window.dispatchEvent(new Event("resize"));
  }, [BAND, RADIUS] as const);
  // Le scatole crescono della fascia: lo si aspetta, poi si aspetta la fila ferma.
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector(`${sel} button`)?.getBoundingClientRect().height ?? 0, BAR))
    .toBeGreaterThanOrEqual(44 + BAND - 1);
  await waitForLayoutSettled(page, BAR);
}

/** Forza la tacca e aspetta chi la legge. */
async function notch(page: Page, px: number): Promise<void> {
  await page.evaluate((v) => {
    document.documentElement.style.setProperty("--sat", `${v}px`);
    window.dispatchEvent(new Event("resize"));
  }, px);
  await waitForLayoutSettled(page);
}

/** Quante bolle di messaggio si vedono davvero (le pane tenute vive non contano). */
async function visibleMessages(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-message"]'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== "hidden";
    }).length);
}

test("MOBILE-CHROME-07: compatta in cima, intera appena si scorre, righe dalla safe area", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-07" });
  await open(page);
  await notch(page, NOTCH);

  const read = () => page.evaluate(() => {
    const column = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = column.firstElementChild as HTMLElement;
    const sc = column.querySelector<HTMLElement>(".sidebar-column")!;
    const rows = Array.from(sc.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const hr = header.getBoundingClientRect();
    return {
      compact: header.getAttribute("data-compact"),
      headerH: Math.round(hr.height),
      headerBottom: hr.bottom,
      padding: parseFloat(getComputedStyle(sc).paddingTop),
      firstTop: rows.length ? rows[0]!.getBoundingClientRect().top : null,
      behind: rows.some((r) => { const b = r.getBoundingClientRect(); return b.top < hr.bottom && b.bottom > 0; }),
      overflow: sc.scrollHeight - sc.clientHeight,
    };
  });

  // In cima: compatta, e le righe da subito dopo la tacca.
  const top = await read();
  expect(top.compact).toBe("true");
  expect(top.headerH).toBe(44);
  expect(Math.abs(top.padding - NOTCH)).toBeLessThanOrEqual(1);
  expect(Math.abs(top.firstTop! - NOTCH)).toBeLessThanOrEqual(1);
  expect(top.overflow, "the list must overflow, or there is nothing to reveal on scroll").toBeGreaterThan(0);

  // Scorrendo: la riga si rivela intera e le righe le passano sotto.
  await page.evaluate((sel) => { document.querySelector<HTMLElement>(sel)!.scrollTop = 120; }, SCROLLER);
  await expect.poll(async () => (await read()).compact).toBe("false");
  const scrolled = await read();
  expect(scrolled.headerH).toBe(56);
  expect(scrolled.behind, "no row travels behind the revealed header").toBe(true);

  // E tornando in cima torna compatta: la rivelazione è reversibile.
  await page.evaluate((sel) => { document.querySelector<HTMLElement>(sel)!.scrollTop = 0; }, SCROLLER);
  await expect.poll(async () => (await read()).compact).toBe("true");
  expect((await read()).headerH).toBe(44);
});

test("MOBILE-CHROME-07b: il menu Topics si raggiunge dal menu utente", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-07" });
  await open(page);

  // Il foglio si apre alla radice: identità, voce Topics, stato.
  await page.locator('[data-testid="sidebar-topics-menu"]').tap();
  const entry = page.locator('[data-testid="user-menu-topics-entry"]');
  await expect(entry).toBeVisible();
  await expect(page.locator('[data-testid="menu-system-status"]')).toBeVisible();
  await expect(page.locator('[data-testid="user-menu-topics-back"]')).toHaveCount(0);

  // La voce scende al piano Topics: indietro + le righe.
  await entry.tap();
  await expect(page.locator('[data-testid="user-menu-topics-back"]')).toBeVisible();
  await expect(page.locator('[data-testid="topics-menu-view"]')).toBeVisible();
  await expect(entry).toHaveCount(0);

  // E indietro risale alla radice.
  await page.locator('[data-testid="user-menu-topics-back"]').tap();
  await expect(entry).toBeVisible();
  await expect(page.locator('[data-testid="menu-system-status"]')).toBeVisible();
});

/** Rettangolo, centro del glifo, raggi e parola di ogni tasto della fila. */
async function buttons(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="mobile-chrome-bar"]')!;
    const barH = bar.getBoundingClientRect().height;
    return {
      barH,
      doors: Array.from(bar.querySelectorAll<HTMLElement>("button")).map((b) => {
        const r = b.getBoundingClientRect();
        const g = (b.querySelector("svg") ?? b.querySelector<HTMLElement>(".rounded-full")) as Element;
        const gr = g.getBoundingClientRect();
        // La parola, non il primo `span`: la porta dell'attesa avvolge il
        // glifo in uno `span.relative` che non è lei.
        const word = b.querySelector("span.pointer-events-none") as HTMLElement | null;
        const wr = word?.getBoundingClientRect();
        const s = getComputedStyle(b);
        const px = (v: string) => parseFloat(v) || 0;
        return {
          id: b.getAttribute("data-testid") ?? b.getAttribute("title"),
          x: r.x, w: r.width, h: r.height,
          cx: gr.left + gr.width / 2,
          dcx: gr.left + gr.width / 2 - (r.left + r.width / 2),
          dcy: gr.top + gr.height / 2 - (r.top + r.height / 2),
          glyphCy: gr.top + gr.height / 2,
          glyphBottomAir: r.bottom - (gr.top + gr.height),
          wordTop: wr ? wr.top : null,
          bl: px(s.borderBottomLeftRadius),
          br: px(s.borderBottomRightRadius),
        };
      }),
    };
  });
}

test("MOBILE-CHROME-08: raggi, aria e glifi al centro", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-08" });
  await open(page);
  const { barH, doors } = await buttons(page);
  expect(doors.length).toBe(5);
  const first = doors[0]!;
  const last = doors[doors.length - 1]!;

  // Il basso esterno del primo e dell'ultimo è sopra lo standard: segue il vetro.
  expect(first.bl).toBeGreaterThan(12);
  expect(last.br).toBeGreaterThan(12);

  // PASSO fra i tasti, SOPRA sopra: l'unica aria orizzontale e quella in alto.
  for (let i = 1; i < doors.length; i++) {
    const gap = doors[i]!.x - (doors[i - 1]!.x + doors[i - 1]!.w);
    expect(Math.abs(gap - 6), `buco fra ${doors[i - 1]!.id} e ${doors[i]!.id}`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(barH - first.h - 6)).toBeLessThanOrEqual(1);

  // Il glifo al centro su entrambi gli assi, la parola sotto fuori dal flusso
  // con aria misurabile fra il glifo e il fondo del tasto.
  for (const d of doors) {
    expect(Math.abs(d.dcx), `${d.id} dcx`).toBeLessThanOrEqual(1);
    expect(Math.abs(d.dcy), `${d.id} dcy`).toBeLessThanOrEqual(1);
    expect(d.wordTop!, `${d.id} ha la parola sotto il glifo`).toBeGreaterThan(d.glyphCy);
    expect(d.glyphBottomAir, `${d.id} aria sotto il glifo`).toBeGreaterThanOrEqual(20);
  }
});

test("MOBILE-CHROME-09: Cerca equidistante", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-09" });
  await open(page);
  const { doors } = await buttons(page);
  expect(doors.length).toBe(5);
  expect(doors[0]!.id).toBe("mobile-chrome-search");

  // Un PASSO unico: il buco di Cerca è il buco degli altri, e il passo fra i
  // centri dei glifi è lo stesso per tutta la fila.
  const gaps = doors.slice(1).map((d, i) => d.x - (doors[i]!.x + doors[i]!.w));
  const steps = doors.slice(1).map((d, i) => d.cx - doors[i]!.cx);
  for (let i = 1; i < gaps.length; i++) {
    expect(Math.abs(gaps[i]! - gaps[0]!), `buco ${i} contro il buco di Cerca`).toBeLessThanOrEqual(1);
    expect(Math.abs(steps[i]! - steps[0]!), `passo ${i} contro il passo di Cerca`).toBeLessThanOrEqual(1);
  }
});

test("MOBILE-CHROME-10: Cerca nel design system e dentro la safe area", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-10" });
  await open(page);
  await notch(page, NOTCH);

  await page.locator(CERCA).tap();
  const pal = page.locator('[data-testid="command-palette"]');
  await expect(pal).toBeVisible();
  await waitForLayoutSettled(page, '[data-testid="command-palette"]');

  const m = await page.evaluate(() => {
    const root = document.querySelector("[data-testid=\"command-palette\"]") as HTMLElement;
    const panel = root.children[0] as HTMLElement;
    // Il fondo dell'app, letto dalla stessa variabile che lo dichiara.
    const probe = document.createElement("div");
    probe.style.background = "var(--bg)";
    document.body.appendChild(probe);
    const appBg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const input = root.querySelector("input")!;
    // Ogni nodo che interseca lo schermo deve finire sopra l'indicatore: la
    // pagina tiene `--sab` di rispetto in fondo, non solo `--sat` sopra.
    let worst = 0;
    for (const el of Array.from(panel.querySelectorAll("*"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) worst = Math.max(worst, r.bottom);
    }
    return {
      panelTop: panel.getBoundingClientRect().top,
      panelBg: getComputedStyle(panel).backgroundColor,
      appBg,
      paddingBottom: parseFloat(getComputedStyle(panel).paddingBottom),
      inputTop: input.getBoundingClientRect().top,
      worstBottom: worst,
      vh: window.innerHeight,
    };
  });
  // Il fondo è quello dell'app, dipinto da y=0: nessuno stacco col notch.
  expect(m.panelBg).toBe(m.appBg);
  expect(m.panelTop).toBeLessThanOrEqual(1);
  // E il contenuto sta dentro la safe area, sopra e sotto.
  expect(m.inputTop).toBeGreaterThanOrEqual(NOTCH);
  expect(m.paddingBottom).toBeGreaterThanOrEqual(BAND - 1);
  expect(m.worstBottom).toBeLessThanOrEqual(m.vh - BAND + 1);

  // La si chiude col bottone indietro (il primo della pagina) e sparisce.
  await pal.locator("button").first().tap();
  await expect(pal).toHaveCount(0);
});

test("MOBILE-CHROME-11: a coda vuota «In attesa» apre il Now", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-11" });
  await open(page);

  // Viva a coda vuota: abilitata, non muta.
  const door = page.locator(ATTESA);
  await expect(door).toBeEnabled();
  await door.tap();
  await expect(page.locator('[data-testid="inbox-panel-now"]')).toBeVisible();

  // Escape la richiude (sul telefono è un foglio col suo scrim: la campanella
  // sta dietro il velo e non si può ritoccare per chiudere).
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="inbox-panel"]')).toHaveCount(0);
});

test("MOBILE-CHROME-12: tap sulla matita apre la bozza, senza menu", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-12" });
  // Ogni chat che esiste ha una riga: quella che si apre senza righe è nuova
  // per forza. (Le bozze non si leggono dal server: sono scratch locali e lo
  // snapshot in uscita le spoglia — `selectSyncableSnapshot`.)
  const topics = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as {
    topics: Record<string, { sessionKey?: string }>;
  };
  for (const id of ids) {
    const sessionKey = topics.topics[id]?.sessionKey;
    if (!sessionKey) throw new Error(`topic ${id} has no sessionKey: the seed cannot reach it`);
    await seedMessage(request, { sessionKey, role: "user", content: "ciao" });
  }
  await open(page);
  // La riga c'è davvero, dietro il cassetto: se non si vedesse, lo zero dopo
  // sarebbe vacuo invece che una prova.
  await expect.poll(() => visibleMessages(page)).toBeGreaterThanOrEqual(1);

  await page.locator(MATITA).tap();
  // Il cassetto si chiude e davanti va una chat senza righe — la bozza, non
  // una delle venti. Il menu no.
  await expect(page.locator(COLONNA)).toBeHidden();
  await expect.poll(() => visibleMessages(page)).toBe(0);
  await expect(page.locator('[data-testid="chat-message-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="pane-add-menu"]')).toHaveCount(0);
});

test("MOBILE-CHROME-12b: pressione lunga apre l'intero menu, senza chat", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-12" });
  await open(page);

  // La pressione lunga, sintetizzata dove il dito la mette: `touchstart`,
  // seicento millisecondi TENUTI (la tenuta È il gesto, come la velocità di
  // uno swipe — non un'attesa del driver), `touchend`, e il clic che il
  // browser sintetizzerebbe dopo, che il trigger deve mangiarsi. Eventi nudi
  // con le touches appiccicate: `new Touch()` è un costruttore illegale fuori
  // da un dito vero (WebKit desktop), e a React basta che l'evento si chiami
  // `touchstart` e porti le touches.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="pane-add-menu-trigger"]') as HTMLElement;
    const r = btn.getBoundingClientRect();
    const touch = { identifier: 1, target: btn, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const touchEvent = (type: string, touches: unknown[], changed: unknown[]) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: touches });
      Object.defineProperty(ev, "targetTouches", { value: touches });
      Object.defineProperty(ev, "changedTouches", { value: changed });
      return ev;
    };
    btn.dispatchEvent(touchEvent("touchstart", [touch], [touch]));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        btn.dispatchEvent(touchEvent("touchend", [], [touch]));
        btn.click();
        resolve();
      }, 650);
    });
  });

  // Il menu c'è, popolato (lo stesso elenco del desktop, non un sottoinsieme),
  // e nessuna chat si è aperta: il cassetto è ancora lì.
  const menu = page.locator('[data-testid="pane-add-menu"]');
  await expect(menu).toBeVisible();
  expect(await menu.locator("button").count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(COLONNA)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
