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
 * The recorder lives in `helpers/motion-surface.ts`; the surfaces of a
 * project, the board and the phone are in `motion-floating-surfaces-project.spec.ts`.
 *
 * @covers MOTION-01
 * @covers MOTION-04
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import {
  COMPOSITOR_PROPS,
  MODAL_MAX_MS,
  POPOVER_MAX_MS,
  expectEntrance,
  expectExit,
  EASE_STANDARD,
  installRecorder,
  watch,
} from "./helpers/motion-surface";
import { mockHistoryWithMedia } from "./helpers/sse-helpers";
import { reachVersionChip } from "./helpers/open-version-chip";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

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

  // The forms left in the user menu (the plan, the machines) are levels: a form
  // level moves like every level, with no veil of its own.
  test("MOTION-04e: a form level of the user menu (Plan)", async ({ page }) => {
    await ready(page);
    await page.getByTestId("identity-me-profile").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await watch(page, '[data-testid="topics-menu-plan-menu"]');
    await page.getByTestId("topics-menu-plan").click();
    await expect(page.getByTestId("topics-menu-plan-menu")).toBeVisible();
    await expectEntrance(page, "form level", POPOVER_MAX_MS, COMPOSITOR_PROPS);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("topics-menu-plan-menu")).toHaveCount(0);
    await expectExit(page, "form level", "popover", POPOVER_MAX_MS);
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
    await page.getByRole("menu").getByRole("button", { name: "Impostazioni della chat" }).click();
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
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expectExit(page, "changelog", "modal", MODAL_MAX_MS);

    // The fold, read on the list the "under the hood" button reveals.
    await (await reachVersionChip(page)).click();
    await page.getByTestId("changelog-open").click();
    await expect(modal).toBeVisible();
    const fold = '[data-testid="changelog-modal"] button + ul';
    await watch(page, fold);
    await modal.getByText(/Sotto il cofano/).click();
    await expect(page.locator(fold)).toBeVisible();
    await expectEntrance(page, "changelog fold", MODAL_MAX_MS, ["opacity"]);
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

  test("the floating browser window's add menu", async ({ page, request }) => {
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

  test("an empty browser pane's address sheet", async ({ page, request }) => {
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
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
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
