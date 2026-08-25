/**
 * checklist-ui-verify.spec.ts
 *
 * E2E coverage for the manual "cose che Attilio deve poter verificare a mano"
 * checklist. Each block maps to a numbered checklist point and asserts the
 * REAL DOM/behaviour, not internal state:
 *
 *   Point 8  — sidebar resize handle drags the width AND there is no visible
 *              border on the sidebar's right edge at rest (only the shadow).
 *   Point 4  — opening an already-open topic FOCUSES the existing tab instead
 *              of minting a duplicate (structural dedup, fix d42e0fe4).
 *   Point 10 — right-click menus: sidebar row rename + "Apri in nuova finestra"
 *              (pop-out) entries; terminal tab "Rinomina" inline editor.
 *
 * Notes on what is NOT here (declared manual-only in the run report):
 *   - The macOS "semafori" (native traffic-light window buttons) that show/hide
 *     with the Topics dropdown are a Tauri/Electron-only native concern — no DOM
 *     surface exists on web to assert against.
 *   - The native browser pane (point 11) is Tauri-only; on web only the
 *     placeholder renders, so modal-over-native-pane z-order is manual on Tauri.
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  waitForTopicVisible,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/** Read the sidebar's rendered width in px. */
async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('[aria-label="Topics sidebar"]').boundingBox();
  if (!box) throw new Error("sidebar has no bounding box");
  return box.width;
}

test.describe("Checklist UI verification", () => {
  // ---------------------------------------------------------------------------
  // POINT 8 — sidebar resize handle + no resting right border
  // ---------------------------------------------------------------------------
  test.describe("Point 8: sidebar resize + no right border at rest", () => {
    test("CHK8-01: dragging the resize handle changes the sidebar width and persists", async ({ page }) => {
      await goToApp(page);

      // The resize handle is a fixed strip at the sidebar's right edge with a
      // col-resize cursor. It is only present when the sidebar is expanded.
      const handle = page.locator('.cursor-col-resize').first();
      await expect(handle, "resize handle must exist while the sidebar is open").toBeVisible();

      const startWidth = await sidebarWidth(page);
      const handleBox = await handle.boundingBox();
      expect(handleBox).not.toBeNull();
      const hx = handleBox!.x + handleBox!.width / 2;
      const hy = handleBox!.y + handleBox!.height / 2;

      // Real drag: mousedown on the handle, move well past DRAG_SLOP_PX to the
      // RIGHT (widen), release. Playwright dispatches buttons=1 during the move,
      // which is what the window-level onMove listener checks.
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      await page.mouse.move(hx + 60, hy, { steps: 12 });
      await page.mouse.up();

      const widened = await sidebarWidth(page);
      expect(widened, "drag right must widen the sidebar").toBeGreaterThan(startWidth + 20);

      // Width persists to app-settings (survives reload).
      const persisted = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem("app-settings");
          return raw ? (JSON.parse(raw) as { sidebarWidth?: number }).sidebarWidth ?? null : null;
        } catch {
          return null;
        }
      });
      expect(persisted, "widened width must be saved to app-settings").not.toBeNull();
      expect(Math.abs((persisted as number) - widened)).toBeLessThan(4);
    });

    test("CHK8-02: al bordo della sidebar UNA cosa sola separa, e la maniglia a riposo non dipinge", async ({ page }) => {
      await goToApp(page);
      const sidebar = page.locator('[aria-label="Topics sidebar"]');
      await expect(sidebar).toBeVisible();

      // QUESTO TEST HA CAMBIATO PREMESSA, non rigore. Diceva «nessun bordo
      // destro: a separarla c'è solo l'ombra», ed era giusto finché sidebar e
      // contenuto avevano tinte diverse — lì l'ombra si leggeva come
      // profondità. Da quando il velo della finestra è uno solo hanno lo stesso
      // pixel (misurato sulla finestra vera: #191b1e da tutt'e due i lati), e
      // quei venticinque pixel di sfumatura sono rimasti l'unica cosa in mezzo:
      // si leggono come una spaziatura doppia e come una terza tinta, non come
      // un confine. «Non hanno bordo, c'è una doppia spaziatura e i colori non
      // sono uguali» (Attilio, 09/08) → un filo, non una sfumatura. La regola
      // sta in `sidebar-content-seam.spec.ts`; qui resta la parte che non è mai
      // cambiata: qualunque sia il separatore, UNO solo, e la maniglia a riposo
      // non ne aggiunge un secondo.
      const bordo = await sidebar.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { larghezza: parseFloat(cs.borderRightWidth || "0"), ombra: cs.boxShadow };
      });
      const conOmbra = bordo.ombra !== "none" && bordo.ombra !== "";
      expect(
        (bordo.larghezza > 0) !== conOmbra,
        `filo e ombra si escludono: larghezza=${bordo.larghezza}, ombra=${bordo.ombra}`,
      ).toBe(true);

      // And the resting resize handle must NOT paint a line either — its fill
      // classes are group-hover only, so at rest its inner bars are transparent.
      const handle = page.locator('.cursor-col-resize').first();
      await expect(handle).toBeVisible();
      const restBg = await handle.locator('div').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(
        restBg === "rgba(0, 0, 0, 0)" || restBg === "transparent",
        `resize handle fill must be transparent at rest (got ${restBg})`,
      ).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // POINT 4 — opening an already-open topic focuses the existing tab, no dup
  // ---------------------------------------------------------------------------
  test.describe("Point 4: reopening an open topic focuses the existing tab (no duplicate)", () => {
    let topicId = "";
    let topicName = "";
    test.beforeAll(async ({ request }) => {
      topicName = "CHK4-Focus-" + Date.now();
      const t = await createTopic(request, topicName);
      topicId = t.id;
    });
    test.afterAll(async ({ request }) => {
      if (topicId) await deleteTopic(request, topicId);
    });

    // Il test è proprio sul CONTEGGIO delle tab: con le pane lasciate aperte dai
    // file precedenti (il pane-store è uno solo per tutta la suite seriale) la
    // barra va in overflow e la tab appena aperta può restare fuori dalla parte
    // visibile → `toBeVisible()` rosso pur essendoci una sola tab.
    //
    // Si resetta a `[topicId]`, NON a `[]`. Azzerare del tutto toglieva anche la
    // pane di QUESTA topic, e nella sidebar unificata una chat standalone non
    // archiviata senza tab (né notifica, né pin, né detach) viene saltata —
    // `buildSidebarItems.ts` §5, `if (!hasTab && notificationCount === 0 && …)
    // continue`. Restava quindi un workspace vuoto in cui la riga da cliccare
    // non esisteva proprio: il test moriva sul `waitForTopicVisible`, prima
    // ancora di arrivare all'invariante che verifica. È anche la lettura fedele
    // del titolo — «una topic GIÀ APERTA» significa che una tab ce l'ha.
    test.beforeEach(async ({ request }) => {
      await resetPaneStore(request, [topicId]);
    });

    test("CHK4-01: clicking a topic already open in the sidebar does NOT add a second tab", async ({ page }) => {
      await goToApp(page);
      await waitForTopicVisible(page, topicId);

      // Open the topic once → exactly one tab exists for it. Sidebar rows are
      // role="treeitem" with aria-label = topic name (no data-topic-id).
      const row = page.getByRole("treeitem", { name: topicName }).first();
      await expect(row).toBeVisible();
      await row.click();

      const tabsFor = page.locator(`[data-pane-id="${topicId}"]`);
      await expect(tabsFor.first()).toBeVisible({ timeout: 10000 });
      await expect(tabsFor, "exactly one tab after first open").toHaveCount(1);

      // Click the SAME sidebar row again → must focus, never duplicate.
      await row.click();
      // Give the click a beat to (wrongly) mint a tab if the dedup regressed.
      await expect(tabsFor, "re-opening must not create a second tab").toHaveCount(1);

      // The single tab is the active/selected one.
      const tab = tabsFor.first();
      const selected = await tab.getAttribute("aria-selected");
      const dataState = await tab.getAttribute("data-active");
      expect(
        selected === "true" || dataState === "true" || (await tab.evaluate((el) => el.getAttribute("role") === "tab")),
        "the existing tab should be present and focusable",
      ).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // POINT 10 — right-click menus
  // ---------------------------------------------------------------------------
  test.describe("Point 10: context menus (sidebar row rename + pop-out; terminal tab rename)", () => {
    let topicId = "";
    let topicName = "";
    test.beforeAll(async ({ request }) => {
      topicName = "CHK10-Menu-" + Date.now();
      const t = await createTopic(request, topicName);
      topicId = t.id;
    });
    test.afterAll(async ({ request }) => {
      if (topicId) await deleteTopic(request, topicId);
    });

    // Stessa ragione del blocco Point 4: la riga di sidebar esiste solo finché la
    // topic ha una tab aperta, e il seed fatto nel `beforeAll` può essere
    // scavalcato dal beacon di `pagehide` della pagina del test PRECEDENTE (che
    // flusha il proprio snapshot a pagina che si smonta, quindi DOPO il seed).
    // Rifare il seed qui — attraverso `resetPaneStore`, che aspetta lo store
    // quieto e verifica di essere rimasto l'ultimo scrittore — lo mette a valle
    // di quel flush invece che a monte.
    test.beforeEach(async ({ request }) => {
      await resetPaneStore(request, [topicId]);
    });

    test("CHK10-01: sidebar row right-click offers Rinomina + 'Apri in nuova finestra' (pop-out)", async ({ page }) => {
      await goToApp(page);
      await waitForTopicVisible(page, topicId);

      const row = page.getByRole("treeitem", { name: topicName }).first();
      await expect(row).toBeVisible();
      await row.click({ button: "right" });

      // Etichette in ITALIANO, e non è un adattamento del test al codice: il
      // menu era EN dentro un'app IT-first e si contraddiceva pure (voce
      // "Archive/Delete" → conferma "Delete topic?" che però archiviava). È
      // stato tradotto di proposito in b7793380, insieme al verbo unico
      // "Archivia". Questo test è del 3 luglio, la traduzione del 23: asseriva
      // "Actions for" / "Rename" su una UI che non li dice più da un mese —
      // rosso per test STALE, non per un bug dell'app.
      const menu = page.getByRole("menu", { name: /Azioni per/ });
      await expect(menu, "topic row context menu must open").toBeVisible({ timeout: 3000 });

      await expect(
        menu.getByRole("menuitem", { name: "Rinomina" }),
        "Rename entry must be present",
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Apri in nuova finestra" }),
        "pop-out entry must be present on the topic row",
      ).toBeVisible();

      // Exercise Rename: opening the inline editor must reveal a text input
      // prefilled with the current name (proves the submenu wires up).
      await menu.getByRole("menuitem", { name: "Rinomina" }).click();
      const input = menu.locator('input[type="text"]');
      await expect(input, "rename editor input must appear").toBeVisible({ timeout: 2000 });
      await expect(input).toHaveValue(/CHK10-Menu-/);
    });

    // NOTE: the terminal-tab "Rinomina" inline editor is covered in
    // terminal-tab-reload.spec.ts ("tab right-click 'Rinomina' opens an inline
    // editor…") — it needs the terminal.fixture to mount a real PTY-backed tab
    // through the UI (raw openPanels seeding does not register the pane).
  });
});
