import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { hostNativePage } from "./helpers/native-host-page";
import { E2E_BASE } from "./helpers/test-server";
import { nextFrames } from "./helpers/frame-probe";
import { openTabSheet } from "./helpers/tab-sheet";

hermetic(test);
// An 11-inch iPad lying down, with a finger.
test.use({ hasTouch: true, viewport: { width: 1180, height: 734 } });

/** The keyboard of an 11-inch iPad lying down: the viewport goes from 734 to 312 px (iOS 26.5 simulator). */
const KEYBOARD = 422;

/**
 * Safari's keyboard scroll, made by hand as in topic-browser-window-keyboard.spec.ts:
 * the body moves up until `field` sits on the keyboard, which is how far Safari
 * scrolls: 422 px for a composer at the bottom, 79 for the one an empty topic
 * holds mid-screen. Any of them is counted twice by a box fixed at a client
 * rect. A number is the scroll itself, for a screen with no composer on it.
 * The transform moves the page's rects and, as the containing block of the
 * fixed boxes, their origin too.
 */
async function keyboardUp(page: Page, field: Locator | number): Promise<void> {
  let scroll = typeof field === "number" ? field : 0;
  if (typeof field !== "number") {
    const box = await field.boundingBox();
    scroll = Math.round(box!.y + box!.height - (page.viewportSize()!.height - KEYBOARD));
  }
  expect(scroll, "the keyboard covers the field, so Safari has to scroll").toBeGreaterThan(50);
  await page.evaluate((by) => {
    document.body.style.transform = `translateY(${-by}px)`;
    window.dispatchEvent(new Event("scroll"));
  }, scroll);
  await nextFrames(page, 3);
}

/** A popover and the button that opens it, and how to open it. */
interface Door {
  name: string;
  button: Locator;
  panel: Locator;
  open: () => Promise<void>;
}

/**
 * Where each door's panel opens, as its offset from its button: opened,
 * measured, closed again with Escape. The keyboard may move both on the screen,
 * never one away from the other.
 */
async function offsets(page: Page, doors: Door[]): Promise<Map<string, { x: number; y: number }>> {
  const out = new Map<string, { x: number; y: number }>();
  for (const door of doors) {
    await door.open();
    await expect(door.panel, door.name).toBeVisible();
    await nextFrames(page, 2);
    const [p, b] = await Promise.all([door.panel.boundingBox(), door.button.boundingBox()]);
    expect(p && b, `${door.name}: both boxes`).toBeTruthy();
    out.set(door.name, { x: Math.round(p!.x - b!.x), y: Math.round(p!.y - b!.y) });
    await page.keyboard.press("Escape");
    await expect(door.panel, door.name).toHaveCount(0);
  }
  return out;
}

/** Soft, so a red run names every door that moved. */
function expectSameOffsets(down: Map<string, { x: number; y: number }>, up: Map<string, { x: number; y: number }>): void {
  for (const [name, d] of down) {
    const u = up.get(name)!;
    expect.soft(Math.abs(u.y - d.y), `${name}: vertical offset from its button moved (down ${d.y}, up ${u.y})`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(u.x - d.x), `${name}: horizontal offset from its button moved (down ${d.x}, up ${u.x})`).toBeLessThanOrEqual(1);
  }
}

/**
 * THE MENUS OPENED WHILE TYPING left the screen on an iPad (14/10): fixed at
 * their button's client rect, which already carries the keyboard's scroll, they
 * landed that much above it (422 px with the composer at the bottom).
 * `/permissions`, `/effort` and `/context` open them with the keyboard up by
 * construction. Three ways of placing, one each: the shared `Menu` (the «+»), a
 * hand-written `top` (autonomy), a `bottom` (the context inspector).
 *
 * @covers POPOVER-02
 */
test("on an iPad with the keyboard up, the composer's menus open on their buttons", async ({ page, request }) => {
  test.setTimeout(120_000);
  const topic = await createTopic(request, `E2E-KBD-POPOVERS-${Date.now()}`);
  try {
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
    await expect(page.getByTestId("composer-add-menu")).toBeVisible();

    const door = (name: string, button: Locator, panel: Locator): Door => ({ name, button, panel, open: () => button.click() });
    const doors = [
      door("«+» menu", page.getByTestId("composer-add-menu"), page.getByRole("menu")),
      door("autonomy", page.getByTestId("composer-autonomy"), page.getByTestId("composer-autonomy-panel")),
      door("context inspector", page.getByTestId("chat-input-context-ring"), page.locator('[data-popover="context-inspector"]')),
    ];
    const down = await offsets(page, doors);
    await keyboardUp(page, page.getByTestId("composer-card"));
    expectSameOffsets(down, await offsets(page, doors));
  } finally {
    await deleteTopic(request, topic.id).catch(() => {});
  }
});

/**
 * The topic's browser window with the same keyboard up: its «+» menu, placed
 * once when it opens, and a tab's sheet, placed again on every frame (opened
 * first, it has to follow its tab into the scroll). The window's bar is above
 * the screen there, so the «+» takes a dispatched click.
 *
 * @covers POPOVER-02
 */
test("on an iPad with the keyboard up, the topic window's «+» menu and a tab's sheet stay on their tab", async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const ctx = `e2e-kbd-popovers-${Date.now()}`;
  await hostNativePage(await context.newPage(), ctx, "<!doctype html><title>Kbd</title><p>Hosted page</p>", { size: { width: 1200, height: 800 }, title: "Kbd" });
  const topic = await createTopic(request, `E2E-KBD-POPOVERS-WIN-${Date.now()}`);
  try {
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topic.id}`, {
      data: { mode: "exp", minPos: null, expandedWidth: 480, tabs: [{ contextId: ctx, url: "https://example.com/hosted", title: "Kbd", openedBy: "user" }], activeContextId: ctx, promoted: [] },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    await page.reload();
    await waitForTopicVisible(page, topic.id);
    await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
    await expect(page.getByTestId("topic-browser-window")).toBeVisible();

    const add = page.getByTestId("topic-browser-add");
    const doors: Door[] = [{ name: "window «+» menu", button: add, panel: page.getByTestId("topic-browser-add-menu"), open: () => add.dispatchEvent("click") }];
    const down = await offsets(page, doors);

    const tab = page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`);
    const sheet = await openTabSheet(page, tab);
    await nextFrames(page, 2);
    const sheetGap = async () => {
      const [s, t] = await Promise.all([sheet.boundingBox(), tab.boundingBox()]);
      return Math.round(s!.y - (t!.y + t!.height));
    };
    expect(await sheetGap(), "sheet under its tab, keyboard down").toBe(0);
    await keyboardUp(page, page.getByTestId("composer-card"));
    expect.soft(await sheetGap(), "sheet under its tab, keyboard up").toBe(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    expectSameOffsets(down, await offsets(page, doors));
  } finally {
    await deleteTopic(request, topic.id).catch(() => {});
  }
});

/**
 * A browser pane's page in a hosted iframe, the web client's path for a page the
 * Mac does not host: the frame lives in a fixed layer of its own and is laid over
 * its pane's slot, so the keyboard's scroll reached it twice as well. The pane
 * covers the chat here, so the scroll is the one a composer at the bottom asks.
 *
 * @covers POPOVER-02
 */
test("on an iPad with the keyboard up, a browser pane's hosted frame keeps covering its slot", async ({ page, browserProcessPageV2, request }) => {
  test.setTimeout(120_000);
  await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
  await browserProcessPageV2.mockBrowserContexts([]);
  await browserProcessPageV2.mockRemoteBrowserPane({ connected: true, url: "https://example.com", title: "Example", hasScreenshot: true });
  await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }));
  const topic = await createTopic(request, `E2E-KBD-FRAME-${Date.now()}`);
  try {
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await page.evaluate(({ tid, url }) => {
      window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
    }, { tid: topic.id, url: "https://example.com" });
    await expect(page.getByTestId("browser-iframe")).toBeVisible({ timeout: 10_000 });

    const frame = page.locator("[data-browser-frame-for]");
    const slot = page.locator("[data-browser-frame-slot]");
    const offset = async () => {
      const [f, s] = await Promise.all([frame.boundingBox(), slot.boundingBox()]);
      return { x: Math.round(f!.x - s!.x), y: Math.round(f!.y - s!.y) };
    };
    const down = await offset();
    expect(Math.abs(down.x) + Math.abs(down.y), `frame on its slot, keyboard down (${down.x}, ${down.y})`).toBeLessThanOrEqual(1);
    await keyboardUp(page, KEYBOARD);
    const up = await offset();
    expect.soft(Math.abs(up.x) + Math.abs(up.y), `frame on its slot, keyboard up (${up.x}, ${up.y})`).toBeLessThanOrEqual(1);
  } finally {
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
