/**
 * Le righe di chrome stanno sullo STESSO terreno del contenuto.
 *
 * «Dovrebbe esserci continuità di sfondi fra contenuto e tabbar» (Attilio,
 * 09/08). Non c'era, e in tutte e quattro le combinazioni. Campionando il pixel
 * dipinto a y=0..73 (le due righe) contro y=74 (il contenuto):
 *   scuro  web  #0e0f12 contro #1b1c1d  → 13
 *   scuro  mac  #090b11 contro #0c0d12  →  3
 *   chiaro web  #f1f2f3 contro #ffffff  → 14
 *   chiaro mac  #eceff3 contro #f0f2f5  →  4
 * e sulla finestra Tauri vera, con la vibrancy vera sotto: #16181b contro
 * #242527, cioè 14 livelli di gradino sul bordo basso della barra.
 *
 * La causa: il velo portava la tinta del CHROME (un quasi-nero) su una
 * superficie che è un'altra cosa. Tinta ≠ base ⇒ il velo sposta il colore.
 *
 * L'invariante che si ancora qui è la forma generale del rimedio, non il numero
 * che ne esce: IL VELO PORTA LA TINTA DELLA SUPERFICIE SU CUI GALLEGGIA. Con
 * tinta = base lo scarto è zero per costruzione a qualunque alpha, quindi
 * nessuno può rimetterlo dentro alzando o abbassando l'opacità. Un'asserzione
 * sul pixel dipinto direbbe la stessa cosa più debolmente: passerebbe anche con
 * due colori diversi che per caso compongono vicino, e servirebbe un decoder
 * PNG che questo repo non ha (e non deve avere: niente librerie di test nuove).
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-continuita-${Date.now()}`;

/** `rgba(...)` oppure `color(srgb ...)` → [r,g,b,a] su 0-255.
 *  Chromium calcola un `color-mix()` come `color(srgb 0.105 … / 0.72)`, non
 *  come `rgba()`: un parser che conosce solo la seconda forma non fallisce
 *  sull'invariante, fallisce sulla sintassi — e sembra lo stesso rosso. */
function rgba(s: string): [number, number, number, number] {
  const srgb = s.match(/color\(srgb\s+([^)]+)\)/);
  if (srgb) {
    const p = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
    return [Math.round(p[0] * 255), Math.round(p[1] * 255), Math.round(p[2] * 255), p.length > 3 ? p[3] : 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`colore non riconosciuto: ${s}`);
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** Legge un token come colore RISOLTO: `color-mix()` resta simbolico in
 *  `getPropertyValue`, quindi lo si fa calcolare a un elemento vero. */
async function tinte(page: Page) {
  return page.evaluate(() => {
    const sonda = document.createElement("div");
    sonda.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px";
    document.body.appendChild(sonda);
    const risolvi = (v: string) => {
      sonda.style.backgroundColor = "";
      sonda.style.backgroundColor = v;
      return getComputedStyle(sonda).backgroundColor;
    };
    const out = {
      velo: risolvi("var(--chrome-overlay-bg)"),
      superficie: risolvi("var(--bg-surface)"),
    };
    sonda.remove();
    return out;
  });
}

async function barre(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".pane-chrome-bar"));
    return els.map((e) => ({
      annidata: !!e.parentElement?.closest(".chrome-glass"),
      bg: getComputedStyle(e).backgroundColor,
    }));
  });
}

/**
 * Put the document in the requested shell/theme and WAIT UNTIL IT IS THERE.
 *
 * Each of these toggles used to be followed by a fixed 120-150 ms sleep. The
 * thing it was waiting for is a state, not a duration: the app re-renders on a
 * class change and can put its own classes back, so the honest wait is "the
 * document really is in this shell". A sleep would pass on a document that had
 * already reverted; this fails, which is the point.
 */
async function shell(page: Page, opts: { mac: boolean; dark: boolean }): Promise<void> {
  await page.evaluate(({ mac, dark }) => {
    document.documentElement.classList.toggle("electron-mac", mac);
    document.documentElement.classList.toggle("dark", dark);
  }, opts);
  await page.waitForFunction(
    ({ mac, dark }) =>
      document.documentElement.classList.contains("electron-mac") === mac &&
      document.documentElement.classList.contains("dark") === dark,
    opts,
    { timeout: 5_000 },
  );
}

test.describe("continuità: le righe di chrome e il contenuto", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(`${PROJ}/README.md`, "uno\n");
  });
  test.afterAll(() => rmSync(PROJ, { recursive: true, force: true }));

  test.beforeEach(async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`)).toHaveCount(1, { timeout: 15000 });
  });

  for (const tema of ["dark", "light"] as const) {
    test(`CONT-1 (${tema}): la riga di chrome NON dipinge — il vetro è il blur`, async ({ page }) => {
      await shell(page, { mac: false, dark: tema === "dark" });

      // Il velo è passato per tre forme: la tinta del CHROME (che spostava il
      // colore, da cui il gradino di 13-14 livelli), poi la tinta della
      // SUPERFICIE sotto (scarto zero per costruzione), e infine nessuna tinta
      // — perché stendere un colore su se stesso non serviva a niente che il
      // `backdrop-filter` non facesse già. «Il bg tabbar doveva essere
      // trasparente così appariva tutto in floating» (Attilio, 09/08).
      const { velo } = await tinte(page);
      expect(rgba(velo)[3], `il velo deve essere trasparente (${velo})`).toBe(0);

      // E il blur resta: è LUI a rendere leggibili i nomi delle tab mentre
      // sotto passano i messaggi. Senza, questa non è una barra che galleggia,
      // è una barra che non c'è.
      const sfocatura = await page.locator(".pane-chrome-bar").first()
        .evaluate((el) => getComputedStyle(el).backdropFilter);
      expect(sfocatura, "la barra deve continuare a sfocare ciò che le passa sotto").toMatch(/blur/);
    });
  }

  test("CONT-2: sotto la shell mac nessuna riga dipinge — né la prima né quella annidata", async ({ page }) => {
    await shell(page, { mac: true, dark: true });

    const righe = await barre(page);
    expect(righe.length, "servono almeno due righe di chrome per confrontarle").toBeGreaterThanOrEqual(2);
    // Almeno una di primo livello e una annidata: è la coppia che divergeva.
    expect(new Set(righe.map((r) => r.annidata)).size, `annidamento delle righe: ${JSON.stringify(righe)}`).toBe(2);

    for (const r of righe) {
      const a = rgba(r.bg)[3];
      expect(
        a,
        `una riga ${r.annidata ? "annidata" : "di primo livello"} dipinge ${r.bg}: sotto la shell il terreno è la vibrancy, e ogni tinta stesa sopra è un gradino`,
      ).toBe(0);
    }
  });

  test("CONT-3: sotto la shell dipinge UNA superficie sola — il guscio della finestra", async ({ page }) => {
    await shell(page, { mac: true, dark: true });

    // La tinta di una superficie non deve dipendere da DOVE sta nell'albero: è
    // stata la causa di ogni divergenza di questa famiglia (la barra annidata
    // contro quella di primo livello, la sidebar contro il contenuto). Con un
    // solo pittore la domanda non si pone più — e questa è l'unica asserzione
    // che se ne accorge quando qualcuno ne aggiunge un secondo, invece di
    // scoprirlo misurando un pixel mesi dopo.
    const pittori = await page.evaluate(() => {
      const out: string[] = [];
      const visita = (el: Element) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgba?\(([^)]+)\)/);
        const p = m ? m[1].split(/[,\s/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0];
        const a = p.length > 3 ? p[3] : 1;
        const r = el.getBoundingClientRect();
        // Solo le SUPERFICI: una card o un bottone dipingono per mestiere.
        if (a > 0 && r.width * r.height > 40000) {
          out.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().trim().split(/\s+/).slice(0, 3).join(".")} ${bg} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        for (const c of Array.from(el.children)) visita(c);
      };
      visita(document.documentElement);
      return out;
    });

    expect(pittori, `superfici che dipingono sotto la shell:\n${pittori.join("\n")}`).toHaveLength(1);
  });
});
