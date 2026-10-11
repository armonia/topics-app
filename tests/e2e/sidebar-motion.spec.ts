/**
 * @covers LAYOUT-02
 * @covers LAYOUT-28
 *
 * THE SIDEBAR AND THE PHONE DRAWER MOVE, THEY DO NOT JUMP: the motion contract,
 * measured frame by frame.
 *
 * Every test here samples the real layout on every animation frame
 * (`getBoundingClientRect`, computed opacity) while ONE gesture happens, and
 * judges the trajectory, not the end state. The end state was always right;
 * what was wrong is how the column got there:
 *
 *  - recency reorder (a row lifted over others by new activity): the rows
 *    changed place in one frame, 200-440 px at a time;
 *  - a project accordion closing / opening: every row below snapped 123 px;
 *  - pinning a chat: the rows below snapped 47 px as the tile popped in;
 *  - archiving a chat: the rows below snapped 40 px;
 *  - hiding the sidebar (Cmd+B): the centred chat column first jumped RIGHT
 *    by half the sidebar width, then slid left;
 *  - the phone drawer animated `width` 0 <-> 100vw along with the transform,
 *    so the rows re-wrapped on every frame, and did so under reduced motion;
 *  - phone, "Add" -> Chat with the list showing: the drawer stayed over the new
 *    draft, which was mounted behind it and could not be tapped;
 *  - boot with a slow topics list: "Welcome to Topics" and then "No chats open"
 *    were shown for up to a second before the chats that WERE open.
 *
 * "Travels" means: the element ends where it must, it passes through at least
 * three intermediate positions, and no single frame carries more than 70% of
 * the whole distance. A one-frame jump fails all three.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { archiveTopic, createTopic, deleteTopic, resetPaneStore, unarchiveTopic, resetProjectPanes, seedProjectInnerChats, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SIDEBAR = '[aria-label="Topics sidebar"]';
const STAMP = Date.now();
const PROJECT = canonicalTmpDir("e2e-sbmotion");
const PROJECT_NAME = PROJECT.split("/").pop() as string;

const NAMES = {
  bottom: `SBM-bottom-${STAMP}`,
  top: `SBM-top-${STAMP}`,
  inner: [1, 2, 3].map((i) => `SBM-inner-${i}-${STAMP}`),
};
const ids: Record<string, string> = {};
const created: string[] = [];

const row = (name: string) => `${SIDEBAR} [role="treeitem"][aria-label="${name}"]`;
const projectRowSelector = `${SIDEBAR} [data-testid="project-toggle-${PROJECT_NAME}"]`;

interface Box { x: number; y: number; w: number; h: number; o: number }
type Frame = { t: number } & Record<string, Box | null>;

/**
 * Samples every animation frame for `ms`, while `act` runs. The sampler is
 * armed (first frame recorded) BEFORE the gesture, so the first frame after it
 * is never missed.
 */
async function sampleDuring(
  page: Page,
  targets: Record<string, string>,
  ms: number,
  act: () => Promise<unknown>,
): Promise<Frame[]> {
  await page.evaluate(() => { (window as unknown as { __sbArmed?: boolean }).__sbArmed = false; });
  const run = page.evaluate(
    ({ targets, ms }) =>
      new Promise<Frame[]>((resolve) => {
        const out: Frame[] = [];
        const t0 = performance.now();
        const read = (sel: string): Box | null => {
          const all = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          const el = all.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; }) ?? all[0];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, o: Number(getComputedStyle(el).opacity) };
        };
        const tick = () => {
          const now = performance.now();
          const f = { t: now - t0 } as Frame;
          for (const [k, sel] of Object.entries(targets)) f[k] = read(sel);
          out.push(f);
          (window as unknown as { __sbArmed?: boolean }).__sbArmed = true;
          if (now - t0 >= ms) resolve(out);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { targets, ms },
  );
  await page.waitForFunction(() => (window as unknown as { __sbArmed?: boolean }).__sbArmed === true);
  await act();
  return run;
}

/** Positions of one axis of one target, frames where it exists. */
function track(frames: Frame[], key: string, axis: keyof Box): number[] {
  return frames.map((f) => f[key]).filter((b): b is Box => !!b).map((b) => b[axis]);
}

/** The judgement: did it TRAVEL from its first to its last value? */
function travel(values: number[]) {
  const start = values[0];
  const end = values[values.length - 1];
  const distance = Math.abs(end - start);
  const lo = Math.min(start, end) + 2;
  const hi = Math.max(start, end) - 2;
  const intermediate = new Set(values.filter((v) => v > lo && v < hi).map((v) => Math.round(v))).size;
  let maxStep = 0;
  for (let i = 1; i < values.length; i++) maxStep = Math.max(maxStep, Math.abs(values[i] - values[i - 1]));
  return { start: Math.round(start), end: Math.round(end), distance: Math.round(distance), intermediate, maxStep: Math.round(maxStep) };
}

function expectTravel(values: number[], what: string, minDistance = 20) {
  const m = travel(values);
  expect(m.distance, `${what}: it must actually move (${JSON.stringify(m)})`).toBeGreaterThan(minDistance);
  expect(m.intermediate, `${what}: it must pass through intermediate positions, not land in one frame (${JSON.stringify(m)})`).toBeGreaterThanOrEqual(3);
  expect(m.maxStep, `${what}: no single frame may carry most of the move (${JSON.stringify(m)})`).toBeLessThanOrEqual(m.distance * 0.7);
}

/** Two frames with nothing moving between them: the column is at rest. */
async function settled(page: Page, sel: string): Promise<void> {
  let prev = "";
  await expect.poll(async () => {
    const now = await page.evaluate(
      (s) => new Promise<string>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => {
        ok(Array.from(document.querySelectorAll(s)).map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.y)}:${Math.round(r.x)}`; }).join("|"));
      }))),
      sel,
    );
    const same = now === prev;
    prev = now;
    return same;
  }, { timeout: 10_000, intervals: [100, 150, 200] }).toBe(true);
}

/** The project block with its rows: the project window mounted, the order settled. */
async function openProjectBlock(page: Page) {
  await openSidebar(page);
  await page.locator(projectRowSelector).click();
  await expect(page.locator(row(NAMES.inner[2]))).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(row(NAMES.bottom))).toBeVisible();
  await settled(page, `${SIDEBAR} [role="treeitem"]`);
  const order = await page.locator(`${SIDEBAR} [role="treeitem"]`).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 30)));
  const at = (n: string) => order.findIndex((x) => x?.startsWith(n) || x?.includes(n));
  // The project header is not a treeitem; its rows stand for the block.
  // `bottom` is the oldest activity: last in the column, under the project
  // block and under `top` (whose place against the project varies with focus).
  expect(at(NAMES.inner[0]), `order: ${order.join(" | ")}`).toBeLessThan(at(NAMES.bottom));
  expect(at(NAMES.top), `order: ${order.join(" | ")}`).toBeLessThan(at(NAMES.bottom));
}

async function openSidebar(page: Page) {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
  });
  await page.addInitScript(() => {
    const raw = localStorage.getItem("app-settings");
    const cur: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    cur.sidebarCollapsed = false;
    localStorage.setItem("app-settings", JSON.stringify(cur));
  });
  await page.goto("/");
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 20_000 });
}

test.describe("Sidebar motion contract", () => {
  // The suite runs with reduced motion on (playwright.config.ts); motion is
  // exactly what this file measures, so it asks for the ordinary preference.
  // `contextOptions` is one fixture: this replaces it, it does not merge.
  test.use({ contextOptions: { reducedMotion: "no-preference" } });
  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(PROJECT, { recursive: true });
    fs.writeFileSync(`${PROJECT}/package.json`, JSON.stringify({ name: PROJECT_NAME }));
    // Creation order is activity order: `bottom` is the oldest, so it sorts
    // under the project block; `top` is the newest, above it.
    ids.bottom = (await createTopic(request, NAMES.bottom)).id;
    for (const [i, name] of NAMES.inner.entries()) {
      ids[`inner${i}`] = (await createTopic(request, name, { projectPath: PROJECT })).id;
    }
    ids.top = (await createTopic(request, NAMES.top)).id;
    created.push(...Object.values(ids));
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [ids.top, ids.bottom]);
    await resetProjectPanes(request, PROJECT);
    await seedProjectPane(request, PROJECT);
    await seedProjectInnerChats(request, PROJECT, [ids.inner0, ids.inner1, ids.inner2]);
    // The reset above touches `updatedAt` in parallel (it unarchives), so the
    // activity order is re-declared one write at a time: `top`, then the
    // project block, then `bottom`.
    for (const id of [ids.bottom, ids.inner0, ids.inner1, ids.inner2, ids.top]) {
      await request.patch(`${E2E_BASE}/api/topics/${id}`, { data: { color: "#3366cc" } });
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(PROJECT);
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("an accordion closing and opening moves the rows below, it does not snap them", async ({ page }) => {
      await openProjectBlock(page);

      const collapse = await sampleDuring(page, { below: row(NAMES.bottom) }, 700, () =>
        page.locator(`${SIDEBAR} button[aria-label="Collapse ${PROJECT_NAME}"]`).click());
      expectTravel(track(collapse, "below", "y"), "row below a closing accordion");

      await settled(page, `${SIDEBAR} [role="treeitem"]`);
      const expand = await sampleDuring(page, { below: row(NAMES.bottom), child: row(NAMES.inner[0]) }, 700, () =>
        page.locator(`${SIDEBAR} button[aria-label="Expand ${PROJECT_NAME}"]`).click());
      expectTravel(track(expand, "below", "y"), "row below an opening accordion");
      // The rows that appear fade in where they land instead of popping.
      const childOpacity = track(expand, "child", "o");
      expect(Math.min(...childOpacity), `a row that appears fades in (${childOpacity.slice(0, 6).join(",")})`).toBeLessThan(0.9);
    });

    test("new activity lifts a row over the others: it travels there", async ({ page }) => {
      await openProjectBlock(page);

      // A real update from the server: PATCH bumps `updatedAt` and broadcasts
      // `topic:updated`, which is what a send or a rename does to the sort.
      const frames = await sampleDuring(page, { lifted: row(NAMES.bottom), pushed: row(NAMES.top) }, 1500, () =>
        page.request.patch(`${E2E_BASE}/api/topics/${ids.bottom}`, { data: { color: "#aa3377" } }));
      const lifted = track(frames, "lifted", "y");
      expect(lifted[lifted.length - 1], "the row with new activity ends higher").toBeLessThan(lifted[0]);
      expectTravel(lifted, "row lifted by recency");
      expectTravel(track(frames, "pushed", "y"), "row pushed down by recency");
    });

    test("pinning a chat: the tiles fade in and the rows below make room smoothly", async ({ page }) => {
      await openProjectBlock(page);

      // The LAST row is pinned, so every row above it is pushed by the block.
      await page.locator(row(NAMES.bottom)).click({ button: "right" });
      const pin = page.getByText(/^(Fissa|Pin)$/).first();
      await expect(pin).toBeVisible();
      const frames = await sampleDuring(page, { pushed: row(NAMES.top), pinned: '[data-testid="sidebar-pinned-section"]' }, 700, () => pin.click());
      expectTravel(track(frames, "pushed", "y"), "row pushed by a new pinned tile", 10);
      const pinnedOpacity = track(frames, "pinned", "o");
      expect(pinnedOpacity.length, "the pinned block appears").toBeGreaterThan(0);
      expect(Math.min(...pinnedOpacity), "the pinned block fades in").toBeLessThan(0.9);
    });

    test("archiving a chat: the rows below close the gap smoothly", async ({ page }) => {
      await openProjectBlock(page);

      const frames = await sampleDuring(page, { below: row(NAMES.bottom) }, 900, () =>
        archiveTopic(page.request, ids.top));
      await expect(page.locator(row(NAMES.top))).toHaveCount(0);
      expectTravel(track(frames, "below", "y"), "row below an archived one", 10);
      await unarchiveTopic(page.request, ids.top);
    });

    test("hiding the sidebar: the centred chat column only ever moves left", async ({ page }) => {
      await openSidebar(page);
      await page.locator(row(NAMES.top)).click();
      const input = '[data-testid="chat-input-area"]';
      await expect(page.locator(input).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
      await settled(page, input);

      const frames = await sampleDuring(page, { input }, 700, () => page.keyboard.press("ControlOrMeta+b"));
      const xs = track(frames, "input", "x");
      const m = travel(xs);
      expect(m.end, `the column ends further left (${JSON.stringify(m)})`).toBeLessThan(m.start);
      let worstRight = 0;
      for (let i = 1; i < xs.length; i++) worstRight = Math.max(worstRight, xs[i] - xs[i - 1]);
      expect(Math.round(worstRight), `THE DEFECT: a frame moved the column RIGHT (${xs.slice(0, 6).map(Math.round).join(",")})`).toBeLessThanOrEqual(1);
      expectTravel(xs, "chat column on sidebar hide");
    });

    test("boot with a slow topics list never claims that nothing is open", async ({ page }) => {
      // The project window first, so it is the pane on screen at boot: its
      // chats are exactly what a slow topics list leaves unknown.
      const projectPane = await seedProjectPane(page.request, PROJECT);
      await resetPaneStore(page.request, [projectPane, ids.top]);
      let topicsAnsweredAt = "";
      await page.route(/\/api\/topics(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        // The latency, not the data: the real response, 900 ms late.
        const res = await route.fetch();
        await new Promise((ok) => setTimeout(ok, 900));
        await route.fulfill({ response: res });
        topicsAnsweredAt ||= String(await page.evaluate(() => Math.round(performance.now())).catch(() => -1));
      });
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { __falseEmpty: string[] }).__falseEmpty = seen;
        const t0 = performance.now();
        const tick = () => {
          const main = document.getElementById("main-content");
          const text = main?.innerText ?? "";
          for (const claim of ["Welcome to Topics", "No chats open"]) {
            if (!text.includes(claim)) continue;
            const now = Math.round(performance.now());
            const i = seen.findIndex((x) => x.startsWith(claim));
            if (i < 0) seen.push(`${claim} @${now}-${now}ms`);
            else seen[i] = seen[i].replace(/-\d+ms$/, `-${now}ms`);
          }
          if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await openSidebar(page);
      await expect(page.locator(row(NAMES.top))).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid="project-window"]').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid="chat-input-area"]').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
      const seen = await page.evaluate(() => (window as unknown as { __falseEmpty: string[] }).__falseEmpty);
      expect(seen, `an empty state was shown while the open chats were still loading (topics answered @${topicsAnsweredAt}ms)`).toEqual([]);
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    async function openPhone(page: Page) {
      await page.addInitScript(() => localStorage.setItem("topics-mobile-drawer-collapsed", "0"));
      await openSidebar(page);
      await expect(page.locator(row(NAMES.top))).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => page.locator(SIDEBAR).evaluate((el) => Math.round(el.getBoundingClientRect().x)), { timeout: 5_000 }).toBe(0);
    }

    test("the drawer slides on transform alone, at a constant width", async ({ page }) => {
      await openPhone(page);
      const frames = await sampleDuring(page, { drawer: SIDEBAR }, 700, () => page.locator(row(NAMES.top)).tap());
      const widths = track(frames, "drawer", "w");
      expect(Math.min(...widths), `THE DEFECT: the drawer shrinks while it slides (${widths.slice(0, 8).map(Math.round).join(",")})`).toBeGreaterThanOrEqual(374);
      const xs = track(frames, "drawer", "x");
      expect(xs[xs.length - 1], "the drawer ends off screen").toBeLessThanOrEqual(-374);
      expectTravel(xs, "drawer closing");
      const transition = await page.locator(SIDEBAR).evaluate((el) => getComputedStyle(el).transitionProperty);
      expect(transition, "width is not part of the drawer's transition").not.toContain("width");
    });

    test("tapping a chat uncovers it at least as fast as the old width slide did", async ({ page }) => {
      // Tapping a row is the most frequent navigation on a phone, and what the
      // user waits for is the chat behind the drawer. The old slide shrank the
      // width AND translated, so its right edge followed 375*(1-p)^2 over
      // 200ms `ease`: half the chat uncovered at ~28ms, 90% at ~74ms, all of it
      // at 200ms. A transform-only slide covers only 375*(1-p), so it needs a
      // shorter, harder-decelerating curve to keep that pace.
      //
      // Judged on the transition's OWN clock (`currentTime` of the drawer's
      // transform transition), not on the wall clock: a loaded CI machine
      // stretches the wall clock and would make the test about the machine.
      await openPhone(page);
      await page.evaluate(() => {
        const w = window as unknown as { __reveal: { ct: number | null; right: number }[]; __revealStop: boolean };
        w.__reveal = [];
        w.__revealStop = false;
        const nav = document.querySelector('[aria-label="Topics sidebar"]') as HTMLElement;
        const tick = () => {
          const transition = nav.getAnimations().find((a) => (a as Animation & { transitionProperty?: string }).transitionProperty === "transform");
          const ct = transition ? Number(transition.currentTime) : null;
          w.__reveal.push({ ct, right: Math.max(0, nav.getBoundingClientRect().right) });
          if (!w.__revealStop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.locator(row(NAMES.top)).tap();
      await expect.poll(() => page.locator(SIDEBAR).evaluate((el) => Math.max(0, el.getBoundingClientRect().right)), { timeout: 5_000 }).toBe(0);
      const samples = await page.evaluate(() => {
        const w = window as unknown as { __reveal: { ct: number | null; right: number }[]; __revealStop: boolean };
        w.__revealStop = true;
        return w.__reveal;
      });
      const width = 375;
      // First frame in which at most `left` of the drawer still covers the chat.
      const at = (left: number) => samples.find((s) => s.right <= left * width);
      const half = at(0.5);
      const ninety = at(0.1);
      const trace = samples.filter((s) => s.ct !== null).slice(0, 12).map((s) => `${Math.round(s.ct!)}ms:${Math.round(s.right)}`).join(" ");
      expect(half?.ct ?? null, `half of the chat uncovered while the slide runs (${trace})`).not.toBeNull();
      expect(ninety?.ct ?? null, `90% of the chat uncovered while the slide runs (${trace})`).not.toBeNull();
      // One 60Hz frame (17ms) of slack on top of the old slide's pace.
      expect(half!.ct!, `THE DEFECT: half of the chat is uncovered later than the old slide did it (${trace})`).toBeLessThanOrEqual(28 + 17);
      expect(ninety!.ct!, `THE DEFECT: 90% of the chat is uncovered later than the old slide did it (${trace})`).toBeLessThanOrEqual(74 + 17);
      const duration = await page.locator(SIDEBAR).evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(duration.split(",").map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)).every((ms) => ms <= 200), `the whole slide lasts no longer than the old 200ms (${duration})`).toBe(true);
    });

    test("Pencil, with the list showing: the drawer gets out of the way", async ({ page }) => {
      await openPhone(page);
      // The pencil (mobile-chrome-feedback A6): the tap IS the new chat, so
      // there is no menu step any more — the drawer closes over the draft
      // straight from the door, which is what this probe samples.
      await page.getByTestId("pane-add-menu-trigger").tap();
      // Judged on the FIRST frame the drawer is off screen, sampled in the page:
      // that is the moment the user sees the draft and reaches for it. A poll
      // from the test lands on whichever frame it happens to hit, and the scrim
      // used to stay a tap target for the last frames of its fade, after the
      // drawer had gone: a poll landing there failed, one landing later passed.
      await page.evaluate(() => {
        const w = window as unknown as { __drawerGone: string | null };
        w.__drawerGone = null;
        const t0 = performance.now();
        const tick = () => {
          const nav = document.querySelector('[aria-label="Topics sidebar"]') as HTMLElement;
          if (Math.round(nav.getBoundingClientRect().right) <= 0) {
            const composer = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-input-area"] textarea'))
              .find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            if (!composer) { w.__drawerGone = "no composer on screen"; return; }
            const r = composer.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            w.__drawerGone = hit === composer ? "composer"
              : hit ? `${hit.tagName.toLowerCase()}${hit.hasAttribute("data-sidebar-scrim") ? "[data-sidebar-scrim]" : ""}.${String(hit.className).slice(0, 60)}` : "nothing";
            return;
          }
          if (performance.now() - t0 < 10_000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // No menu step: the pencil tap above already opened the draft (A6), the
      // drawer is closing over it and the probe is sampling.
      const drawerGone = () => page.evaluate(() => (window as unknown as { __drawerGone: string | null }).__drawerGone);
      await expect.poll(drawerGone, { message: "the drawer closes over the new draft", timeout: 5_000 }).not.toBeNull();
      const underFinger = await drawerGone();
      expect(underFinger, "the draft's composer is the thing under the finger as soon as the drawer is gone").toBe("composer");
      const textarea = page.locator('[data-testid="chat-input-area"] textarea').filter({ visible: true }).first();
      await expect(textarea).toBeVisible();
      await textarea.tap();
    });
  });

  test.describe("phone, reduced motion", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, contextOptions: { reducedMotion: "reduce" } });

    test("the drawer does not slide at all under reduced motion", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("topics-mobile-drawer-collapsed", "0"));
      await openSidebar(page);
      await expect(page.locator(row(NAMES.top))).toBeVisible({ timeout: 15_000 });
      const frames = await sampleDuring(page, { drawer: SIDEBAR }, 500, () => page.locator(row(NAMES.top)).tap());
      // The RIGHT edge: it is what the eye follows, and it is defined whether
      // the drawer leaves by sliding or by shrinking.
      const rights = frames.map((f) => f.drawer).filter((b): b is Box => !!b).map((b) => b.x + b.w);
      const m = travel(rights);
      expect(m.end, "the drawer ends off screen").toBeLessThanOrEqual(0);
      expect(m.intermediate, `no intermediate positions under reduced motion (${rights.slice(0, 8).map(Math.round).join(",")})`).toBe(0);
    });
  });
});
