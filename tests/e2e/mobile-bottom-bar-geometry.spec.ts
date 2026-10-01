/**
 * LA FILA IN FONDO, MISURATA TASTO PER TASTO — e la banda «Utilizzo Claude» sotto cui passa la lista.
 *
 * Chiesto da un telefono (01/10): «i tasti non seguono la curva in basso, il
 * primo e l'ultimo non hanno l'altezza corretta e le loro icone non sono
 * centrate». Ogni frase e' un numero letto dal DOM, su tutti e cinque i tasti:
 *
 * MOBILE-GEOM-01  i cinque tasti hanno la stessa altezza e lo stesso bordo basso
 *                 (sul vetro): nessuno e' alzato dall'arco
 * MOBILE-GEOM-02  il centro dell'icona coincide con il centro del tasto, sia in
 *                 orizzontale sia in verticale, primo e ultimo compresi (±1px)
 * MOBILE-GEOM-03  l'angolo basso ESTERNO del primo e dell'ultimo ha il raggio
 *                 dello schermo (concentrico, a filo del bordo), quelli in mezzo
 *                 restano standard
 * MOBILE-GEOM-04  con la banda «Utilizzo Claude» in vista la lista scorre
 *                 SOTTO la banda (il fondo e' traslucido, lo scroller arriva al
 *                 vetro) e a riposo l'ultima riga sta sopra la banda
 * MOBILE-GEOM-05  il documento e' sotto la status bar e il home indicator
 *                 (viewport-fit=cover + status bar traslucida), e le due fasce
 *                 hanno lo stesso fondo del contenuto: nessuna fascia vuota
 *
 * La fascia inferiore e il raggio si FORZANO (`--sab`, `--screen-corner-radius`):
 * WebKit headless non ha un home indicator, ma il codice legge solo quelle due
 * variabili.
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BARRA = '[data-testid="mobile-chrome-bar"]';
const SHOTS = process.env.GEOM_SHOTS_DIR;
const TAG = process.env.GEOM_TAG ?? "x";
/** La fascia dell'home indicator e il raggio degli angoli di un iPhone con Dynamic Island. */
const FASCIA = 34;
const RAGGIO = 55;
const STANDARD = 12;
const CROWD = 14;

let ids: string[] = [];

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < CROWD; i++) ids.push((await createTopic(request, `Geometria fila ${i}`)).id);
  await resetPaneStore(request, ids);
});

test.afterAll(async ({ request }) => {
  await request.post("/api/test/plan-usage", { data: { clear: true } });
  await resetPaneStore(request, []);
  for (const id of ids) await deleteTopic(request, id);
  ids = [];
});

async function apri(page: Page) {
  await page.goto(E2E_BASE);
  await expect(page.locator(BARRA)).toBeVisible();
  await page.evaluate(([f, r]) => {
    const s = document.documentElement.style;
    s.setProperty("--sab", `${f}px`);
    s.setProperty("--screen-corner-radius", `${r}px`);
    window.dispatchEvent(new Event("resize"));
  }, [FASCIA, RAGGIO] as const);
  await page.waitForTimeout(300);
}

/** Rettangolo, centro e raggi di ogni tasto + del suo glifo (l'icona, non l'etichetta). */
async function tasti(page: Page) {
  return page.evaluate(() => {
    const barra = document.querySelector('[data-testid="mobile-chrome-bar"]')!;
    return Array.from(barra.querySelectorAll<HTMLElement>("button")).map((b) => {
      const r = b.getBoundingClientRect();
      // Il glifo: l'svg (lucide), oppure il cerchio dell'avatar/iniziali.
      const g = (b.querySelector("svg") ?? b.querySelector<HTMLElement>(".rounded-full")) as Element;
      const gr = g.getBoundingClientRect();
      const s = getComputedStyle(b);
      const px = (v: string) => parseFloat(v) || 0;
      return {
        id: b.getAttribute("data-testid") ?? b.getAttribute("title"),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        altezza: r.height, larghezza: r.width,
        daFondo: window.innerHeight - r.bottom,
        dcx: gr.left + gr.width / 2 - (r.left + r.width / 2),
        dcy: gr.top + gr.height / 2 - (r.top + r.height / 2),
        glifo: { w: gr.width, h: gr.height },
        raggi: { bassoSx: px(s.borderBottomLeftRadius), bassoDx: px(s.borderBottomRightRadius), altoSx: px(s.borderTopLeftRadius), altoDx: px(s.borderTopRightRadius) },
      };
    });
  });
}

async function shotBarra(page: Page, nome: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${TAG}-${nome}.png` });
  await page.screenshot({ path: `${SHOTS}/${TAG}-${nome}-barra.png`, clip: { x: 0, y: 844 - 120, width: 390, height: 120 } });
}

test("MOBILE-GEOM-01/02/03 — cinque tasti alla stessa altezza, icone centrate, angoli concentrici", async ({ page }) => {
  await apri(page);
  const t = await tasti(page);
  console.log("TASTI", JSON.stringify(t.map((x) => ({ id: x.id, h: x.altezza, w: Math.round(x.larghezza), daFondo: x.daFondo, dcx: +x.dcx.toFixed(2), dcy: +x.dcy.toFixed(2), r: x.raggi }))));
  await shotBarra(page, "barra");
  expect(t.length).toBe(5);

  // 01 — stessa altezza, stesso bordo alto, stesso bordo basso, tutti sul vetro.
  expect(new Set(t.map((x) => Math.round(x.altezza))).size, "altezze diverse").toBe(1);
  expect(new Set(t.map((x) => Math.round(x.top))).size, "bordi alti diversi").toBe(1);
  for (const x of t) expect(Math.round(x.daFondo), `${x.id} non e' sul vetro`).toBe(0);

  // 02 — il centro del glifo e' il centro del tasto, su entrambi gli assi.
  for (const x of t) {
    expect(Math.abs(x.dcx), `${x.id} dcx`).toBeLessThanOrEqual(1);
    expect(Math.abs(x.dcy), `${x.id} dcy`).toBeLessThanOrEqual(1);
  }

  // 03 — primo e ultimo: angolo esterno concentrico al vetro; il resto standard.
  const primo = t[0]!;
  const ultimo = t[4]!;
  expect(primo.raggi.bassoSx).toBeCloseTo(RAGGIO, 0);
  expect(ultimo.raggi.bassoDx).toBeCloseTo(RAGGIO, 0);
  expect(primo.raggi.bassoDx).toBe(STANDARD);
  expect(ultimo.raggi.bassoSx).toBe(STANDARD);
  for (const x of t.slice(1, -1)) {
    expect(x.raggi.bassoSx).toBe(STANDARD);
    expect(x.raggi.bassoDx).toBe(STANDARD);
  }
});

test("MOBILE-GEOM-04 — con la banda «Utilizzo Claude» la lista scorre sotto la banda", async ({ page, request }) => {
  await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 92, resetsAtMs: Date.now() + 3 * 3_600_000 } } });
  await apri(page);
  const banda = page.getByTestId("mobile-transport-band");
  await expect(banda).toBeVisible();
  await expect(page.getByTestId("plan-usage-notice")).toBeVisible();
  await page.waitForTimeout(300);

  const leggi = () => page.evaluate(() => {
    const colonna = document.querySelector('[aria-label="Topics sidebar"]')!;
    const scroller = colonna.querySelector<HTMLElement>(".sidebar-column")!;
    const b = document.querySelector<HTMLElement>('[data-testid="mobile-transport-band"]')!;
    const righe = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const bs = getComputedStyle(b);
    // rgba(r, g, b, a) · rgb(r g b / a) · color(srgb r g b / a): l'alpha e' l'ultimo numero dopo la barra o la quarta virgola.
    const alpha = (c: string) => { const m = c.match(/\/\s*([\d.]+%?)\s*\)/) ?? c.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/); if (!m) return 1; return m[1]!.endsWith("%") ? parseFloat(m[1]!) / 100 : parseFloat(m[1]!); };
    return {
      vh: window.innerHeight,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      bandaTop: b.getBoundingClientRect().top,
      bandaAlpha: alpha(bs.backgroundColor),
      bandaBlur: (bs.backdropFilter || (bs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none"),
      ultimoBottom: righe.length ? righe[righe.length - 1]!.getBoundingClientRect().bottom : null,
      overflow: scroller.scrollHeight - scroller.clientHeight,
      righe: righe.length,
    };
  });
  await expect.poll(async () => (await leggi()).righe).toBeGreaterThan(8);
  const riposo = await leggi();
  console.log("BANDA-RIPOSO", JSON.stringify(riposo));
  await shotBarra(page, "banda-riposo");
  // lo scroller arriva al vetro: le righe passano dietro la banda
  expect(riposo.scrollerBottom).toBeGreaterThanOrEqual(riposo.vh - 1);
  // e il fondo della banda lascia vedere cio' che le passa dietro
  expect(riposo.bandaAlpha).toBeLessThan(1);
  expect(riposo.bandaBlur).not.toBe("none");
  expect(riposo.overflow).toBeGreaterThan(0);

  await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[aria-label="Topics sidebar"] .sidebar-column')!;
    s.scrollTop = s.scrollHeight;
  });
  await page.waitForTimeout(250);
  const fondo = await leggi();
  console.log("BANDA-FONDO", JSON.stringify(fondo));
  await shotBarra(page, "banda-fondo");
  // a fine corsa l'ultima riga sta INTERA sopra la banda
  expect(fondo.ultimoBottom!).toBeLessThanOrEqual(fondo.bandaTop + 1);
});

test("MOBILE-GEOM-05 — sotto status bar e home indicator, senza fasce vuote", async ({ page }) => {
  await page.goto(E2E_BASE);
  await expect(page.locator(BARRA)).toBeVisible();
  const r = await page.evaluate(() => {
    const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
    const root = document.querySelector<HTMLElement>("#root > div") ?? (document.body.firstElementChild as HTMLElement);
    const header = document.querySelector('[aria-label="Topics sidebar"]')!.firstElementChild as HTMLElement;
    const bar = document.querySelector<HTMLElement>('[data-testid="mobile-chrome-bar"]')!;
    const rr = root.getBoundingClientRect();
    const bg = (e: Element) => getComputedStyle(e).backgroundColor;
    return {
      viewport: meta("viewport"),
      statusBar: meta("apple-mobile-web-app-status-bar-style"),
      capable: meta("apple-mobile-web-app-capable"),
      rootTop: rr.top,
      rootBottom: rr.bottom,
      vh: window.innerHeight,
      chromeBg: (() => { const d = document.createElement("div"); d.style.background = "var(--chrome-bg)"; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })(),
      htmlBg: bg(document.documentElement),
      bodyBg: bg(document.body),
      rootBg: bg(root),
      headerTop: header.getBoundingClientRect().top,
      barBottom: bar.getBoundingClientRect().bottom,
    };
  });
  console.log("PWA", JSON.stringify(r));
  expect(r.viewport).toContain("viewport-fit=cover");
  expect(r.statusBar).toBe("black-translucent");
  expect(r.capable).toBe("yes");
  // il contenitore copre tutto lo schermo: dal bordo alto al bordo basso
  expect(r.rootTop).toBeLessThanOrEqual(0.5);
  expect(r.rootBottom).toBeGreaterThanOrEqual(r.vh - 0.5);
  expect(r.barBottom).toBeGreaterThanOrEqual(r.vh - 0.5);
  // lo sfondo dietro le fasce e' quello del contenuto, non un altro colore
  expect(r.htmlBg).toBe(r.bodyBg);
  expect(r.htmlBg).toBe(r.chromeBg);
});
