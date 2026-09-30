/**
 * THE LOADING CONTRACT of the non-chat panes, frame by frame.
 *
 * Findings of the 2026-09-29 fluidity audit, each re-measured here with the
 * audit's own method (every animation frame, from the first frame of the
 * document, via `helpers/frame-probe`):
 *
 *  - PANELOAD-04, the diff panel: every file of a review unmounted the
 *    breadcrumb and the diff for a centred spinner, and a single-hunk file then
 *    moved 25.5 px down and back up under a "looking for hunks" row;
 *  - PANELOAD-05, lazy panes: the dashboard waited as a 16 px ring in an empty
 *    rectangle, then appeared whole in one frame;
 *  - PANELOAD-06, the Git section of a project: opening it grew it twice, to a
 *    bare floor first and by another 237 px when the rows arrived;
 *  - PANELOAD-07, a terminal: xterm painted one frame at its default 80x24 in
 *    the corner, then jumped to the pane's size;
 *  - PANELOAD-08, a browser pane opened on a URL: the New Tab page flashed
 *    before the loader.
 *
 * Where the wait is a chunk, the chunk is held back by a route for a fixed
 * time, so the loading frames exist on every machine and the contract is about
 * what they show, not about how fast this laptop is.
 */
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { createTerminalSession, createTopic, deleteTerminalSession, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { canonicalTmpDir, initGitRepo, removeTmpDir } from "./helpers/file-project";
import { BrowserProcessPageV2 } from "./fixtures/browser-v2.fixture";
import { armFrameProbe, markFrame, maxStep, nextFrames, presentSamples, readTimeline } from "./helpers/frame-probe";

hermetic(test);

/** Hold every request for a lazy chunk matching `name` for `ms`. */
async function holdChunk(page: Page, name: string, ms: number) {
  await page.route(new RegExp(`/assets/${name}-[^/]+\\.js`), async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

test.describe("pane loading contract", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── A git project: eight changed files, one of them with several hunks. ──
  const PROJECT = canonicalTmpDir("e2e-paneload");
  const LINES = Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`);
  let projectTopic: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(`${PROJECT}/src`, { recursive: true });
    for (let i = 1; i <= 8; i++) writeFileSync(`${PROJECT}/src/mod${i}.ts`, LINES.join("\n") + "\n");
    initGitRepo(PROJECT, "initial");
    for (let i = 1; i <= 8; i++) {
      const next = [...LINES];
      next[5] = `export const line5 = "changed ${i}";`;
      // mod2 changes far apart: three hunks, so its strip of hunk actions shows.
      if (i === 2) { next[25] = `export const line25 = "far";`; next[50] = `export const line50 = "farther";`; }
      writeFileSync(`${PROJECT}/src/mod${i}.ts`, next.join("\n") + "\n");
    }
    projectTopic = (await createTopic(request, "e2e-paneload", { projectPath: PROJECT })).id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopic) await deleteTopic(request, projectTopic).catch(() => {});
    removeTmpDir(PROJECT);
  });

  const projectPane = () => `project:${encodeURIComponent(PROJECT)}`;

  async function openGitSection(page: Page) {
    const header = page.getByTestId("project-sidebar-git").first();
    await expect(header).toBeVisible({ timeout: 30_000 });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(page.locator('[data-git-file="src/mod1.ts"]').first()).toBeVisible({ timeout: 15_000 });
  }

  test("the Git section opens once, to the height it keeps", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-06" });
    await resetPaneStore(page.request, [projectPane()]);
    // The panel chunk held back: the click lands before it, as on a cold window.
    await holdChunk(page, "GitChanges", 500);
    await armFrameProbe(page, {
      section: '[data-testid="project-sidebar-git-section"]',
      rows: '[data-git-file]',
    });
    await page.goto("/");
    const header = page.getByTestId("project-sidebar-git").first();
    await expect(header).toBeVisible({ timeout: 30_000 });
    await nextFrames(page, 10);
    const tOpen = await markFrame(page, "open");
    // Straight to the click, no hover first: the cold path.
    await header.dispatchEvent("click");
    await expect(page.locator('[data-git-file="src/mod1.ts"]').first()).toBeVisible({ timeout: 15_000 });
    await nextFrames(page, 20);
    const all = presentSamples(await readTimeline(page, null), "section");
    const closed = all.filter((s) => s.t < tOpen).pop()!.h;
    const h = [closed, ...all.filter((s) => s.t >= tOpen).map((s) => s.h)];
    const firstOpen = h.find((x) => Math.abs(x - closed) > 2)!;
    const final = h[h.length - 1];
    const steps = h.slice(1).map((x, i) => Math.round(x - h[i])).filter((d) => Math.abs(d) > 2);
    console.log("[PANELOAD-06] heights", JSON.stringify({ closed, firstOpen, final, steps }));
    expect(Math.abs(final - firstOpen), "the section grew a second time after opening").toBeLessThanOrEqual(12);
  });

  test("the diff panel keeps its breadcrumb and does not move when files are switched", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-04" });
    await resetPaneStore(page.request, [projectPane()]);
    await armFrameProbe(page, {
      breadcrumb: '[data-testid="breadcrumb-nav"]',
      diff: '[data-testid="diff-viewer"]',
      filePane: '[data-testid="file-pane"], [data-testid="file-pane-loading"]',
    });
    await page.goto("/");
    await openGitSection(page);
    await nextFrames(page, 10);

    await markFrame(page, "open");
    await page.locator('[data-git-file="src/mod4.ts"]').first().click();
    await expect(page.getByTestId("diff-viewer")).toBeVisible({ timeout: 15_000 });
    await nextFrames(page, 40);
    await markFrame(page, "switch");
    await page.locator('[data-git-file="src/mod2.ts"]').first().click();
    await expect(page.getByTestId("hunk-actions")).toBeVisible({ timeout: 15_000 });
    await nextFrames(page, 40);
    await markFrame(page, "switch2");
    const sw1 = await readTimeline(page, "switch", "switch2");
    await page.locator('[data-git-file="src/mod5.ts"]').first().click();
    await expect(page.getByTestId("hunk-actions")).toHaveCount(0);
    await nextFrames(page, 40);
    await markFrame(page, "end");
    const sw2 = await readTimeline(page, "switch2", "end");

    const open = await readTimeline(page, "open", "switch");
    const sw = await readTimeline(page, "switch", "end");

    // First open: once the pane exists, the breadcrumb is there on every frame,
    // and the diff lands where it stays.
    const firstPane = open.frames.findIndex((f) => f.els.filePane);
    const noCrumb = open.frames.slice(firstPane).filter((f) => !f.els.breadcrumb).length;
    const diffOpen = presentSamples(open, "diff");
    const openShift = { noCrumb, yStep: maxStep(diffOpen, "y"), hStep: maxStep(diffOpen, "h") };
    console.log("[PANELOAD-04] open", JSON.stringify(openShift));
    expect(noCrumb, "frames without the breadcrumb while the first diff loaded").toBe(0);
    expect(openShift.yStep, "the first diff moved after landing").toBeLessThanOrEqual(1);

    // Switching: the breadcrumb and the diff never leave the screen.
    const gaps = sw.frames.filter((f) => !f.els.breadcrumb || !f.els.diff).length;
    const ys = presentSamples(sw, "diff").map((s) => s.y);
    const missing = sw.frames.filter((f) => !f.els.breadcrumb || !f.els.diff).slice(0, 8).map((f) => `${Math.round(f.t - sw.frames[0].t)}:${f.els.breadcrumb ? "" : "B"}${f.els.diff ? "" : "D"}${f.els.filePane ? "" : "P"}`);
    console.log("[PANELOAD-04] missing", missing.join(" "));
    console.log("[PANELOAD-04] switch", JSON.stringify({ gaps, ys: [...new Set(ys)] }));
    // The preview pane is REPLACED on each click (a new pane), so the diff's DOM
    // node is new; what must not happen is a frame without it.
    expect(gaps, "frames where the breadcrumb or the diff was gone during a switch").toBe(0);
    // Each switch moves the diff at most ONCE (the new file's hunk strip, if it
    // has one, lands in the same commit as its text).
    for (const [name, w] of [["to mod2", sw1], ["to mod5", sw2]] as const) {
      const moves = presentSamples(w, "diff").slice(1).filter((s, i, arr) => Math.abs(s.y - (i === 0 ? presentSamples(w, "diff")[0].y : arr[i - 1].y)) > 1).length;
      expect(moves, `the diff moved more than once switching ${name}`).toBeLessThanOrEqual(1);
    }
  });

  test("a lazy dashboard waits as a dashboard, at its own geometry", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-05" });
    await resetPaneStore(page.request, ["__dashboard__"]);
    await holdChunk(page, "DashboardPane", 700);
    await armFrameProbe(page, {
      skel: '[data-testid="pane-skeleton-dashboard"]',
      skelGrid: '[data-testid="pane-skeleton-kpi-grid"]',
      skelChart: '[data-testid="pane-skeleton-chart"]',
      pane: '[data-testid="dashboard-pane"]',
      grid: '[data-testid="kpi-card-grid"]',
      chart: '[data-testid="dashboard-chart"]',
    });
    await page.goto("/");
    await expect(page.getByTestId("kpi-card-grid")).toBeVisible({ timeout: 30_000 });
    await nextFrames(page, 20);
    const tl = await readTimeline(page, null);
    const skel = presentSamples(tl, "skel");
    const pane = presentSamples(tl, "pane");
    console.log("[PANELOAD-05] skeleton frames", skel.length);
    expect(skel.length, "no dashboard skeleton while the chunk loaded").toBeGreaterThan(0);
    const holes = tl.frames.filter((f) => f.t >= skel[0].t && f.t < pane[0].t && !f.els.skel && !f.els.pane).length;
    expect(holes, "frames with neither the skeleton nor the dashboard").toBe(0);
    const sg = presentSamples(tl, "skelGrid")[0];
    const sc = presentSamples(tl, "skelChart")[0];
    const last = tl.frames[tl.frames.length - 1].els;
    const geo = { grid: [sg.y, sg.w, sg.h, last.grid!.y, last.grid!.w, last.grid!.h], chart: [sc.y, sc.h, last.chart!.y, last.chart!.h] };
    console.log("[PANELOAD-05] geometry", JSON.stringify(geo));
    expect(Math.abs(sg.y - last.grid!.y), "KPI grid y").toBeLessThanOrEqual(2);
    expect(Math.abs(sg.h - last.grid!.h), "KPI grid height").toBeLessThanOrEqual(2);
    expect(Math.abs(sc.y - last.chart!.y), "chart y").toBeLessThanOrEqual(2);
    expect(Math.abs(sc.h - last.chart!.h), "chart height").toBeLessThanOrEqual(2);
  });

  test("a terminal paints its first frame at the pane's size", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-07" });
    const sess = await createTerminalSession(request, { cwd: PROJECT, name: "paneload" });
    try {
      await resetPaneStore(page.request, [`terminal:${sess.id}`]);
      await armFrameProbe(page, { screen: ".xterm-screen" });
      await page.goto("/");
      await expect(page.locator(".xterm-screen").first()).toBeVisible({ timeout: 30_000 });
      await nextFrames(page, 60);
      const tl = await readTimeline(page, null);
      const screen = presentSamples(tl, "screen");
      const first = screen[0];
      const last = screen[screen.length - 1];
      console.log("[PANELOAD-07] first", first.w, first.h, "final", last.w, last.h);
      // One cell of slack: a late font can still refine the fit by a column.
      expect(Math.abs(first.w - last.w), "the terminal's first frame was not at the pane's width").toBeLessThanOrEqual(12);
      expect(Math.abs(first.h - last.h), "the terminal's first frame was not at the pane's height").toBeLessThanOrEqual(20);
    } finally {
      await deleteTerminalSession(request, sess.id).catch(() => {});
    }
  });

  test("a browser pane opened on a URL never shows the New Tab page", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-08" });
    const site: Server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Paneload</title><h1>Report</h1>"); });
    await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/report`;
    const chat = await createTopic(request, "e2e-paneload-browser");
    try {
      const bp = new BrowserProcessPageV2(page);
      await bp.mockBrowserWs({ framesPerSecond: 15 });
      await bp.mockBrowserContexts([]);
      await bp.mockRemoteBrowserPane({ connected: true, url, title: "Paneload", hasScreenshot: true });
      await page.route(/\/api\/browsers\/framable/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }));
      await resetPaneStore(page.request, [chat.id]);
      await armFrameProbe(page, { newTab: '[data-testid="browser-new-tab"]', pane: "[data-browser-pane]" });
      await page.goto("/");
      await expect(page.getByTestId("chat-input-area").first()).toBeVisible({ timeout: 30_000 });
      await nextFrames(page, 10);
      await markFrame(page, "open");
      await page.evaluate(({ tid, u }) => window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } })), { tid: chat.id, u: url });
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 20_000 });
      await nextFrames(page, 60);
      const tl = await readTimeline(page, "open");
      const flash = presentSamples(tl, "newTab");
      console.log("[PANELOAD-08] new-tab frames", flash.length, flash.length ? Math.round(flash[flash.length - 1].t - flash[0].t) : 0, "ms");
      expect(flash.length, "the New Tab page showed before the URL").toBe(0);
    } finally {
      site.close();
      await deleteTopic(request, chat.id).catch(() => {});
    }
  });
});
