/**
 * ONE PREDICATE ONLY — the four proofs of the band where the two disagree.
 *
 * The shell folds into one column at `innerWidth < 768`. There used to be a
 * SECOND predicate, «small screen» = `<768 || (touch && <1024)`, and two
 * surfaces deciding a LAYOUT question were reading it: the bottom row of
 * commands and the availability of splits. Between 768 and 1023 with a finger
 * the two answer differently, and that is exactly the width of an iPhone held
 * sideways and of an iPad in portrait — not a laboratory case.
 *
 * The four proofs, which were red:
 *
 *  a) 844x390 with touch: the row appeared ON TOP of the desktop layout (fixed
 *     sidebar column), and its switch was one-way — `boardInFront` is computed
 *     from the LAYOUT predicate, false there, so every press took the «open the
 *     board AND collapse the column» branch. Two presses did not bring the list
 *     back. Both honest outcomes are accepted here: either the row is absent
 *     where the layout is desktop, or it is there and then the switch comes
 *     back. What is not accepted is the broken button.
 *
 *  b) 834x1194 with touch: `PanelGrid` really does mount the split tree with
 *     its dividers, while the three commands that govern them vanished from the
 *     tab menu, from the «Topics» menu and from the palette. The splits existed
 *     and there was nowhere left to govern them from.
 *
 *  c) 390x844 with no network: «Connecting…/Reconnecting…/Offline» and «cached
 *     data» lived ONLY inside the desktop-only block at the foot of the column.
 *     On the phone — the device that actually loses the network — no element
 *     named the state at all, and the dot in the title is zero wide with the
 *     drawer closed.
 *
 *  d) the tab X announced `Chiudi tab 7f3a1c22-…`, i.e. it asked VoiceOver allow-italian: the exact string a screen reader used to speak
 *     users to destroy something they cannot recognise. The twins in the
 *     sidebar have said the chat name all along.
 *
 * `hasTouch` is not incidental garnish: WITHOUT the touch signal the two
 * predicates coincide at every width, and this spec would pass green while
 * measuring a case that is not the broken one.
 *
 * @covers LAYOUT-PRED-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const CHROME_BAR = '[data-testid="mobile-chrome-bar"]';
const BOARD_SWITCH = '[data-testid="mobile-chrome-board"]';
const TOPIC_LIST = '[data-testid="sidebar-topic-list"]';
const PANEL_CELL = "[data-panel-cell]";

/** The chat name: looked for INSIDE the X's aria-label, where the id must NOT
 *  be. Two opposite assertions on the same string, because «contains the name»
 *  on its own would pass even with the uuid still sitting next to it. */
const TOPIC_NAME = "Coerenza predicato";

let topicId: string | null = null;

test.beforeAll(async ({ request }) => {
  const topic = await createTopic(request, TOPIC_NAME);
  topicId = topic.id;
  await resetPaneStore(request, [topic.id]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  if (topicId) await deleteTopic(request, topicId);
});

/** How many columns the shell says fit: the layout predicate, read from the
 *  same window the components read. It separates «the row is absent because the
 *  layout is desktop» (right) from «it is just absent». */
async function layoutIsMobile(page: Page): Promise<boolean> {
  return page.evaluate(() => window.innerWidth < 768);
}

test.describe("Un predicato solo per «quante colonne»", () => {
  test.describe("a) un telefono in ORIZZONTALE, largo come un desktop stretto", () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test("la fila non si accende sopra il layout desktop, e se c'e' l'interruttore torna indietro", async ({ page }) => {
      await page.goto(BASE);
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 20_000 });

      // 844 is above 768: here the shell draws the desktop layout, and the
      // phone row is a piece of a different shell.
      expect(await layoutIsMobile(page)).toBe(false);

      const bar = page.locator(CHROME_BAR);
      const barCount = await bar.count();

      if (barCount === 0) {
        // The first honest outcome: where the layout is desktop the row does
        // not exist, and neither does the band the root reserved for it — 15%
        // of a 390-tall viewport taken from a chat, for a bar that is not there.
        const reserved = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--mobile-chrome-h").trim(),
        );
        expect(reserved === "" || reserved === "0px").toBe(true);
        return;
      }

      // The second honest outcome: the row stays, but then it is a SWITCH.
      // There and back, which is the proof that its two ends are looking at the
      // same screen.
      const sw = page.locator(BOARD_SWITCH);
      await sw.tap();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
      await sw.tap();
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("b) un tablet in VERTICALE, dove gli split si disegnano davvero", () => {
    test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });

    test("«Dividi a destra» c'e' nel menu della tab, e produce una seconda cella", async ({ page }) => {
      await page.goto(BASE);
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 20_000 });

      // 834 is above 768: this is the grid that has splits.
      expect(await layoutIsMobile(page)).toBe(false);

      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab).toBeVisible({ timeout: 15_000 });
      await tab.click({ button: "right" });

      // THE OLD RED: the entry vanished here, on a screen where splitting
      // works. The «Topics» menu and the palette lost it from the same source,
      // so no route was left.
      const splitRight = page.getByText("Dividi a destra", { exact: true });
      await expect(splitRight).toBeVisible({ timeout: 5000 });
      await splitRight.click();

      // And the entry is not decorative: the cells become two.
      await expect
        .poll(() => page.locator(PANEL_CELL).count(), { timeout: 15_000 })
        .toBeGreaterThan(1);
    });
  });

  test.describe("c) un telefono che perde la rete", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("un elemento a schermo nomina lo stato, senza aprire il cassetto", async ({ page, context }) => {
      await page.goto(BASE);
      await expect(page.locator(CHROME_BAR)).toBeVisible({ timeout: 20_000 });

      // Here the shell IS one column: the real phone case.
      expect(await layoutIsMobile(page)).toBe(true);

      await context.setOffline(true);
      try {
        // NOTHING is opened: no menu, no drawer. The sentence has to be on
        // screen already, because an alarm that needs a gesture to show itself
        // is not an alarm.
        const band = page.getByTestId("mobile-transport-band");
        await expect(band).toBeVisible({ timeout: 30_000 });
        await expect(band).toContainText(/Offline|Reconnecting…|Connecting…/, { timeout: 30_000 });
      } finally {
        await context.setOffline(false);
      }
    });
  });

  test.describe("d) la X della tab, annunciata", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("l'aria-label porta il nome della chat e NON l'id interno", async ({ page }) => {
      await page.goto(BASE);
      const close = page.getByTestId("pane-tab-close").first();
      await expect(close).toHaveCount(1, { timeout: 20_000 });

      const label = (await close.getAttribute("aria-label")) ?? "";
      expect(label).toContain(TOPIC_NAME);
      // The id is NOT there any more: without this half, a label that added
      // the name NEXT TO the uuid would pass green while saying the false.
      expect(label).not.toContain(topicId ?? "@@@");
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    });
  });
});
