/**
 * A HEAVY NATIVE PANE IS SIGNALLED, PAUSES WITHOUT THE FOCUS, AND COMES BACK
 * WITHOUT A RELOAD.
 *
 * Playwright runs the web build in Chromium: there is no WKWebView here. The
 * pane takes its native branch because `__TAURI_INTERNALS__` is faked (the same
 * disguise as `idle-frame-budget.spec.ts`), and the fake shell is what makes the
 * page heavy: every `perf_metrics` reports 17% of a core for this pane. What is
 * asserted is what the person sees (the tab glyph, the paused card, the still)
 * and what the shell receives (no reload, no navigation, no second open).
 *
 * The clock is Playwright's: the verdict needs 8 s of live cover plus 10 s of
 * samples, and the pause a 2 s dwell. `runFor` jumps over them instead of
 * sleeping through them.
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { seedPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** A 1x1 PNG: the still the fake shell hands back. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function seedBrowserPane(request: Parameters<typeof seedPaneStore>[0], ctx: string): Promise<string> {
  const paneId = `browser:${ctx}`;
  await seedPaneStore(request, () => ({
    panes: { [paneId]: { id: paneId, type: "browser", title: ctx, url: "https://example.com/" } },
    groups: { "group:default": { id: "group:default", paneIds: [paneId], splitRatio: 1, splitAxis: "horizontal" } },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
  return paneId;
}

/** The Tauri shell, faked: the loopback proxy sent home, and a recorder on every command. */
async function fakeHeavyShell(page: Page, ctx: string, png: string): Promise<void> {
  await page.addInitScript(({ ctx, png }) => {
    const w = window as unknown as { __calls: string[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    const proxy = "//127.0.0.1:13333";
    const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
    const home = (u: string): string =>
      u.startsWith(`http:${proxy}`) ? location.origin + u.slice(`http:${proxy}`.length)
      : u.startsWith(`ws:${proxy}`) ? `${wsScheme}//${location.host}${u.slice(`ws:${proxy}`.length)}`
      : u;
    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(
        typeof input === "string" ? home(input)
        : input instanceof URL ? home(input.href)
        : new Request(home(input.url), input),
        init,
      )) as typeof fetch;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct: (Target, args: [string | URL, (string | string[])?]) => new Target(home(String(args[0])), args[1]),
    });
    const perf = {
      version: "e2e", total_mb: 900, resident_mb: 600, renderer_mb: 400, gpu_mb: 100, other_mb: 400,
      cpu_percent: 22, cpu_renderer: 17, cpu_gpu: 2, cpu_sampled: 3, cpu_pids: 3, process_count: 3, partial: false,
      webviews: [{ label: `browserpane-${ctx}`, pid: 4242, memory_mb: 180, cpu_percent: 17 }],
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: (cmd: string) => {
        w.__calls.push(cmd);
        if (cmd === "perf_metrics") return Promise.resolve(perf);
        if (cmd === "browser_screenshot") return Promise.resolve(png);
        if (cmd === "browser_eval_js") return Promise.resolve("");
        if (cmd === "browser_devtools_open") return Promise.resolve(false);
        if (cmd.startsWith("browser_take_") || cmd === "browser_download_progress") return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  }, { ctx, png });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls.slice());
const setWindowFocus = (page: Page, focused: boolean) =>
  page.evaluate((f) => window.dispatchEvent(new CustomEvent("topics:window-focus", { detail: f })), focused);

test.describe("heavy native browser pane", () => {
  test.describe.configure({ timeout: 90_000 });

  test("signalled on the tab, paused behind a still without the focus, back live without a reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-HEAVY-04" });
    const ctx = "heavy-pane-probe";
    const paneId = await seedBrowserPane(request, ctx);
    await page.clock.install();
    await fakeHeavyShell(page, ctx, PNG_1X1);
    await goToApp(page);
    await expect.poll(async () => (await calls(page)).filter((c) => c === "browser_open").length, { timeout: 30_000 }).toBe(1);

    // The pane is the focused one: its own tab clicked, whatever the baseline focused.
    await page.locator(`[data-pane-id="${paneId}"]`).getByTestId("pane-tab-label").click();
    const glyph = page.locator(`[data-pane-id="${paneId}"] [data-testid="browser-tab-type-icon"]`);
    await page.clock.runFor(25_000);
    await expect(glyph).toHaveAttribute("data-kind", "heavy", { timeout: 10_000 });

    // The window loses the focus: after the dwell the pane pauses.
    await setWindowFocus(page, false);
    await page.clock.runFor(3_000);
    await page.clock.runFor(1_000);
    await expect(glyph).toHaveAttribute("data-kind", "heavy-paused", { timeout: 10_000 });
    await expect(page.getByTestId("browser-paused")).toBeVisible();
    await expect(page.getByTestId("browser-paused-still")).toHaveCount(1);
    const pausedAt = (await calls(page)).length;

    // The window comes back: live again, same document.
    await setWindowFocus(page, true);
    await expect(page.getByTestId("browser-paused")).toHaveCount(0, { timeout: 10_000 });
    await expect(glyph).toHaveAttribute("data-kind", "heavy");

    // Paused again, the tab sheet opened and closed over it, then the button.
    await setWindowFocus(page, false);
    await page.clock.runFor(3_000);
    await page.clock.runFor(1_000);
    await expect(page.getByTestId("browser-paused")).toBeVisible({ timeout: 10_000 });
    await page.locator(`[data-pane-id="${paneId}"]`).getByTestId("browser-tab-menu").click();
    await expect(page.getByTestId("browser-tab-sheet")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("browser-tab-sheet")).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId("browser-paused-resume").click();
    await expect(page.getByTestId("browser-paused")).toHaveCount(0, { timeout: 5_000 });

    const after = await calls(page);
    const doors = ["browser_reload", "browser_navigate", "browser_close"];
    expect(after.filter((c) => doors.includes(c))).toEqual([]);
    expect(after.filter((c) => c === "browser_open")).toHaveLength(1);
    // Nothing was sent to the paused page to wake it while the tab sheet was open.
    expect(after.slice(pausedAt).filter((c) => c === "browser_screenshot").length).toBeLessThanOrEqual(1);
    await setWindowFocus(page, true);
  });

  test("an agent at the wheel keeps the agent glyph and the pane is never paused", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-HEAVY-03" });
    const ctx = "heavy-agent-probe";
    const paneId = await seedBrowserPane(request, ctx);
    await page.routeWebSocket(new RegExp(`/ws/browser/${ctx}`), (ws) => {
      // No server behind it: the pane only needs to hear that an agent drives it.
      setTimeout(() => ws.send(JSON.stringify({ type: "agent_active", active: true, action: "Clicca" })), 500);
    });
    await page.clock.install();
    await fakeHeavyShell(page, ctx, PNG_1X1);
    await goToApp(page);
    const glyph = page.locator(`[data-pane-id="${paneId}"] [data-testid="browser-tab-type-icon"]`);
    await expect(glyph).toHaveAttribute("data-kind", "agent", { timeout: 30_000 });

    await page.clock.runFor(25_000);
    await setWindowFocus(page, false);
    await page.clock.runFor(4_000);
    await expect(glyph).toHaveAttribute("data-kind", "agent");
    await expect(page.getByTestId("browser-paused")).toHaveCount(0);
    expect((await calls(page)).filter((c) => c === "browser_screenshot")).toEqual([]);
    await setWindowFocus(page, true);
  });
});
