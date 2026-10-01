/**
 * E2E: THE MOTION CONTRACT OF FLOATING SURFACES, AND REDUCED MOTION FOR THE
 * WHOLE APP.
 *
 * What the UI fluidity audit measured (2026-09-29, WebKit):
 *  1. `--ease-standard` resolved at runtime to the Material curve
 *     `cubic-bezier(.4,0,.2,1)`: a second `:root` block 2,800 lines below the
 *     token table redeclared it and won by source order.
 *  2. Every menu, popover, context menu and the notification panel appeared at
 *     full size and opacity 1 on its first frame, and vanished in one frame on
 *     Escape. The settings veil landed at opacity 1 while its panel faded, and
 *     settings and the palette vanished in one frame on close.
 *  3. With `prefers-reduced-motion: reduce` the sidebar slide, the message and
 *     palette entrances, the skeleton pulse, dnd-kit's transforms and a
 *     flex-basis transition all kept moving.
 *
 * The measurement here is the animation object itself (name, duration,
 * animated properties, curve), read in the page on the frame the surface is
 * inserted: deterministic on a loaded machine, where a stopwatch on the frames
 * is not. Red on the tree before the fix, green after.
 *
 * @covers MOTION-01
 * @covers MOTION-04
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { FileExplorerPage } from "./fixtures/file-explorer.fixture";
import { canonicalTmpRoot, cleanupFileProject, removeTmpDir, seedFileProject, type FileProject } from "./helpers/file-project";
import { mockHistoryWithMedia } from "./helpers/sse-helpers";
import { reachVersionChip } from "./helpers/open-version-chip";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { mkdirSync, writeFileSync } from "node:fs";

hermetic(test);

/** `--ease-standard` / `--ease-exit` of the token table (client/src/lib/motion.ts). */
const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";
const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
/** A menu answers a click: its entrance and exit stay at or under this. */
const POPOVER_MAX_MS = 120;
/** A dialog's veil moves with its panel, `--motion-fast`. */
const MODAL_MAX_MS = 150;
/** What an entrance or exit may animate: the compositor-only properties. */
const COMPOSITOR_PROPS = ["opacity", "scale", "transform"];

type AnimationInfo = { name: string; duration: number; props: string[] };
type SurfaceRecord = {
  kind: "enter" | "ghost";
  ghost: string | null;
  testid: string | null;
  /** The element's class list, to tell two surfaces inserted together apart (a sheet and its scrim). */
  cls: string;
  ariaHidden: string | null;
  pointerEvents: string;
  timing: string;
  animations: AnimationInfo[];
  /** Painted box (`getBoundingClientRect`, transforms and `scale` included) against the layout box. */
  box: { painted: [number, number]; layout: [number, number] } | null;
  t: number;
};

/**
 * Installed before the app boots. Every element added to the document that
 * matches `window.__motionWatch`, and every exit copy (`[data-exit-ghost]`),
 * is described on the spot: the same task in which it was inserted, before
 * its first frame is painted.
 */
function installRecorder(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __motionWatch: string; __motionLog: unknown[]; __ghostsGone: number };
    w.__motionWatch = "";
    w.__motionLog = [];
    w.__ghostsGone = 0;
    const describe = (el: Element, kind: "enter" | "ghost") => {
      const cs = getComputedStyle(el);
      const animations = el.getAnimations().map((a) => {
        const effect = a.effect as KeyframeEffect | null;
        const frames = effect?.getKeyframes() ?? [];
        const props = new Set<string>();
        for (const f of frames) {
          for (const k of Object.keys(f)) {
            if (!["offset", "computedOffset", "easing", "composite"].includes(k)) props.add(k);
          }
        }
        return {
          name: (a as CSSAnimation).animationName ?? "",
          duration: Number(effect?.getComputedTiming().duration ?? 0),
          props: [...props],
        };
      });
      w.__motionLog.push({
        kind,
        ghost: el.getAttribute("data-exit-ghost"),
        testid: el.getAttribute("data-testid"),
        cls: el.getAttribute("class") ?? "",
        ariaHidden: el.getAttribute("aria-hidden"),
        pointerEvents: cs.pointerEvents,
        timing: cs.animationTimingFunction,
        animations,
        box: el instanceof HTMLElement
          ? {
              painted: [el.getBoundingClientRect().width, el.getBoundingClientRect().height],
              layout: [el.offsetWidth, el.offsetHeight],
            }
          : null,
        t: performance.now(),
      });
    };
    const start = () => {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            if (n.hasAttribute("data-exit-ghost")) { describe(n, "ghost"); continue; }
            const selector = w.__motionWatch;
            if (!selector) continue;
            for (const el of [n, ...n.querySelectorAll(selector)]) {
              if (el.matches(selector)) describe(el, "enter");
            }
          }
          for (const n of m.removedNodes) {
            if (n instanceof Element && n.hasAttribute("data-exit-ghost")) w.__ghostsGone += 1;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}

async function watch(page: Page, selector: string): Promise<void> {
  await page.evaluate((selector) => {
    const w = window as unknown as { __motionWatch: string; __motionLog: unknown[] };
    w.__motionWatch = selector;
    w.__motionLog = [];
  }, selector);
}

async function log(page: Page): Promise<SurfaceRecord[]> {
  return page.evaluate(() => (window as unknown as { __motionLog: SurfaceRecord[] }).__motionLog);
}

/** The entrance of the surface: one animation, on the compositor, short, on the token curve.
 *  `withClass` picks one of several surfaces inserted together (a sheet and its scrim). */
async function expectEntrance(page: Page, label: string, maxMs: number, props: string[], withClass?: string) {
  const picked = (r: SurfaceRecord) => r.kind === "enter" && (!withClass || r.cls.split(/\s+/).includes(withClass));
  await expect
    .poll(async () => (await log(page)).filter(picked).length, { message: `${label}: inserted` })
    .toBeGreaterThan(0);
  const enter = (await log(page)).find(picked)!;
  const moving = enter.animations.filter((a) => a.duration > 1);
  expect(moving.length, `${label}: an entrance animation runs on the inserted surface (${JSON.stringify(enter.animations)})`).toBeGreaterThan(0);
  for (const a of moving) {
    expect(a.duration, `${label}: ${a.name} lasts at most ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    for (const p of a.props) expect(props, `${label}: ${a.name} animates only ${props.join("/")}`).toContain(p);
  }
  expect(enter.timing, `${label}: entrance on --ease-standard`).toContain(EASE_STANDARD);
  // The menus place themselves by measuring the panel on this very frame
  // (Menu.tsx, DropdownPortal): a box scaled down by the entrance is placed
  // over its anchor and clamped short of the viewport edge. Read in the same
  // task the surface was inserted in, the painted box is the layout box.
  expect(enter.box, `${label}: the inserted surface is an HTML element`).not.toBeNull();
  const { painted, layout } = enter.box!;
  for (const i of [0, 1]) {
    expect(
      Math.abs(painted[i] - layout[i]),
      `${label}: on its first frame the surface measures at its final ${i ? "height" : "width"} (painted ${painted[i]}, layout ${layout[i]})`,
    ).toBeLessThanOrEqual(1);
  }
}

/** The exit: the surface is gone at once, and an inert copy of it fades.
 *  The copy is looked up by its kind: a sheet leaves with a `modal` copy of its scrim next to it. */
async function expectExit(page: Page, label: string, kind: "popover" | "modal" | "sheet", maxMs: number) {
  await expect
    .poll(async () => (await log(page)).filter((r) => r.kind === "ghost").map((r) => r.ghost), { message: `${label}: a ${kind} exit copy plays` })
    .toContain(kind);
  const ghost = (await log(page)).find((r) => r.kind === "ghost" && r.ghost === kind)!;
  expect(ghost.ghost, `${label}: exit kind`).toBe(kind);
  expect(ghost.testid, `${label}: the copy carries no test id`).toBeNull();
  expect(ghost.ariaHidden, `${label}: the copy is hidden from assistive tech`).toBe("true");
  expect(ghost.pointerEvents, `${label}: the copy never takes a click`).toBe("none");
  const moving = ghost.animations.filter((a) => a.duration > 1);
  expect(moving.length, `${label}: the copy animates`).toBeGreaterThan(0);
  for (const a of moving) {
    expect(a.duration, `${label}: ${a.name} lasts at most ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    for (const p of a.props) expect(COMPOSITOR_PROPS, `${label}: ${a.name} animates only compositor properties`).toContain(p);
  }
  expect(ghost.timing, `${label}: exit on --ease-exit`).toContain(EASE_EXIT);
  await expect(page.locator("[data-exit-ghost]"), `${label}: the copy removes itself`).toHaveCount(0);
}

test.describe("Floating surfaces enter and leave", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 90_000 });

  let topic: { id: string; name: string } | null = null;
  test.beforeAll(async ({ request }) => {
    topic = await createTopic(request, `E2E-Motion-${Date.now()}`);
  });
  test.afterAll(async ({ request }) => {
    if (topic) await deleteTopic(request, topic.id);
  });

  /** Each surface in its own test: on the tree before the fix, every one of them is red on its own. */
  async function ready(page: Page) {
    await installRecorder(page);
    await goToApp(page);
    await waitForTopicVisible(page, topic!.id, { timeout: 15_000 });
  }

  test("MOTION-04a: --ease-standard at runtime is the token", async ({ page }) => {
    await ready(page);
    const ease = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim(),
    );
    // Compared as numbers: the minifier writes the custom property as `cubic-bezier(.2,0,0,1)`.
    const numbers = (v: string) => (v.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    expect(numbers(ease), `--ease-standard at runtime (${ease}) is the token, not a later override`).toEqual(numbers(EASE_STANDARD));
  });

  test("MOTION-04b: the add menu (the shared Menu primitive)", async ({ page }) => {
    await ready(page);
    // The tab bar's "+" is the dropdown; the sidebar header's "+" is the ⌘N palette (MOTION-04g).
    const tabBarPlus = page.locator('[data-testid="pane-add-menu-trigger"][title="Add pane"]').first();
    await expect(tabBarPlus).toBeVisible({ timeout: 10_000 });
    await watch(page, '[data-testid="pane-add-menu"]');
    await tabBarPlus.click();
    await expect(page.getByTestId("pane-add-menu")).toBeVisible();
    await expectEntrance(page, "add menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(0);
    await expectExit(page, "add menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04g: the centred ⌘N add palette, its veil and its exit", async ({ page }) => {
    await ready(page);
    await watch(page, '[data-testid="pane-add-palette"] > :first-child');
    await page.keyboard.press("Meta+n");
    await expect(page.getByTestId("pane-add-palette")).toBeVisible();
    await expectEntrance(page, "add palette veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pane-add-palette")).toHaveCount(0);
    await expectExit(page, "add palette", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04c: a sidebar row's context menu (ContextMenuPortal)", async ({ page }) => {
    await ready(page);
    await watch(page, '[role="menu"]');
    await page.getByRole("treeitem", { name: topic!.name }).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectEntrance(page, "context menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expectExit(page, "context menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04k: a pane tab's context menu", async ({ page }) => {
    await ready(page);
    await page.getByRole("treeitem", { name: topic!.name }).first().click();
    const tab = page.locator(`[data-testid="panel-tab-bar"] [data-pane-id="${topic!.id}"]`).first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await watch(page, '[role="menu"]');
    await tab.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectEntrance(page, "tab context menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expectExit(page, "tab context menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04l: the composer's slash menu", async ({ page }) => {
    await ready(page);
    await page.getByRole("treeitem", { name: topic!.name }).first().click();
    const composer = page.locator(`[data-pane-shell="${topic!.id}"] [data-testid="composer-card"] textarea`).first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();
    const slashMenu = `[data-pane-shell="${topic!.id}"] form [role="listbox"]`;
    await watch(page, slashMenu);
    await page.keyboard.type("/");
    await expect(page.locator(slashMenu)).toBeVisible();
    await expectEntrance(page, "slash menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.locator(slashMenu)).toHaveCount(0);
    await expectExit(page, "slash menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04d: the notification panel", async ({ page }) => {
    await ready(page);
    await watch(page, '[data-testid="notification-history-panel"]');
    await page.getByTestId("notification-history-button").first().click();
    await expect(page.getByTestId("notification-history-panel")).toBeVisible();
    await expectEntrance(page, "notification panel", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-history-panel")).toHaveCount(0);
    await expectExit(page, "notification panel", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04e: settings, the veil fades in with the panel and both leave", async ({ page }) => {
    await ready(page);
    await watch(page, ':has(> [data-testid="settings-panel"])');
    await page.keyboard.press("Meta+,");
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expectEntrance(page, "settings veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expectExit(page, "settings", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04f: the palette, its veil and the same exit", async ({ page }) => {
    await ready(page);
    await watch(page, '[data-testid="command-palette"] > :first-child');
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expectEntrance(page, "palette veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
    await expectExit(page, "palette", "modal", MODAL_MAX_MS);
  });
});

/** A sheet crosses a third of the screen: `--motion-base`, still on the entrance curve. */
const SHEET_MAX_MS = 240;
/** The phone's scrim, the one element carrying both `fixed` and `bg-black/40`. */
const SCRIM = 'div[class~="fixed"][class~="bg-black/40"]';

test.describe("Every other surface enters and leaves on the same mechanism", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 90_000 });

  let topic: { id: string; name: string } | null = null;
  test.beforeAll(async ({ request }) => {
    topic = await createTopic(request, `E2E-Motion-All-${Date.now()}`);
  });
  test.afterAll(async ({ request }) => {
    if (topic) await deleteTopic(request, topic.id);
  });

  async function ready(page: Page) {
    await installRecorder(page);
    await goToApp(page);
    await waitForTopicVisible(page, topic!.id, { timeout: 15_000 });
  }

  async function openChat(page: Page) {
    await page.getByRole("treeitem", { name: topic!.name }).first().click();
    const composer = page.locator(`[data-pane-shell="${topic!.id}"] [data-testid="composer-card"] textarea`).first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    return composer;
  }

  test("MOTION-04m: the sidebar user menu (profile card)", async ({ page }) => {
    await ready(page);
    await watch(page, '[data-testid="profile-menu"]');
    await page.getByTestId("identity-me-profile").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await expectEntrance(page, "user menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
    await expectExit(page, "user menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04n: a level of the user menu (the version row)", async ({ page }) => {
    await ready(page);
    await page.getByTestId("identity-me-profile").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await watch(page, '[data-testid="menu-version-menu"]');
    await page.getByTestId("menu-version").click();
    await expect(page.getByTestId("menu-version-menu")).toBeVisible();
    await expectEntrance(page, "user menu level", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("menu-version-menu")).toHaveCount(0);
    await expectExit(page, "user menu level", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04o: the keyboard shortcuts dialog", async ({ page }) => {
    await ready(page);
    const dialog = '[role="dialog"][aria-label="Keyboard Shortcuts"]';
    await watch(page, `${dialog} > :first-child`);
    await page.keyboard.press("Meta+Slash");
    await expect(page.locator(dialog)).toBeVisible();
    await expectEntrance(page, "shortcuts veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.locator(dialog)).toHaveCount(0);
    await expectExit(page, "shortcuts", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04p: the new topic dialog", async ({ page }) => {
    await ready(page);
    const panel = '[aria-labelledby="new-topic-title"]';
    await watch(page, `:has(> ${panel}) > :first-child`);
    await page.keyboard.press("Meta+Shift+n");
    await expect(page.locator(panel)).toBeVisible();
    await expectEntrance(page, "new topic veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.locator(panel)).toHaveCount(0);
    await expectExit(page, "new topic", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04q: a chat's settings dialog", async ({ page }) => {
    await ready(page);
    await openChat(page);
    const tab = page.locator(`[data-testid="panel-tab-bar"] [data-pane-id="${topic!.id}"]`).first();
    await tab.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    const dialog = `[role="dialog"][aria-label="${topic!.name} Settings"]`;
    await watch(page, `${dialog} > :first-child`);
    await page.getByRole("menu").getByRole("button", { name: "Impostazioni" }).click();
    await expect(page.locator(dialog)).toBeVisible();
    await expectEntrance(page, "chat settings veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.locator(dialog)).toHaveCount(0);
    await expectExit(page, "chat settings", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04r: the changelog dialog, and its fold", async ({ page, context }) => {
    await page.route("**/api/version", (r) =>
      r.fulfill({ json: { version: "9.9.9" }, headers: { "Cache-Control": "no-store" } }),
    );
    await context.route("**/changelog.json", (r) => r.fulfill({
      json: [{
        version: "9.9.9",
        date: "2026-07-23",
        sections: {
          new: [{ it: "una novità", en: "", scope: "chat", breaking: false }],
          fixes: [],
          perf: [],
          internal: [{ it: "pulizia interna", en: "", scope: "core", breaking: false }],
        },
      }],
    }));
    await ready(page);
    await (await reachVersionChip(page)).click();
    await watch(page, ':has(> [data-testid="changelog-modal"])');
    await page.getByTestId("changelog-open").click();
    const modal = page.getByTestId("changelog-modal");
    await expect(modal).toBeVisible();
    await expectEntrance(page, "changelog veil", MODAL_MAX_MS, ["opacity"]);

    await watch(page, '[data-testid="changelog-internal-list"]');
    await modal.getByText(/Sotto il cofano/).click();
    await expect(page.getByTestId("changelog-internal-list")).toBeVisible();
    await expectEntrance(page, "changelog fold", MODAL_MAX_MS, ["opacity"]);

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expectExit(page, "changelog", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04s: the app tooltip", async ({ page }) => {
    await ready(page);
    await watch(page, '[data-testid="app-tooltip"]');
    await page.locator('[data-testid="pane-add-menu-trigger"][title="Add pane"]').first().hover();
    await expect(page.getByTestId("app-tooltip")).toBeVisible();
    await expectEntrance(page, "tooltip", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app-tooltip")).toHaveCount(0);
    await expectExit(page, "tooltip", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04u: the context inspector popover, and a fold inside it", async ({ page }) => {
    await ready(page);
    await openChat(page);
    const popover = '[data-popover="context-inspector"]';
    await watch(page, popover);
    await page.locator(`[data-pane-shell="${topic!.id}"]`).getByTestId("chat-input-context-ring").first().click();
    await expect(page.locator(popover)).toBeVisible();
    await expectEntrance(page, "context inspector", POPOVER_MAX_MS, COMPOSITOR_PROPS);

    const details = page.getByTestId("envelope-details");
    await expect(details).toBeVisible({ timeout: 20_000 });
    await watch(page, '[data-testid="envelope-details"] > :not(summary)');
    await details.locator("summary").click();
    await expectEntrance(page, "a native fold", MODAL_MAX_MS, ["opacity"]);

    await page.keyboard.press("Escape");
    await expect(page.locator(popover)).toHaveCount(0);
    await expectExit(page, "context inspector", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04v: an image lightbox", async ({ page }) => {
    await page.context().route(/\/uploads\//, (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==", "base64"),
    }));
    await mockHistoryWithMedia(page, { mediaPaths: ["/uploads/motion.png"], content: "an image", userMessage: "show me" });
    await ready(page);
    await openChat(page);
    const image = page.locator('[data-testid="media-image"]').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await watch(page, '[data-testid="image-lightbox"]');
    await image.click();
    await expect(page.getByTestId("image-lightbox")).toBeVisible();
    await expectEntrance(page, "lightbox", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
    await expectExit(page, "lightbox", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04-tbwmenu: the floating browser window's add menu", async ({ page, request }) => {
    const ctx = `motion-tbw-${Date.now()}`;
    const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topic!.id}`, {
      data: {
        mode: "min",
        minPos: { right: 24, bottom: 24 },
        expandedWidth: null,
        tabs: [{ contextId: ctx, url: "https://example.com", title: "Example", openedBy: "user" }],
        activeContextId: ctx,
        promoted: [],
      },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    try {
      await ready(page);
      await page.locator(`[data-pane-id="${topic!.id}"], [data-topic-id="${topic!.id}"]`).first().click();
      await expect(page.getByTestId("topic-browser-window")).toBeVisible({ timeout: 10_000 });
      await watch(page, '[data-testid="topic-browser-add-menu"]');
      await page.getByTestId("topic-browser-add").click();
      await expect(page.getByTestId("topic-browser-add-menu")).toBeVisible();
      await expectEntrance(page, "window add menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
      await page.getByTestId("topic-browser-add-backdrop").click({ position: { x: 5, y: 5 } });
      await expect(page.getByTestId("topic-browser-add-menu")).toHaveCount(0);
      await expectExit(page, "window add menu", "popover", POPOVER_MAX_MS);
    } finally {
      await closeAllBrowserContexts(request);
    }
  });

  test("MOTION-04-tabsheet: an empty browser pane's address sheet", async ({ page, request }) => {
    await resetPaneStore(request, [`browser:motion-${Date.now()}`]);
    try {
      await installRecorder(page);
      // The sheet opens by itself as the empty pane is born, so the watch is
      // armed before the app boots.
      await page.addInitScript(() => {
        (window as unknown as { __motionWatch: string }).__motionWatch = '[data-testid="browser-tab-sheet"]';
      });
      await goToApp(page);
      const sheet = page.getByTestId("browser-tab-sheet");
      await expect(sheet).toBeVisible({ timeout: 15_000 });
      await expectEntrance(page, "tab sheet", POPOVER_MAX_MS, COMPOSITOR_PROPS);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expectExit(page, "tab sheet", "popover", POPOVER_MAX_MS);
    } finally {
      await closeAllBrowserContexts(request);
      await resetPaneStore(request, [topic!.id]);
    }
  });
});

test.describe("The surfaces of a project enter and leave on the same mechanism", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 90_000 });

  let project: FileProject | undefined;
  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "motion");
  });
  test.beforeEach(async ({ request }) => {
    if (project) await resetPaneStore(request, [project.topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  async function ready(page: Page, explorer: FileExplorerPage) {
    await installRecorder(page);
    await explorer.gotoProject(project!.tmpDir, project!.topicName);
    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
  }

  async function openFileMenu(explorer: FileExplorerPage, page: Page) {
    const row = explorer.fileTree.getByRole("treeitem", { name: /package\.json/ });
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
  }

  test("MOTION-04t: the composer's @ mention menu", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    // A new chat of the project: the composer whose mentions list the project's files.
    await page.getByRole("button", { name: "New Chat" }).first().click();
    const composer = page.locator('[data-testid="project-window"] [data-testid="composer-card"] textarea').first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();
    const menu = "[data-mention-menu]";
    await watch(page, menu);
    await page.keyboard.type("@");
    await expect(page.locator(menu)).toBeVisible();
    await expectEntrance(page, "mention menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.locator(menu)).toHaveCount(0);
    await expectExit(page, "mention menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04w: the file tree's context menu", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await watch(page, '[role="menu"]');
    await openFileMenu(explorer, page);
    await expectEntrance(page, "file menu", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expectExit(page, "file menu", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04x: a confirmation dialog", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await openFileMenu(explorer, page);
    const dialog = '[role="dialog"][aria-label="Sposta nel cestino"]';
    await watch(page, `:has(> ${dialog})`);
    await page.getByRole("menu").getByRole("menuitem", { name: /Delete|Sposta nel cestino|Elimina/ }).first().click();
    await expect(page.locator(dialog)).toBeVisible();
    await expectEntrance(page, "confirm veil", MODAL_MAX_MS, ["opacity"]);
    await page.locator(dialog).getByRole("button", { name: "Annulla" }).click();
    await expect(page.locator(dialog)).toHaveCount(0);
    await expectExit(page, "confirm", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04y: file search, its veil and its exit", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await watch(page, '[data-testid="file-search"]');
    await explorer.openFileSearch();
    await expect(explorer.fileSearch).toBeVisible();
    await expectEntrance(page, "file search veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(explorer.fileSearch).toHaveCount(0);
    await expectExit(page, "file search", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04z: the git branch and history popovers", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    const git = explorer.gitChanges.first();
    await expect(git).toBeVisible({ timeout: 15_000 });
    // The section is born closed; its label (not the branch in the middle of
    // the row) opens it, and the history and branch buttons live inside.
    const head = git.getByTestId("project-sidebar-git");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.getByText("Git", { exact: true }).click();
    await expect(git.getByTestId("git-history-button")).toBeVisible({ timeout: 10_000 });

    await watch(page, '[data-testid="git-history-popover"]');
    await git.getByTestId("git-history-button").click();
    await expect(page.getByTestId("git-history-popover")).toBeVisible();
    await expectEntrance(page, "history popover", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("git-history-popover")).toHaveCount(0);
    await expectExit(page, "history popover", "popover", POPOVER_MAX_MS);

    await watch(page, '[data-testid="git-branch-popover"]');
    await git.getByTestId("git-branch-button").click();
    await expect(page.getByTestId("git-branch-popover")).toBeVisible();
    await expectEntrance(page, "branch popover", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("git-branch-popover")).toHaveCount(0);
    await expectExit(page, "branch popover", "popover", POPOVER_MAX_MS);
  });

  test("MOTION-04z3: the project's share dialog", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    const row = projectRow(page, new RegExp(project!.tmpDir.split("/").pop()!));
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click({ button: "right" });
    await watch(page, '[data-testid="project-share-panel"]');
    await page.getByTestId("project-share").click();
    await expect(page.getByTestId("project-share-panel")).toBeVisible();
    await expectEntrance(page, "share veil", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-share-panel")).toHaveCount(0);
    await expectExit(page, "share", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04z2: a toast closed by hand fades like a timed one", async ({ page }) => {
    const explorer = new FileExplorerPage(page);
    await ready(page, explorer);
    await openFileMenu(explorer, page);
    await page.getByRole("menu").getByRole("menuitem", { name: "Copy Path" }).click();
    const toast = page.getByTestId("toast").first();
    await expect(toast).toBeVisible();
    // The toast's own exit (a token transition on `opacity`), read on the
    // frame after the click: the close button used to drop it in one frame.
    await expect(toast.getByRole("button", { name: "Chiudi la notifica" })).toBeVisible();
    // Settled first: closed while its own entrance is still at opacity 0 there
    // is no fade to see, on either tree.
    await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).opacity), { message: "the toast has settled in" }).toBe("1");
    const after = await toast.evaluate(async (el) => {
      const button = el.querySelector('button[aria-label="Chiudi la notifica"]') as HTMLButtonElement;
      button.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cs = getComputedStyle(el);
      return {
        connected: el.isConnected,
        transitions: el.getAnimations().map((a) => ({
          prop: (a as CSSTransition).transitionProperty ?? "",
          duration: Number(a.effect?.getComputedTiming().duration ?? 0),
        })),
        opacityTarget: cs.opacity,
      };
    });
    expect(after.connected, "the closed toast is still on screen for its fade").toBe(true);
    const fade = after.transitions.find((t) => t.prop === "opacity");
    expect(fade, `an opacity fade runs on the closed toast (${JSON.stringify(after.transitions)})`).toBeTruthy();
    expect(fade!.duration, "the fade is `--motion-fast`").toBeLessThanOrEqual(MODAL_MAX_MS);
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });
});

test.describe("The board's lightbox and the task drawer's folds", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.describe.configure({ timeout: 120_000 });

  const projectPath = `${canonicalTmpRoot()}/e2e-motion-board-${Date.now()}`;
  const boardId = projectIdForPath(projectPath);
  // `/api/media` serves the server's own media root only (preview-slide.spec.ts).
  const mediaDir = `${testServerEnv(E2E_PORT).TOPICS_HOME}/media/e2e-motion-${Date.now()}`;
  const taskText = "motion card with a cover";
  let topicId: string | null = null;
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(mediaDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(`${projectPath}/package.json`, JSON.stringify({ name: "e2e-motion-board" }));
    writeFileSync(`${mediaDir}/cover.png`, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAP//B5wBiOtZQOgAAAAASUVORK5CYII=",
      "base64",
    ));
    topicId = (await createTopic(request, "E2E-Motion-Board", { projectPath })).id;
    const res = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, {
      data: { text: taskText, status: "review", description: "A description to fold and unfold." },
    });
    expect(res.ok(), `task refused: ${res.status()}`).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    const cover = await request.patch(`${E2E_BASE}/api/boards/${boardId}/tasks/${taskId}`, {
      data: { previewImage: `${mediaDir}/cover.png` },
    });
    expect(cover.ok(), `cover refused: ${cover.status()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await request.delete(`${E2E_BASE}/api/boards/${boardId}/tasks/${taskId}`).catch(() => undefined);
    if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
    removeTmpDir(projectPath);
    removeTmpDir(mediaDir);
  });

  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });

  async function openBoard(page: Page) {
    await installRecorder(page);
    await goToApp(page);
    const section = page.getByRole("button", { name: /sezione Progetti/ });
    if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") await section.click();
    const row = projectRow(page, /e2e-motion-board/);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const win = page.locator('[data-testid="project-window"][data-project-path*="e2e-motion-board"]');
    await expect(win).toBeVisible({ timeout: 20_000 });
    const triggers = win.getByTestId("pane-add-menu-trigger");
    const kanban = page.getByTestId("pane-add-menu-kanban");
    for (let i = (await triggers.count()) - 1; i >= 0; i--) {
      const t = triggers.nth(i);
      if (!(await t.isVisible().catch(() => false))) continue;
      if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
      if (await kanban.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
        await kanban.click();
        break;
      }
      await page.keyboard.press("Escape");
    }
    await expect(page.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 20_000 });
  }

  test("MOTION-04-preview: a card's preview lightbox", async ({ page }) => {
    await openBoard(page);
    const image = page.locator(`[data-task-card="${taskId}"] [data-testid="preview-card"] img`).first();
    await expect(image).toBeVisible({ timeout: 20_000 });
    await watch(page, '[data-testid="preview-lightbox"]');
    await image.click();
    await expect(page.getByTestId("preview-lightbox")).toBeVisible();
    await expectEntrance(page, "preview lightbox", MODAL_MAX_MS, ["opacity"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-lightbox")).toHaveCount(0);
    await expectExit(page, "preview lightbox", "modal", MODAL_MAX_MS);
  });

  test("MOTION-04-drawer: a section of the task drawer opens with a fade", async ({ page }) => {
    await openBoard(page);
    await page.locator(`[data-task-card="${taskId}"]`).getByText(taskText).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    const toggle = drawer.getByTestId("task-details-toggle");
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const header = drawer.getByTestId("task-section-desc");
    await expect(header).toBeVisible({ timeout: 10_000 });
    // The section remembers its last state: start from closed.
    if ((await header.getAttribute("data-open")) === "1") await header.click();
    await expect(header).toHaveAttribute("data-open", "0");
    await watch(page, '[data-testid="task-desc-body"]');
    await header.click();
    await expect(drawer.getByTestId("task-desc-body")).toBeVisible();
    await expectEntrance(page, "drawer section", MODAL_MAX_MS, ["opacity"]);
  });
});

test.describe("The phone's sheets rise and go back down", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" }, viewport: { width: 390, height: 844 } });
  test.describe.configure({ timeout: 90_000 });

  test("MOTION-04-sheet: the Topics sheet and its scrim", async ({ page }) => {
    await installRecorder(page);
    await page.addInitScript(() => localStorage.setItem("topics-mobile-drawer-collapsed", "0"));
    await goToApp(page);
    const trigger = page.getByTestId("sidebar-topics-menu");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await watch(page, `[data-testid="sidebar-topics-menu-panel"], ${SCRIM}`);
    await trigger.click();
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toBeVisible();
    await expectEntrance(page, "Topics sheet", SHEET_MAX_MS, ["transform"], "bottom-sheet");
    await expectEntrance(page, "sheet scrim", MODAL_MAX_MS, ["opacity"], "bg-black/40");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toHaveCount(0);
    await expectExit(page, "Topics sheet", "sheet", MODAL_MAX_MS);
    await expectExit(page, "sheet scrim", "modal", MODAL_MAX_MS);
  });
});

test.describe("The first ⌘K", () => {
  test("MOTION-04h: once the chunk is warm, the first palette is not held back by a Suspense reveal", async ({ page }) => {
    // The audit measured 330-342ms from ⌘K to the palette on the first open of
    // a session, and 23-32ms on every later one. The cause is React 19's reveal
    // throttle: `lazy()` suspends once even on a loaded chunk, the `null`
    // fallback commits, and the content waits out FALLBACK_THROTTLE_MS (300ms).
    // Measured from the keydown to the palette's insertion, in the page.
    await page.addInitScript(() => {
      const w = window as unknown as { __cmdk: { key?: number; dom?: number } };
      w.__cmdk = {};
      window.addEventListener("keydown", (e) => {
        if (e.key === "k" && e.metaKey && w.__cmdk.key === undefined) w.__cmdk.key = performance.now();
      }, true);
      new MutationObserver((muts) => {
        if (w.__cmdk.dom !== undefined) return;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n instanceof Element && (n.matches('[data-testid="command-palette"]') || n.querySelector('[data-testid="command-palette"]'))) {
              w.__cmdk.dom = performance.now();
              return;
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await goToApp(page);
    // The idle warm-up (App.tsx) has fetched the chunk: the case the audit timed.
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("CommandPalette"))), {
        message: "the palette chunk is warm",
        timeout: 15_000,
      })
      .toBe(true);
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    const t = await page.evaluate(() => (window as unknown as { __cmdk: { key: number; dom: number } }).__cmdk);
    const ms = t.dom - t.key;
    test.info().annotations.push({ type: "first ⌘K, keydown to palette", description: `${ms.toFixed(0)}ms` });
    // 300ms is the throttle's floor, so the defect cannot pass under 200.
    expect(ms, "first ⌘K: keydown to palette in the DOM").toBeLessThan(200);
  });
});

test.describe("The first ⌘K before the warm-up", () => {
  test.describe.configure({ timeout: 90_000 });
  let created: string | null = null;
  test.afterAll(async ({ request }) => {
    if (created) await deleteTopic(request, created);
  });

  test("MOTION-04i: the palette opened before its chunk loaded keeps its query when the chunk lands", async ({ page, request }) => {
    // Opened before the idle warm-up, the palette mounts through <Suspense>
    // <lazy/>. When the chunk lands the direct path becomes available; read on
    // every render, the host switched to it on the next App re-render, a
    // different element type, and React remounted the palette: the query,
    // the selection and the focus were gone. The chunk is held at the network
    // until ⌘K has been pressed, so the order is the cold one on every run.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let requested = false;
    await page.route(/\/assets\/CommandPalette-[^/]*\.js(\?.*)?$/, async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
    await goToApp(page);
    await page.keyboard.press("Meta+k");
    await expect.poll(() => requested, { message: "the palette chunk was asked for" }).toBe(true);
    await expect(page.getByTestId("command-palette"), "no palette while its chunk is held").toHaveCount(0);
    release();

    const input = page.getByTestId("command-palette").locator("input").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("zz-probe-query");
    await input.evaluate((el) => { (el as HTMLInputElement & { __probe?: boolean }).__probe = true; });

    // A topic created from outside re-renders App, which is what swapped the branch.
    const topic = await createTopic(request, `E2E-Motion-Cold-${Date.now()}`);
    created = topic.id;
    await waitForTopicVisible(page, topic.id, { timeout: 15_000 });

    const after = await page.getByTestId("command-palette").locator("input").first().evaluate((el) => ({
      sameNode: (el as HTMLInputElement & { __probe?: boolean }).__probe === true,
      value: (el as HTMLInputElement).value,
    }));
    expect(after, "the palette was not remounted: same input, same query").toEqual({ sameNode: true, value: "zz-probe-query" });
  });
});

test.describe("Reduced motion, everywhere", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });
  test.describe.configure({ timeout: 90_000 });

  let topic: { id: string; name: string } | null = null;
  test.beforeAll(async ({ request }) => {
    topic = await createTopic(request, `E2E-Motion-RM-${Date.now()}`);
  });
  test.afterAll(async ({ request }) => {
    if (topic) await deleteTopic(request, topic.id);
  });

  test("MOTION-04j: a style change on an element that declares no transition lands on the same frame", async ({ page }) => {
    // The global rule once set a 1ms `transition-duration` on EVERY element,
    // and `transition-property` is `all` by default: every style change became
    // a 1ms transition and the new value landed a frame late. Code that measured
    // or focused right after the change read the old state (the profile
    // submenu stayed `visibility: hidden` for that frame and refused focus).
    await goToApp(page);
    const probe = await page.evaluate(async () => {
      const el = document.createElement("div");
      el.style.width = "10px";
      el.style.height = "10px";
      document.body.appendChild(el);
      let runs = 0;
      el.addEventListener("transitionrun", () => { runs += 1; });
      void el.getBoundingClientRect().width;
      el.style.width = "200px";
      const computed = getComputedStyle(el).width;
      const painted = el.getBoundingClientRect().width;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el.remove();
      return { computed, painted, runs, duration: getComputedStyle(document.body).transitionDuration };
    });
    expect(probe, "the new width is there at once and nothing transitioned").toEqual({
      computed: "200px",
      painted: 200,
      runs: 0,
      duration: "0s",
    });
  });

  test("MOTION-01: nothing that starts while the user walks the app lasts longer than 1ms", async ({ page }) => {
    // The sweep listens to every animation and transition that STARTS, on any
    // element, and reads its computed duration: a rule that forgets one
    // surface shows up here the first time that surface moves.
    await page.addInitScript(() => {
      const w = window as unknown as { __movers: string[] };
      w.__movers = [];
      const seconds = (v: string) => (v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v));
      const at = (list: string, i: number) => {
        const parts = list.split(",").map((s) => s.trim());
        return parts[i % parts.length];
      };
      const who = (el: Element, pseudo: string) =>
        `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${[...el.classList].slice(0, 6).join(".")}${pseudo}`;
      // State signals the global rule leaves running on purpose (index.css).
      const exempt = (el: Element, pseudo: string) =>
        (pseudo === "" && el.classList.contains("animate-spin")) ||
        (pseudo === "::after" && (el.classList.contains("animate-awaiting-pulse") || el.classList.contains("animate-awaiting-attention")));
      document.addEventListener("animationstart", (e) => {
        const el = e.target as Element;
        if (exempt(el, e.pseudoElement)) return;
        const cs = getComputedStyle(el, e.pseudoElement || null);
        const i = cs.animationName.split(",").map((s) => s.trim()).indexOf(e.animationName);
        const duration = seconds(at(cs.animationDuration, Math.max(i, 0)));
        const iters = at(cs.animationIterationCount, Math.max(i, 0));
        if (duration > 0.001 || iters !== "1") w.__movers.push(`animation ${e.animationName} ${duration * 1000}ms x${iters} on ${who(el, e.pseudoElement)}`);
      }, true);
      document.addEventListener("transitionrun", (e) => {
        const el = e.target as Element;
        const cs = getComputedStyle(el, e.pseudoElement || null);
        const props = cs.transitionProperty.split(",").map((s) => s.trim());
        let i = props.indexOf(e.propertyName);
        if (i < 0) i = props.indexOf("all");
        const duration = seconds(at(cs.transitionDuration, Math.max(i, 0)));
        if (duration > 0.001) w.__movers.push(`transition ${e.propertyName} ${duration * 1000}ms on ${who(el, e.pseudoElement)}`);
      }, true);
    });
    await goToApp(page);
    await waitForTopicVisible(page, topic!.id, { timeout: 15_000 });
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      "the context really asks for reduced motion",
    ).toBe(true);

    // Walk the surfaces the audit saw moving: hover, the add menu, a context
    // menu, the notification panel, settings, the palette, the sidebar slide.
    const row = page.getByRole("treeitem", { name: topic!.name }).first();
    await row.hover();
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await expect(page.getByTestId("pane-add-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pane-add-menu")).toHaveCount(0);
    await row.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("notification-history-button").first().click();
    await expect(page.getByTestId("notification-history-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-history-panel")).toHaveCount(0);
    await page.keyboard.press("Meta+,");
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("ControlOrMeta+b");
    await row.click();
    await expect(page.locator("[data-exit-ghost]"), "no exit copy under reduced motion").toHaveCount(0);

    const movers = await page.evaluate(() => (window as unknown as { __movers: string[] }).__movers);
    expect([...new Set(movers)], "animations or transitions longer than 1ms under reduced motion").toEqual([]);
  });
});
