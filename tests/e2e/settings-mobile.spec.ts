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
 *  · che ogni modulo (Piano e Macchine, livelli del menu utente; Provider e
 *    chiavi, Strumenti MCP, Calendario, pannelli dove si usano dal 03/10/2026)
 *    sia un foglio largo quanto lo schermo, senza scorrimento ORIZZONTALE;
 *  · che ogni bersaglio toccabile dentro ciascun foglio sia ≥ 44px;
 *  · che NON esista un solo `<select>` nativo in pagina;
 *  · che i comandi sugli split — che sotto i 768px non fanno niente, perché
 *    `PanelGrid` a quella larghezza non disegna affatto gli split — non
 *    compaiano nel menu, e che a 1280 ci siano ancora tutti;
 *  · che la lingua si cambi davvero e la scelta sopravviva a un reload.
 *
 * `hasTouch` non è un dettaglio: le soglie da 44px sono dietro la variante
 * `coarse:` (`any-pointer: coarse`), che senza il segnale touch non si accende —
 * la spec misurerebbe la UI da mouse e passerebbe dicendo il falso.
  * @covers SETMOB-01
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openHomePanel, openUserMenuLevel } from "./helpers/user-menu";
import { beat, didascalia, isEvidenceRun } from "./helpers/evidence";
import { readFileSync } from "fs";
import { join } from "path";

hermetic(test);

test.use({
  viewport: { width: 390, height: 844 },
  locale: 'it-IT',
  hasTouch: true,
  isMobile: true,
});

const AUDIT_JS = readFileSync(join(__dirname, "helpers", "ui-audit.js"), "utf8");

/** Where each form's sheet is: a level of the user menu, or a panel of the
 *  host of the forms that live where they are used (SETHOME-01). */
const SHEET_ID: Record<Level, string> = {
  plan: "topics-menu-plan",
  nodes: "devices-machines",
  providers: "home-panel-providers",
  tools: "home-panel-tools",
  calendar: "home-panel-calendar",
};

/**
 * Opens one form and WAITS FOR THE SHEET TO SETTLE.
 *
 * On the phone a level of the user menu and a panel of the forms' host are
 * both sheets that slide up from the bottom. Measuring while it slides returns
 * a geometry that changes every frame, so the wait is for the fact: the
 * transform back to the identity.
 */
async function openFormLevel(page: Page, level: Level) {
  const opened = level === "plan" || level === "nodes"
    ? await openUserMenuLevel(page, level)
    : await openHomePanel(page, level);
  // «Provider e chiavi» hands back its levels: the sheet is the panel around them.
  const sheet = level === "providers" ? page.getByTestId(SHEET_ID.providers) : opened;
  await expect
    .poll(() => sheet.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 })
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  // The form is a chunk of its own: measure it, not its loading placeholder.
  await expect(level === "providers" ? sheet.getByTestId("providers-level") : sheet.getByTestId(`${SHEET_ID[level]}-form`)).toBeVisible();
  await page.waitForTimeout(300);
  return sheet;
}

/** Closes a sheet: the panel with one Escape, a level and its menu with as
 *  many as it takes. */
async function closeSheet(page: Page, sheet: import("@playwright/test").Locator) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(async () => {
    if (await page.getByTestId("sidebar-topics-menu-panel").count() === 0) return;
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
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
/**
 * THE FINGER COMES FROM THE CONTEXT, and this checks it is actually there.
 *
 * There used to be an `emulaIlDito` here calling `Emulation.setEmulatedMedia`
 * with `pointer`/`any-pointer` features. Chrome ignores those names in that
 * command - it emulates `prefers-color-scheme` and friends, not the pointer -
 * so the call returned cleanly and changed nothing. Measured on a page WITHOUT
 * `hasTouch`: right after it, `matchMedia("(any-pointer: coarse)").matches` was
 * still false. It was doing no work, and it read like it was.
 *
 * What really turns the finger on is `test.use({ hasTouch, isMobile })` at the
 * top of this file. The check below is what makes that visible: `coarse:` gates
 * 67 rules in this app, so if the context ever stopped providing a coarse
 * pointer, this spec would go on measuring a DESKTOP squeezed into 390px while
 * its name promised a finger - and it would keep passing, because desktop
 * controls clear 44px until one of them does not.
 */
/** A guard that cannot silently measure the wrong device again. */
async function theFingerIsReal(page: Page) {
  const media = await page.evaluate(() => ({
    any: matchMedia("(any-pointer: coarse)").matches,
    pointer: matchMedia("(pointer: coarse)").matches,
  }));
  expect(
    media.any,
    `la variante \`coarse:\` e' definita su (any-pointer: coarse): senza, questa spec misura un desktop stretto e le sue misure non dicono niente sul tocco (letto: ${JSON.stringify(media)})`,
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await theFingerIsReal(page);
  await expect(page.getByTestId("sidebar-topics-menu")).toBeVisible({ timeout: 15_000 });
});

/**
 * Every form: the two the user menu keeps (plan; machines, inside devices) and
 * the three that live where they are used (providers, tools, calendar).
 *
 * A fixed list does not go red when a form is added, it just measures less
 * while the comment keeps saying "all of them": the test compares the menu's
 * form rows with the two this list says it keeps.
 */
const LEVELS = ["plan", "nodes", "providers", "tools", "calendar"] as const;
type Level = (typeof LEVELS)[number];

test("a 390px ogni modulo è un foglio largo quanto lo schermo, senza bersagli sotto i 44px", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SETMOB-01" });
  await page.getByTestId("sidebar-topics-menu").click();
  const menu = page.getByTestId("sidebar-topics-menu-panel");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  // The form rows the menu has: the plan only (the machines are inside
  // Devices, the other three left the menu, SETHOME-01).
  const rows = await menu.locator('[data-testid^="topics-menu-"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => /^topics-menu-(plan|nodes|providers|tools|calendar)$/.test(id)));
  expect(rows, "the form rows of the menu").toEqual(["topics-menu-plan"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("topics-menu-settings")).toHaveCount(0);
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);

  //    EVERY level is measured before anything is asserted: failing inside the
  //    loop stops at the first bad one and hides the others.
  await page.addScriptTag({ content: AUDIT_JS });
  const belowThreshold: Record<string, unknown> = {};
  const horizontalScroll: string[] = [];
  const outside: Record<string, unknown> = {};
  for (const level of LEVELS) {
    const sheet = await openFormLevel(page, level);
    // In the screen and as wide as it: the DOM's own geometry, not
    // `boundingBox()`, which under mobile emulation reports coordinates
    // already scaled by the page factor.
    const box = await sheet.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, vw: window.innerWidth };
    });
    if (box.left < 0 || box.right > box.vw + 1 || box.right - box.left < box.vw - 1) outside[level] = box;
    const audit = await page.evaluate((scope) => {
      const fn = (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit;
      return JSON.parse(fn({ scope, minTap: 44 }));
    }, level === "plan" || level === "nodes" ? `[data-testid="${SHEET_ID[level]}-menu"]` : `[data-testid="${SHEET_ID[level]}"]`);
    const tap = (audit.findings?.tapTargets ?? []) as Array<{ el: string; w: number; h: number }>;
    if (tap.length > 0) belowThreshold[level] = tap;
    if (audit.overflowX?.present) horizontalScroll.push(level);
    await closeSheet(page, sheet);
  }
  expect(outside, "fogli fuori dallo schermo o più stretti").toEqual({});
  expect(belowThreshold, "bersagli sotto i 44px, per livello").toEqual({});
  expect(horizontalScroll, "livelli con scorrimento orizzontale").toEqual([]);

  // The delivery's two shots: the same level, two widths, only under
  // `E2E_EVIDENCE=1`.
  if (isEvidenceRun()) {
    await openFormLevel(page, "providers");
    await didascalia(page, "Provider AI a 390px");
    await beat(page);
    await page.screenshot({ path: "test-results/evidence/settings-390.png" });
  }
});

test("nessun <select> di sistema in pagina, e la lingua si cambia col menu dell'app", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SETMOB-01" });
  // The language lives in the user menu's Appearance level now, which on the
  // phone is a sheet of the title menu.
  await openUserMenuLevel(page, "appearance");

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
  await theFingerIsReal(page);
  await expect(page.getByTestId("sidebar-topics-menu")).toBeVisible({ timeout: 15_000 });
  await openUserMenuLevel(page, "appearance");
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
  test.info().annotations.push({ type: "spec", description: "SETMOB-01" });
  const menu = page.getByTestId("sidebar-topics-menu");

  // A 390px: assenti. Non grigi — ASSENTI: la condizione che li sbloccherebbe
  // è lo schermo, e non c'è niente da sbloccare.
  await menu.click();
  // Sul foglio a due piani (A1) la Vista sta al piano Topics: ci si scende.
  await page.getByTestId("user-menu-topics-entry").click();
  const openMenu = page.getByTestId("topics-menu-view");
  await expect(openMenu).toBeVisible();
  // The whole GROUP is absent, which is the same fact one level up: the two
  // commands live in the «Pannelli» level (STATUSLINE-05), and where panels do
  // not exist there is no level to open.
  await expect(page.getByTestId("topics-menu-panels")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reimposta pannelli|Reset panels/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Disponi automaticamente|Arrange automatically/ })).toHaveCount(0);
  await didascalia(page, "390px: niente comandi sui pannelli");
  await beat(page);
  await page.keyboard.press("Escape");

  // A 1280px: tornano, perché lì i pannelli esistono davvero. Senza questo la
  // spec proverebbe solo che qualcosa è sparito, che è metà del fatto.
  await page.setViewportSize({ width: 1280, height: 800 });
  // Not the title any more: at desktop width the door is the user card at
  // the foot of the column (SIDEBAR-STATUS-01), and the helper picks the
  // trigger from the viewport.
  await openProfileMenu(page);
  await page.getByTestId("topics-menu-panels").click();
  await expect(page.getByRole("button", { name: /Reimposta pannelli|Reset panels/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Disponi automaticamente|Arrange automatically/ })).toBeVisible();
  await didascalia(page, "1280px: ci sono, perché lì hanno effetto");
  await beat(page);
});
