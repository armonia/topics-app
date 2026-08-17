/**
 * settings-mobile.spec.ts — le Impostazioni su un telefono, misurate.
 *
 * Due segnalazioni dal telefono, stessa superficie:
 *  1. «Le settings non sono responsive e mi mostrano opzioni tipo "reimposta
 *     pannelli" e "disponibilità automatica", che lì non mi sembrano utili.»
 *  2. «Anche il selettore della lingua è fatto male: è un componente nativo di
 *     default del sistema.»
 *
 * Questa spec È il criterio di accettazione, non un controllo a occhio. Misura,
 * a 390×844 con `hasTouch`:
 *  · che il pannello non produca scorrimento ORIZZONTALE (era `max-w-[760px]`
 *    con dentro una nav larga 180 fissi: a 390 restavano 178px di contenuto);
 *  · che ogni bersaglio toccabile dentro il pannello sia ≥ 44px;
 *  · che NON esista un solo `<select>` nativo in pagina;
 *  · che i comandi sugli split — che sotto i 768px non fanno niente, perché
 *    `PanelGrid` a quella larghezza non disegna affatto gli split — non
 *    compaiano nel menu, e che a 1280 ci siano ancora tutti;
 *  · che la lingua si cambi davvero e la scelta sopravviva a un reload.
 *
 * `hasTouch` non è un dettaglio: le soglie da 44px sono dietro la variante
 * `coarse:` (`any-pointer: coarse`), che senza il segnale touch non si accende —
 * la spec misurerebbe la UI da mouse e passerebbe dicendo il falso.
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia, isEvidenceRun } from "./helpers/evidence";
import { readFileSync } from "fs";
import { join } from "path";

hermetic(test);

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const AUDIT_JS = readFileSync(join(__dirname, "helpers", "ui-audit.js"), "utf8");

/**
 * Apre le Impostazioni e ASPETTA CHE IL PANNELLO SIA FERMO.
 *
 * `MODAL_PANEL` porta `command-palette-enter`, cioè `commandPaletteIn 0.15s`,
 * che è un'animazione di SCALA. Misurare mentre corre restituisce la geometria
 * moltiplicata per un fattore che cambia a ogni frame: un controllo alto 44
 * tornava 43,41 · 43,78 · 43,86 in tre passate, cioè un rosso che parlava del
 * fotogramma catturato e non della UI — ed era anche l'origine dell'unico test
 * intermittente di questo file.
 *
 * `reducedMotion: reduce` (impostato per tutta la suite) NON la ferma: quella
 * preferenza spegne le transizioni che il progetto ha legato alla media query,
 * e questa animazione non è fra quelle. Quindi si aspetta il fatto: la matrice
 * di trasformazione tornata all'identità.
 */
async function apriImpostazioni(page: Page) {
  await page.getByTestId("sidebar-topics-menu").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const pannello = page.getByTestId("settings-panel");
  await expect(pannello).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => pannello.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 })
    .toBe("none");
}

/**
 * IL DITO, IN CSS.
 *
 * `hasTouch`/`isMobile` di Playwright accendono `navigator.maxTouchPoints` e
 * `pointer: coarse`, ma NON `any-pointer: coarse` — misurato: la variante
 * `coarse:` dell'app (dichiarata in `index.css` proprio su `any-pointer`, e per
 * la ragione scritta lì) restava spenta, quindi la spec misurava la UI DA MOUSE
 * e avrebbe dichiarato sotto soglia bersagli che su un telefono vero sono a
 * norma. È il caso peggiore di un test: preciso e sul soggetto sbagliato.
 *
 * Su un iPhone entrambe le feature sono `coarse` (non c'è nessun altro
 * puntatore), quindi qui si emulano tutt'e due via CDP. Va rifatto DOPO ogni
 * `goto`/`reload`: l'override sta sulla sessione, non sul documento.
 */
async function emulaIlDito(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "any-pointer", value: "coarse" },
      { name: "hover", value: "none" },
      { name: "any-hover", value: "none" },
    ],
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await emulaIlDito(page);
  await expect(page.getByTestId("sidebar-topics-menu")).toBeVisible({ timeout: 15_000 });
});

/** Le cinque schede del pannello, nell'ordine in cui la nav le elenca. */
const SCHEDE = ["Aspetto", "Notifiche", "Provider AI", "Profilo", "Piano"];

test("a 390px il pannello sta nello schermo e non ha bersagli sotto i 44px", async ({ page }) => {
  await apriImpostazioni(page);
  await didascalia(page, "Impostazioni a 390px");
  await beat(page);

  // 1. Nessuno scorrimento orizzontale, né sul pannello né sulla colonna che
  //    porta il contenuto. Si misura lo scarto scroll/client, che è il fatto —
  //    non «sembra stretto».
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="settings-panel"]');
    if (!panel) return null;
    const nodi = [panel, ...Array.from(panel.querySelectorAll("*"))] as HTMLElement[];
    return nodi
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      // La riga delle schede scorre in orizzontale DI PROPOSITO: è la
      // navigazione, e il suo scorrimento è il modo in cui cinque schede
      // stanno su uno schermo da 390.
      .filter((el) => el.tagName !== "NAV")
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") || "").slice(0, 60),
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
  });
  expect(overflow).toEqual([]);

  // 2. Il pannello non esce dal viewport.
  //
  //    `getBoundingClientRect` dentro la pagina e NON `boundingBox()` di
  //    Playwright: sotto l'emulazione mobile quest'ultimo riporta le coordinate
  //    già moltiplicate per il fattore di scala della pagina, e su questo
  //    viewport la scala non è esattamente 1 — misurato: un controllo alto 44
  //    tornava 43,775, cioè un rosso che parlava dell'emulatore, non della UI.
  //    La geometria vera è quella del DOM, la stessa che legge `ui-audit.js`.
  const box = await page.getByTestId("settings-panel").evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, vw: window.innerWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.vw + 1);

  // 3. Bersagli toccabili: la misura viene da `ui-audit.js`, lo stesso attrezzo
  //    che il progetto usa per gli audit di layout — numeri esatti dal DOM, non
  //    pixel stimati da uno screenshot.
  //    Si inietta come <script>, non con `eval`: il file è un IIFE che installa
  //    `window.__uiAudit`, ed è esattamente il modo in cui è pensato per essere
  //    caricato.
  //    E si passa per TUTTE E CINQUE le schede: la prima è «Aspetto», e
  //    fermarsi lì misurerebbe un quinto del pannello dichiarando di averlo
  //    misurato tutto.
  await page.addScriptTag({ content: AUDIT_JS });
  for (const scheda of SCHEDE) {
    await page.getByTestId("settings-panel").getByRole("button", { name: scheda, exact: true }).click();
    await page.waitForTimeout(200);
    const audit = await page.evaluate(() => {
      const fn = (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit;
      return JSON.parse(fn({ scope: '[data-testid="settings-panel"]', minTap: 44 }));
    });
    const tap = (audit.findings?.tapTargets ?? []) as Array<{ el: string; w: number; h: number }>;
    expect(tap, `«${scheda}» — bersagli sotto i 44px: ${JSON.stringify(tap)}`).toEqual([]);
    expect(audit.overflowX?.present, `«${scheda}» — scorrimento orizzontale`).toBe(false);
  }
  await page.getByTestId("settings-panel").getByRole("button", { name: "Aspetto", exact: true }).click();

  // Le due schermate della consegna: STESSA scheda, due larghezze. Solo sotto
  // `E2E_EVIDENCE=1`, come le clip — nella passata veloce la suite non paga i
  // due screenshot.
  if (isEvidenceRun()) {
    await page.screenshot({ path: "test-results/evidence/settings-390.png" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/evidence/settings-desktop.png" });
  }
});

test("nessun <select> di sistema in pagina, e la lingua si cambia col menu dell'app", async ({ page }) => {
  await apriImpostazioni(page);

  // Il difetto segnalato, misurato: zero `<select>` nativi renderizzati.
  expect(await page.locator("select").count()).toBe(0);

  const trigger = page.getByTestId("settings-language");
  await expect(trigger).toBeVisible();
  // È il selettore DELL'APP: un bottone con il ruolo ARIA del combobox, non un
  // elemento di modulo disegnato dal sistema operativo.
  expect(await trigger.evaluate((el) => el.tagName)).toBe("BUTTON");
  await expect(trigger).toHaveAttribute("role", "combobox");
  // Il bersaglio del dito, sul controllo che ha originato la segnalazione.
  // Misurato nel DOM — vedi la nota sulla scala nell'altro test.
  const h = await trigger.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(44);

  await didascalia(page, "Il selettore lingua è dell'app, non del sistema");
  await beat(page);

  await trigger.click();
  const lista = page.getByRole("listbox", { name: "Lingua · Language" });
  await expect(lista).toBeVisible();
  await didascalia(page, "Si apre il menu disegnato, non la ruota di iOS");
  await beat(page);

  await lista.getByRole("option", { name: "English" }).click();
  await expect(trigger).toHaveText(/English/);
  await didascalia(page, "Lingua → English");
  await beat(page);

  // LA SCELTA SOPRAVVIVE AL RELOAD. È la metà che conta: un selettore che
  // cambia l'etichetta e dimentica non ha cambiato niente.
  await page.reload();
  await emulaIlDito(page);
  await expect(page.getByTestId("sidebar-topics-menu")).toBeVisible({ timeout: 15_000 });
  await apriImpostazioni(page);
  await expect(page.getByTestId("settings-language")).toHaveText(/English/);
  await didascalia(page, "Dopo il reload: ancora English");
  await beat(page);

  // Si rimette com'era: la baseline ermetica è per FILE, e la lingua vive in
  // localStorage, che il reset del DB non tocca.
  await page.getByTestId("settings-language").click();
  await page
    .getByRole("listbox", { name: "Lingua · Language" })
    .getByRole("option", { name: /Automatica/ })
    .click();
});

test("i comandi sui pannelli non compaiono dove non ci sono pannelli", async ({ page }) => {
  const menu = page.getByTestId("sidebar-topics-menu");

  // A 390px: assenti. Non grigi — ASSENTI: la condizione che li sbloccherebbe
  // è lo schermo, e non c'è niente da sbloccare.
  await menu.click();
  const menuAperto = page.getByRole("button", { name: "Settings", exact: true });
  await expect(menuAperto).toBeVisible();
  await expect(page.getByRole("button", { name: "Reimposta pannelli" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disponi automaticamente" })).toHaveCount(0);
  await didascalia(page, "390px: niente comandi sui pannelli");
  await beat(page);
  await page.keyboard.press("Escape");

  // A 1280px: tornano, perché lì i pannelli esistono davvero. Senza questo la
  // spec proverebbe solo che qualcosa è sparito, che è metà del fatto.
  await page.setViewportSize({ width: 1280, height: 800 });
  await menu.click();
  await expect(page.getByRole("button", { name: "Reimposta pannelli" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disponi automaticamente" })).toBeVisible();
  await didascalia(page, "1280px: ci sono, perché lì hanno effetto");
  await beat(page);
});
