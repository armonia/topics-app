/**
 * THE COLOUR A PERSON CHOSE FOR A CHAT, ON EVERY SURFACE THAT NAMES THE CHAT.
 *
 * TOPICUI-11 (topic-management-org.spec.ts) proves the dot on the sidebar row
 * and on the tab. A review found four places where the choice was still lost
 * or misread, one test each here:
 *
 *  TOPICCOLOR-01  a PINNED chat draws the same dot on its tile;
 *  TOPICCOLOR-02  on a PHONE (390px) the title bar of the open chat carries
 *                 it, since there is no tab strip and the list is a drawer;
 *  TOPICCOLOR-03  the DRAG PREVIEW of a row is painted with the ink of the
 *                 theme on screen, not with the stored light swatch;
 *  TOPICCOLOR-04  in the settings modal «no colour» is a state: the native
 *                 picker does not open on black and an untouched confirm saves
 *                 nothing;
 *  TOPICCOLOR-05  a free pick that equals one of the code's defaults still
 *                 reads as chosen once saved;
 *  TOPICCOLOR-06  yellow on the light chrome is drawn with the computed ring
 *                 that reaches 3:1 (`topicColorInks().ringLight`), i.e. the
 *                 class actually resolves to that colour.
 *
 * @covers TOPIC-02
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, patchTopic, resetPaneStore, cleanupAll } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

const GREEN = "#059669";
/** The light ink of GREEN (lib/topicColor) and its dark one, as computed CSS. */
const GREEN_DARK_INK_RGB = "rgb(52, 211, 153)";
/** The code's defaults: a colour equal to one of these reads as no choice. */
const DEFAULTS = ["#5865f2", "#6366f1", "#0066ff"];

const created: string[] = [];
test.afterAll(async ({ request }) => {
  await cleanupAll(request, { topics: created.splice(0) });
});

async function chat(request: import("@playwright/test").APIRequestContext, name: string, color?: string): Promise<string> {
  const t = await createTopic(request, name, color ? { color } : undefined);
  created.push(t.id);
  return t.id;
}

const sidebar = (page: Page): Locator => page.locator('[aria-label="Topics sidebar"]');

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
}

test.describe("the chosen colour on the surfaces of a chat", () => {
  test("TOPICCOLOR-01: a pinned chat carries its colour on the tile, a plain one does not", async ({ page, request }) => {
    const stamp = Date.now();
    const colored = await chat(request, `TC-pin-colour-${stamp}`, GREEN);
    const plain = await chat(request, `TC-pin-plain-${stamp}`);
    await resetPaneStore(request, [colored, plain]);
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [colored, plain],
        pinnedLayout: [{ keys: [colored, plain], widths: [1, 1] }],
      },
    });
    await open(page);

    const tile = page.locator(`[data-pinned-tile="${colored}"]`).first();
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await expect(tile.locator("[data-topic-color]")).toHaveAttribute("data-topic-color", GREEN);
    await expect(tile.locator("[data-topic-color]")).toBeVisible();
    await expect(page.locator(`[data-pinned-tile="${plain}"]`).first()).toBeVisible();
    await expect(page.locator(`[data-pinned-tile="${plain}"] [data-topic-color]`)).toHaveCount(0);
  });

  test("TOPICCOLOR-03: the drag preview of a row is painted with the dark ink on the dark theme", async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const name = `TC-drag-${Date.now()}`;
    const id = await chat(request, name, GREEN);
    await resetPaneStore(request, [id]);
    await open(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark")), "the app is on the dark theme").toBe(true);

    const row = sidebar(page).getByRole("treeitem", { name: new RegExp(name) }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    // The row's own dot is the dark ink: the preview has to match it.
    await expect(row.locator("[data-topic-color]")).toHaveCSS("background-color", GREEN_DARK_INK_RGB);

    const dt = await page.evaluateHandle(() => new DataTransfer());
    await row.dispatchEvent("dragstart", { dataTransfer: dt });
    const preview = page.locator("[data-drag-preview]");
    await expect(preview).toHaveCount(1);
    await expect(preview).toContainText(name);
    // The accent dot is the preview's first child (lib/dragPreview).
    const accent = await preview.evaluate((card) => getComputedStyle(card.firstElementChild as Element).backgroundColor);
    expect(accent, "the preview's accent is the theme's ink, the same as the row's dot").toBe(GREEN_DARK_INK_RGB);
    await row.dispatchEvent("dragend", { dataTransfer: dt });
    await expect(preview).toHaveCount(0);
  });

  test("TOPICCOLOR-06: yellow on the light chrome is drawn with the ring that reaches 3:1", async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const name = `TC-yellow-${Date.now()}`;
    const id = await chat(request, name, "#eab308");
    await resetPaneStore(request, [id]);
    await open(page);
    const dot = sidebar(page).locator(`[aria-label="${name}"] [data-topic-color]`);
    await expect(dot).toBeVisible({ timeout: 10_000 });
    // yellow-600 ink, and its ring #b67c04 (topicColorInks('#eab308').ringLight).
    await expect(dot).toHaveCSS("background-color", "rgb(202, 138, 4)");
    const shadow = await dot.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow, "the dot's ring is the computed 3:1 edge").toContain("rgb(182, 124, 4)");
  });
});

test.describe("the settings modal: no colour is a state, every pick is a choice", () => {
  async function openSettings(page: Page, id: string): Promise<Locator> {
    const tab = page.getByTestId(`pane-tab-${id}`);
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await tab.click({ button: "right" });
    await page.getByTestId("tab-sheet").getByRole("menuitem", { name: "Impostazioni della chat" }).click();
    // The native input by its type, not by a test id: what is under test is
    // the picker the person touches.
    const input = page.locator('input[type="color"]');
    await expect(input).toHaveCount(1, { timeout: 10_000 });
    return input;
  }

  test("TOPICCOLOR-04: with no colour the picker does not open on black, and an untouched confirm saves nothing", async ({ page, request }) => {
    const id = await chat(request, `TC-none-${Date.now()}`);
    await patchTopic(request, id, { color: "" });
    await resetPaneStore(request, [id]);
    await open(page);
    const input = await openSettings(page, id);

    expect(await input.inputValue(), "the native picker holds a neutral placeholder, not black").not.toBe("#000000");

    // Opening and confirming the native panel without moving it: the browser
    // fires input/change with the value it already holds.
    await input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Save", exact: true }), "an untouched picker chose nothing to save").toBeDisabled();
    // And the field says so in words, with the dashed swatch in place of black.
    await expect(page.getByTestId("topic-color-value")).toHaveText("Nessun colore");
    await expect(page.getByTestId("topic-color-none")).toBeVisible();
  });

  test("TOPICCOLOR-05: a free pick equal to a default is saved as a choice and shows its dot", async ({ page, request }) => {
    const name = `TC-pick-${Date.now()}`;
    const id = await chat(request, name);
    await patchTopic(request, id, { color: "" });
    await resetPaneStore(request, [id]);
    await open(page);
    const input = await openSettings(page, id);

    await input.fill("#5865f2");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const colorOf = async () => {
      const res = await page.request.get(`${E2E_BASE}/api/topics`);
      const body = (await res.json()) as { topics: Record<string, { color?: string }> };
      return body.topics[id]?.color ?? "";
    };
    await expect.poll(colorOf, { message: "the pick was saved", timeout: 5_000 }).not.toBe("");
    const stored = (await colorOf()).toLowerCase();
    expect(DEFAULTS, `the stored ${stored} would read as no colour`).not.toContain(stored);
    await expect(sidebar(page).locator(`[aria-label="${name}"] [data-topic-color]`)).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("TOPICCOLOR-02: the title bar of the open chat carries its colour", async ({ page, request }) => {
    const name = `TC-phone-colour-${Date.now()}`;
    const id = await chat(request, name, GREEN);
    await resetPaneStore(request, [id]);
    await open(page);
    const title = page.getByTestId("mobile-pane-title");
    await expect(title).toContainText(name, { timeout: 10_000 });
    await expect(title.locator("[data-topic-color]")).toHaveAttribute("data-topic-color", GREEN);
    await expect(title.locator("[data-topic-color]")).toBeVisible();
  });

  test("TOPICCOLOR-02b: a chat with no chosen colour draws nothing in the title bar", async ({ page, request }) => {
    const name = `TC-phone-plain-${Date.now()}`;
    const id = await chat(request, name);
    await resetPaneStore(request, [id]);
    await open(page);
    const title = page.getByTestId("mobile-pane-title");
    await expect(title).toContainText(name, { timeout: 10_000 });
    await expect(title.locator("[data-topic-color]")).toHaveCount(0);
  });
});
