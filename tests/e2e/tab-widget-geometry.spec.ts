/**
 * LA GEOMETRIA DEI WIDGET DENTRO UNA TAB, misurata sull'elemento renderizzato.
 *
 * «Il tasto, cerchietto per chiudere una tab, non è ben posizionato, così come
 * il loader e la notifica. Il numero non è centrato al centro del pallino, né
 * verticalmente, così come il testo della tab non è ben centrato verticalmente»
 * (Attilio, 10/08).
 *
 * Erano quattro difetti con DUE cause, e nessuna delle due si vede da un test
 * unitario perché le costanti erano coerenti fra loro:
 *
 *  1. IL BINARIO ALLINEAVA LA SCATOLA, NON IL GLIFO. `.row-actions` si fermava a
 *     `ROW_PX` (8px) dal bordo interno — ma con la scatola, che è 28 attorno a un
 *     glifo da 16. Il cerchietto disegnato finiva quindi a 14px dal bordo, mentre
 *     il badge che sostituisce ne sta 8: passando il mouse, il pallino spariva e
 *     il cerchio compariva SEI PIXEL più a sinistra.
 *  2. RIGHE DI TESTO ALTE UN NUMERO DISPARI DI MEZZI PIXEL. L'etichetta ereditava
 *     l'interlinea del body (1,5 × 13 = 19,5) dentro una tab da 28: nasceva a
 *     4,25px. Il badge aveva `leading-none` (11) in una pastiglia da 16: 2,5px.
 *     Una riga di testo che nasce su un quarto o un mezzo pixel si rasterizza
 *     spalmata su due righe di sub-pixel — si legge «non centrata», ed è
 *     letteralmente vero.
 *
 * Quindi si misura QUI: dove cadono i rettangoli, e dove cade l'INCHIOSTRO dei
 * glifi (non la loro scatola — la scatola era già centrata, ed è il motivo per
 * cui il difetto era invisibile a chi guardava solo i `getBoundingClientRect`).
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** `ROW_PX` risolto in pixel (`ROW_ACTIONS_INSET_PX` in `lib/selectionStyles.ts`):
 *  il bordo interno del contenuto di una riga. È dove si fermano i segnali
 *  quieti in coda, e quindi dove deve fermarsi anche il comando che li copre. */
const ROW_PX = 8;
/** Il glifo dentro il comando (`ROW_ACTION_GLYPH`). */
const GLIFO = 16;

const TS = Date.now();
let a: { id: string; name: string };
let b: { id: string; name: string };
let sessionKeyA = "";

test.beforeAll(async ({ request }) => {
  a = await createTopic(request, `GeoTab-A-${TS}`);
  b = await createTopic(request, `GeoTab-B-${TS}`);
  // Il sessionKey lo assegna il server: leggerlo invece di ricostruirlo fa sì
  // che un cambio di convenzione rompa il test in modo evidente, invece di
  // fargli iniettare frame che nessuno raccoglie (verde vuoto).
  const res = await request.get(`/api/topics`, { ignoreHTTPSErrors: true });
  const body = await res.json();
  sessionKeyA = (body.topics ?? {})[a.id]?.sessionKey ?? "";
  if (!sessionKeyA) throw new Error("la topic non ha sessionKey: senza, il loader non si accende");
});

test.afterAll(async ({ request }) => {
  for (const t of [a, b]) await deleteTopic(request, t.id).catch(() => {});
});

/**
 * Apre due tab, accende sulla PRIMA (che resta inattiva, quindi può portare il
 * badge) sia il conteggio di notifica sia un turno in corso — cioè lo stato in
 * cui la coda della tab è piena e i tre widget convivono.
 */
async function tabCarica(page: Page) {
  const ws = await interceptWebSocket(page);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(a.name));
  await openTopic(page, new RegExp(b.name));
  const tab = page.locator(`[data-pane-id="${a.id}"]`);
  await expect(tab).toBeVisible({ timeout: 15000 });
  ws.send({ type: "unread:updated", topicId: a.id, unreadCount: 3 });
  ws.send({ type: "stream:start", sessionKey: sessionKeyA, topicId: a.id, messageId: "geo_probe" });
  await expect(tab.locator("span").filter({ hasText: /^3$/ })).toBeVisible({ timeout: 8000 });
  await expect(tab.locator("[data-loader-state]")).toBeVisible({ timeout: 8000 });
  return tab;
}

interface Misura {
  tab: { w: number; h: number };
  label: Riquadro | null;
  labelInk: Inchiostro | null;
  loader: Riquadro | null;
  loaderGlifo: Riquadro | null;
  badge: Riquadro | null;
  badgeInk: Inchiostro | null;
  comando: Riquadro | null;
}
interface Riquadro { w: number; h: number; sx: number; dx: number; dCentro: number }
interface Inchiostro { dCentro: number; inkSx: number; inkDx: number }

async function misura(page: Page, paneId: string): Promise<Misura> {
  return page.evaluate((id) => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const tab = document.querySelector(`[data-pane-id="${CSS.escape(id)}"]`) as HTMLElement;
    const rt = tab.getBoundingClientRect();
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        w: r2(r.width), h: r2(r.height),
        sx: r2(r.left - rt.left), dx: r2(rt.right - r.right),
        dCentro: r2(r.top + r.height / 2 - (rt.top + rt.height / 2)),
      };
    };
    // L'INCHIOSTRO di un testo, non la sua scatola: baseline dedotta dal box del
    // testo più le metriche del font, poi centro ottico dei glifi EFFETTIVI.
    // È l'unico modo di vedere il difetto — la scatola era centrata benissimo.
    const ink = (el: Element | null) => {
      if (!el) return null;
      const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rr = range.getBoundingClientRect();
      const cs = getComputedStyle(el as HTMLElement);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
      const mm = ctx.measureText(node.textContent!.trim());
      const baseline = rr.top + mm.fontBoundingBoxAscent;
      const centro = (baseline - mm.actualBoundingBoxAscent + baseline + mm.actualBoundingBoxDescent) / 2;
      const r = el.getBoundingClientRect();
      return {
        dCentro: r2(centro - (r.top + r.height / 2)),
        inkSx: r2(rr.left - mm.actualBoundingBoxLeft - r.left),
        inkDx: r2(r.right - (rr.left + mm.actualBoundingBoxRight)),
      };
    };
    const loader = tab.querySelector("[data-loader-state]");
    return {
      tab: { w: r2(rt.width), h: r2(rt.height) },
      label: box(tab.querySelector('[data-testid="pane-tab-label"]')),
      labelInk: ink(tab.querySelector('[data-testid="pane-tab-label"]')),
      loader: box(loader),
      loaderGlifo: box(loader?.querySelector("span") ?? null),
      badge: box(tab.querySelector("span.rounded-full.bg-primary")),
      badgeInk: ink(tab.querySelector("span.rounded-full.bg-primary")),
      comando: box(tab.querySelector(".row-actions")),
    };
  }, paneId);
}

test.describe("I widget in coda a una tab", () => {
  test("GEO-1: il cerchio di chiusura atterra ESATTAMENTE sul badge che sostituisce", async ({ page, request }) => {
    await resetPaneStore(request, [a.id, b.id]);
    const tab = await tabCarica(page);
    const riposo = await misura(page, a.id);
    // Il binario dei comandi si scopre solo col mouse sopra.
    await tab.hover();
    await page.waitForTimeout(200);
    const sopra = await misura(page, a.id);

    expect(riposo.badge!.dx, "il badge si ferma a ROW_PX dal bordo").toBe(ROW_PX);
    // La scatola del comando è più grande del suo glifo: è l'incasso del GLIFO
    // che deve valere ROW_PX, non quello della scatola.
    const glifoDx = sopra.comando!.dx + (sopra.comando!.w - GLIFO) / 2;
    expect(glifoDx, "il glifo del comando si ferma dove si ferma il badge").toBe(ROW_PX);
    // …e allora i due occupano lo STESSO rettangolo: niente salto sotto il dito.
    expect(glifoDx).toBe(riposo.badge!.dx);
    expect(sopra.comando!.dCentro, "comando centrato in verticale").toBe(0);
  });

  test("GEO-2: nessuna riga di testo nasce su un frammento di pixel", async ({ page, request }) => {
    await resetPaneStore(request, [a.id, b.id]);
    await tabCarica(page);
    const m = await misura(page, a.id);
    // È la causa: (28 − 19,5) / 2 = 4,25 per l'etichetta, (16 − 11) / 2 = 2,5 per
    // il numero. Con altezze pari dentro contenitori pari il conto è intero e il
    // rasterizzatore ha una griglia su cui posarsi.
    const interoMezzo = (n: number) => Number.isInteger(n * 2);
    expect(interoMezzo((m.tab.h - m.label!.h) / 2), `etichetta alta ${m.label!.h} in una tab da ${m.tab.h}`).toBe(true);
    expect(m.label!.dCentro, "etichetta centrata in verticale").toBe(0);
  });

  test("GEO-3: il numero sta al centro del pallino, sui due assi", async ({ page, request }) => {
    await resetPaneStore(request, [a.id, b.id]);
    await tabCarica(page);
    const m = await misura(page, a.id);
    expect(m.badge!.w, "pallino").toBe(16);
    expect(m.badge!.h).toBe(16);
    // Mezzo pixel di tolleranza: sotto quella soglia non c'è niente da vedere
    // nemmeno su uno schermo a densità doppia. Prima erano 0,62px in basso.
    expect(Math.abs(m.badgeInk!.dCentro), "cifra rispetto al centro verticale").toBeLessThan(0.5);
    expect(Math.abs(m.badgeInk!.inkSx - m.badgeInk!.inkDx), "cifra rispetto al centro orizzontale").toBeLessThan(0.5);
  });

  test("GEO-4: il glifo del loader nasce su coordinate intere", async ({ page, request }) => {
    await resetPaneStore(request, [a.id, b.id]);
    await tabCarica(page);
    const m = await misura(page, a.id);
    // La matrice vecchia era larga 7,5 in una scatola da 16 → margine 4,25, e un
    // quadrato da 3px su un quarto di pixel non ha bordi: ha due colonne
    // sbiadite. L'onda è 10×12 in 16 → 3 e 2, interi.
    const margineX = (m.loader!.w - m.loaderGlifo!.w) / 2;
    const margineY = (m.loader!.h - m.loaderGlifo!.h) / 2;
    expect(Number.isInteger(margineX), `glifo largo ${m.loaderGlifo!.w} in una scatola da ${m.loader!.w}`).toBe(true);
    expect(Number.isInteger(margineY), `glifo alto ${m.loaderGlifo!.h} in una scatola da ${m.loader!.h}`).toBe(true);
    expect(m.loader!.dCentro, "loader centrato in verticale").toBe(0);
  });
});
