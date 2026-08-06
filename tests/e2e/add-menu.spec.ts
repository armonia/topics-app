import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * ADD-MENU — il menu "New…" come SISTEMA, non come utility.
 *
 * Venti spec usano già questo menu per creare pane, ma nessuna verificava il
 * menu in sé: erano tutte click ciechi su un testid. In quel punto cieco sono
 * vissuti tre difetti insieme (audit 2026-08-06):
 *
 *   1. "New Chat" spariva da TUTTI e sei gli host quando `enableNewChat` era
 *      salvato a false — un flag di preferenza che poteva solo rompere.
 *   2. ⌘N non chiudeva niente: un dropdown aperto restava su e la palette si
 *      aggiungeva alla pila. Misurato: 1 menu → ⌘N → 2 menu contemporanei.
 *   3. La palette era `z-[60]` contro i 9999 di ogni popover: finiva SOTTO il
 *      dropdown rimasto aperto, e sotto il proprio velo.
 *
 * Più il debito che li rendeva possibili: il menu non passava dalla primitiva
 * `Menu`, quindi niente `role="menu"`, niente fuoco nel pannello, niente
 * frecce — e senza fuoco nel pannello le lettere non sarebbero intercettabili.
 */

const PROJECT_DIR = "/tmp/e2e-add-menu";

test.describe.serial("Add menu — sistema", () => {
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, "E2E-AddMenu", { projectPath: PROJECT_DIR });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("ADD-01: New Chat c'è, e non dipende da nessun interruttore", async ({ page, request }) => {
    // Il gate `enableNewChat` è stato rimosso: anche seminando il valore che
    // PRIMA lo spegneva, la riga deve esserci. È il pin del bug 1 — un client
    // con quel false salvato mostrava sette voci su otto e nessuna diagnosi.
    await resetPaneStore(request, []);
    await page.addInitScript(() =>
      localStorage.setItem("app-settings", JSON.stringify({ enableNewChat: false })),
    );
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.getByTestId("pane-add-menu-trigger").first().click();
    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("pane-add-menu-new-chat")).toBeVisible();
    // …e le voci che ⌘K non offriva prima dell'unificazione.
    await expect(menu.getByTestId("pane-add-menu-opencode")).toBeVisible();
    await expect(menu.getByTestId("pane-add-menu-browser")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("ADD-02: ⌘N non impila — un solo menu aperto alla volta", async ({ page, request }) => {
    // Serve una tab bar, cioè una pane aperta: il "+" della barra è un
    // DROPDOWN, mentre quello dell'header è la palette che ⌘N stessa apre —
    // partire da lì misurerebbe un toggle, non l'impilamento.
    await resetPaneStore(request, [topicId!]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    const tabBarPlus = page.locator('[data-testid="pane-add-menu-trigger"][title="Add pane"]').first();
    await expect(tabBarPlus).toBeVisible({ timeout: 10_000 });
    await tabBarPlus.click();
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(1);
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);

    // …poi ⌘N. Prima erano DUE menu insieme, col dropdown disegnato sopra la
    // palette. Ora il dropdown cede il posto. Regola: lib/popoverRegistry.
    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(1);
  });

  test("ADD-03: la palette sta SOPRA i popover, non sotto", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+n");
    const palette = page.getByTestId("pane-add-palette");
    await expect(palette).toBeVisible();

    // Il numero, non l'apparenza: un popover vale Z_POPOVER (9999), un modale
    // Z_MODAL (10000). Con `z-[60]` la palette finiva 9939 sotto un dropdown.
    const z = await palette.evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10));
    expect(z).toBeGreaterThan(9999);
    await page.keyboard.press("Escape");
  });

  test("ADD-04: il menu è un menu — role, fuoco e frecce", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    const trigger = page.getByTestId("pane-add-menu-trigger").first();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = page.getByTestId("pane-add-menu");
    await expect(menu).toHaveAttribute("role", "menu");

    // Il fuoco entra nel pannello: è il prerequisito delle lettere, non un
    // dettaglio a11y. Senza, un tasto nudo non arriverebbe mai al menu.
    const focusInside = await menu.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement),
    );
    expect(focusInside).toBe(true);

    // ↓ porta il fuoco sulla prima riga.
    await page.keyboard.press("ArrowDown");
    const onRow = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid")?.startsWith("pane-add-menu-") ?? false,
    );
    expect(onRow).toBe(true);
    await page.keyboard.press("Escape");
  });

  test("ADD-05: la lettera nuda apre la voce — ⌘N poi B = browser", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    // La riga dichiara la sua lettera in modo verificabile, non solo dipinta.
    await expect(page.getByTestId("pane-add-menu-browser")).toHaveAttribute("data-mnemonic", "B");
    await page.keyboard.press("b");

    await expect(page.getByTestId("browser-url-input")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);
  });

  test("ADD-07: il chip è disegnato dove è stato deciso — a destra, uno per riga", async ({ page, request }) => {
    // Misura, non impressione: il repo giudica la geometria dal DOM, non da un
    // pixel. Quello che va pinnato è che la lettera esista come elemento, sia
    // UNA sola per riga, e stia nella colonna destra — cioè il disegno scelto
    // (chip .kbd a fine riga), non uno qualunque che «sembra giusto».
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();

    const rows = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="pane-add-menu"]')!;
      const box = panel.getBoundingClientRect();
      return Array.from(panel.querySelectorAll<HTMLElement>('[data-testid^="pane-add-menu-"]')).map((row) => {
        const kbds = row.querySelectorAll("kbd");
        const label = row.querySelector("span");
        const r = row.getBoundingClientRect();
        const k = kbds[0]?.getBoundingClientRect();
        return {
          testid: row.getAttribute("data-testid"),
          kbdCount: kbds.length,
          // distanza del chip dal bordo destro della riga
          gapRight: k ? Math.round(r.right - k.right) : null,
          // il chip sta DOPO l'etichetta, non prima
          afterLabel: !!(k && label) && k.left >= label!.getBoundingClientRect().right,
          overflows: Math.round(r.right) > Math.round(box.right) + 1,
        };
      });
    });

    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.kbdCount, `${r.testid}: un chip e uno solo`).toBe(1);
      expect(r.afterLabel, `${r.testid}: il chip sta a destra dell'etichetta`).toBe(true);
      // Stessa colonna per tutte: il padding di riga è px-3 (12px).
      expect(r.gapRight, `${r.testid}: chip incollato al bordo destro`).toBeLessThanOrEqual(14);
      expect(r.overflows, `${r.testid}: la riga non sfora il pannello`).toBe(false);
    }
    await page.keyboard.press("Escape");
  });

  test("ADD-06: il chip non entra nel nome accessibile della riga", async ({ page, request }) => {
    // `getByRole('button', { name: 'Shell', exact: true })` esiste in
    // terminal-tab-reload.spec.ts: se il chip finisse nel nome accessibile
    // diventerebbe "Shell S" e quella spec smetterebbe di trovare il bottone.
    // Per gli screen reader la lettera passa da `aria-keyshortcuts`.
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.getByTestId("pane-add-menu-trigger").first().click();
    const shell = page.getByTestId("pane-add-menu-shell");
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("aria-keyshortcuts", "S");
    const name = await shell.evaluate((el) => (el.textContent || "").trim());
    // Il chip è nel testo (`aria-hidden` non lo toglie da textContent), ma NON
    // nel nome accessibile: la riga si chiama ancora esattamente "Shell".
    expect(name.startsWith("Shell")).toBe(true);
    await expect(page.getByRole("menuitem", { name: "Shell", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
  });
});
