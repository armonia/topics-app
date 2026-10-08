import { test, expect } from "./fixtures/test-fixtures";
import type { Frame, Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { axe, boxes, sidewaysOverflow } from "./helpers/view-measure";
import { doorToDoorTimeline, trainsTable } from "./fixtures/trip-views";

hermetic(test);

/**
 * TABLE, TIMELINE, AND THE SAME VIEWS IN SOMEONE ELSE'S HOST (GENUI-06..08).
 *
 * The trip of topic:64095902: her trains Huesca → Sants as a table, his door
 * to door plan (T1 → Sitges by bus 1149 or taxi, back to T2 for easyJet
 * U24212 at 14:10) as a timeline. Stored through the route `show_view` calls,
 * seeded as the server stores a turn, then checked where a person sees them:
 * in the chat, as a page on desktop and phone in both themes, and inside an
 * MCP Apps host, driven by the REAL bridge process (`topics-mcp-server.ts`)
 * the way OpenClaw or Claude would drive it.
 *
 * @covers GENUI-06, GENUI-07, GENUI-08
 */

// A mutation run points this at a mutated copy of the bridge (openspec acceptance).
const BRIDGE = process.env.E2E_BRIDGE_SCRIPT ?? resolve(__dirname, "../../server/mcp/topics-mcp-server.ts");

test.describe("generative views: table and timeline", () => {
  let topicId = "";
  let topicName = "";
  let tableId = "";
  let timelineId = "";

  test.beforeAll(async ({ request }) => {
    topicName = `genui-kinds-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const store = async (spec: Record<string, unknown>) => {
      const res = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(`topic:${topicId}`)}/views`, { data: spec, ignoreHTTPSErrors: true });
      expect(res.status()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    tableId = await store(trainsTable());
    timelineId = await store(doorToDoorTimeline());

    const view = (id: string, spec: Record<string, unknown>, viewId: string, what: string) => ({
      kind: "tool",
      toolCall: { id, name: "mcp__topics__show_view", args: spec, status: "success", result: `shown in chat · ${what} · page https://127.0.0.1:3333/v/${viewId}` },
    });
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, { data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true });
    await row("user", "come ci arriviamo, porta a porta?");
    await row("assistant", "Lei in AVE, tu in bus.", [
      { kind: "tool", toolCall: { id: "b1", name: "Bash", args: { command: "echo orari" }, status: "success", detail: { type: "shell", command: "echo orari", output: "ok" } } },
      { kind: "tool", toolCall: { id: "b2", name: "Bash", args: { command: "echo bus" }, status: "success", detail: { type: "shell", command: "echo bus", output: "ok" } } },
      view("toolu_t1", trainsTable(), tableId, "table · 3 rows"),
      view("toolu_t2", doorToDoorTimeline(), timelineId, "timeline · 6 steps"),
      { kind: "text", text: "Lei prende l'AVE delle 08:05, tu il bus 1149 delle 16:50." },
    ]);
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("both views are blocks of the chat, with their marks", async ({ page, chatPage }) => {
    test.setTimeout(90_000);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    await expect(page.getByTestId("turn-work-fold").first()).toHaveAttribute("data-actions", "2", { timeout: 15_000 });
    const blocks = page.getByTestId("view-block");
    await expect(blocks).toHaveCount(2);
    const table = blocks.nth(0);
    const timeline = blocks.nth(1);
    await expect(table).toHaveAttribute("data-view", "table");
    await expect(timeline).toHaveAttribute("data-view", "timeline");

    // Table: the recommended row, the best duration and the best price, and an
    // unknown value said as unknown (the AVE price nobody read).
    const tv = table.getByTestId("table-view");
    await expect(tv).toBeVisible();
    await expect(tv.locator('[data-recommended="true"]:visible')).toContainText("AVE Renfe");
    await expect(tv.locator('[data-rank="best"]:visible')).toHaveText([/3 h/, /12,70/]);
    await expect(tv.locator(":visible", { hasText: /^n\/d$/ }).first()).toBeVisible();

    // Timeline: two days, six steps, the deadline drawn as one, the taxi as the alternative.
    const tl = timeline.getByTestId("timeline-view");
    await expect(tl.getByTestId("timeline-day")).toHaveCount(2);
    await expect(tl.getByTestId("timeline-step")).toHaveCount(6);
    await expect(tl.locator('[data-deadline="true"]').getByTestId("timeline-time")).toHaveText("12:40");
    await expect(tl.getByTestId("timeline-alternatives")).toContainText("Taxi dal T1 alla porta");
    await expect(tl.getByTestId("timeline-alternatives")).toContainText("47-53 €");

    // Both stay inside the message column.
    const [bubble] = await boxes(page, '[data-testid="message-content-assistant"]');
    for (const b of await boxes(page, '[data-testid="view-block"]')) {
      expect(b.x).toBeGreaterThanOrEqual(bubble.x - 1);
      expect(b.right).toBeLessThanOrEqual(bubble.right + 1);
    }
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("genui-kinds-chat-table.png") });
    await timeline.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("genui-kinds-chat-timeline.png") });
    expect(await axe(page, '[data-testid="view-block"]'), "axe on the chat blocks").toEqual([]);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`table and timeline as pages, desktop and phone, ${scheme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.emulateMedia({ colorScheme: scheme });

      // TABLE, desktop: a real table, numbers flush right in one column edge.
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`${E2E_BASE}/v/${tableId}`);
      const grid = page.getByTestId("table-grid");
      await expect(grid).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("table-cards")).toBeHidden();
      await expect(grid.getByTestId("table-row")).toHaveCount(3);
      const durations = await boxes(page, '[data-testid="table-grid"] tbody tr td:nth-child(4) [data-testid="table-cell-value"]');
      expect(durations).toHaveLength(3);
      expect(new Set(durations.map((b) => Math.round(b.right))).size, "durations right-aligned").toBe(1);
      expect(await sidewaysOverflow(page)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`genui-table-desktop-${scheme}.png`) });
      expect(await axe(page, '[data-testid="view-page"]'), `axe table desktop ${scheme}`).toEqual([]);

      // TABLE, phone: a card per row, nothing to pan, a finger-sized link.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(grid).toBeHidden();
      const cards = await boxes(page, '[data-testid="table-card"]');
      expect(cards).toHaveLength(3);
      for (const c of cards) expect(c.right).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      expect(await sidewaysOverflow(page)).toEqual([]);
      const [link] = await boxes(page, '[data-testid="table-card"] [data-testid="table-link"]');
      expect(link.height).toBeGreaterThanOrEqual(36);
      await page.screenshot({ path: test.info().outputPath(`genui-table-mobile-${scheme}.png`) });
      expect(await axe(page, '[data-testid="view-page"]'), `axe table phone ${scheme}`).toEqual([]);

      // TIMELINE: times in one column on both widths, nothing to pan.
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
        await page.goto(`${E2E_BASE}/v/${timelineId}`);
        await expect(page.getByTestId("timeline-step")).toHaveCount(6, { timeout: 15_000 });
        const times = await boxes(page, '[data-testid="timeline-time"]');
        expect(new Set(times.map((b) => Math.round(b.right))).size, "times share one right edge").toBe(1);
        const steps = await boxes(page, '[data-testid="timeline-step"]');
        for (let i = 1; i < steps.length; i++) expect(steps[i].y).toBeGreaterThanOrEqual(steps[i - 1].bottom - 1);
        expect(await sidewaysOverflow(page)).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`genui-timeline-${width === 390 ? "mobile" : "desktop"}-${scheme}.png`) });
        expect(await axe(page, '[data-testid="view-page"]'), `axe timeline ${width} ${scheme}`).toEqual([]);
      }
    });
  }

  test("an MCP Apps host shows the view the bridge returns, themed by the host", async ({ page }) => {
    test.setTimeout(90_000);
    const bridge = new BridgeClient(topicId);
    try {
      const init = await bridge.call("initialize", { protocolVersion: "2024-11-05", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "e2e-host", version: "1" } });
      expect(init.capabilities.resources).toEqual({});
      const tools = await bridge.call("tools/list");
      const tool = tools.tools.find((t: { name: string }) => t.name === "show_view");
      expect(tool._meta.ui.resourceUri).toBe("ui://topics/view");

      // What the host does: call the tool, read the resource it points at,
      // render it sandboxed, hand it the tool result.
      const result = await bridge.call("tools/call", { name: "show_view", arguments: doorToDoorTimeline() });
      expect(result.content[0].text).toMatch(/^shown in chat · timeline · 6 steps · page /);
      const app = (await bridge.call("resources/read", { uri: tool._meta.ui.resourceUri })).contents[0];
      expect(app.mimeType).toBe("text/html;profile=mcp-app");

      await page.setViewportSize({ width: 720, height: 900 });
      const frame = await mountInHost(page, app.text, { theme: "dark", toolResult: result });
      await expect(frame.locator(".step")).toHaveCount(6, { timeout: 10_000 });
      await expect(frame.locator(".step.deadline time")).toHaveText("12:40");
      expect(await frame.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
      // The host's colour variable reached the page.
      expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(16, 20, 24)");
      // The frame told the host its height, and the host sized it.
      await expect.poll(() => page.evaluate(() => (window as unknown as { sizes: number[] }).sizes.at(-1) ?? 0)).toBeGreaterThan(400);
      const [frameBox] = await boxes(page, "iframe");
      expect(Math.abs(frameBox.height - (await page.evaluate(() => (window as unknown as { sizes: number[] }).sizes.at(-1)!)))).toBeLessThanOrEqual(2);
      // A link goes through the host (a sandboxed frame may not open windows).
      await frame.locator("footer a").click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([expect.stringMatching(/\/v\/[0-9a-f]{16}$/)]);
      await page.screenshot({ path: test.info().outputPath("genui-mcp-app-timeline-dark.png") });
      expect(await axe(frame, "main"), "axe inside the host frame").toEqual([]);

      // A stored view read straight by its own URI: the table, light theme.
      const one = (await bridge.call("resources/read", { uri: `ui://topics/view/${tableId}` })).contents[0];
      const tableFrame = await mountInHost(page, one.text, { theme: "light" });
      await expect(tableFrame.locator("tbody tr")).toHaveCount(3, { timeout: 10_000 });
      await expect(tableFrame.locator("tr.rec th")).toContainText("AVE Renfe");
      await expect(tableFrame.locator(".best")).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath("genui-mcp-app-table-light.png") });
      expect(await axe(tableFrame, "main"), "axe inside the host frame (table)").toEqual([]);
    } finally {
      bridge.close();
    }
  });
});

/** The real bridge process, spoken to over stdio as an MCP host does. */
class BridgeClient {
  private proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  private waiting = new Map<number, (msg: { result?: any; error?: { message: string } }) => void>();
  constructor(topicId: string) {
    this.proc = spawn("bun", ["run", BRIDGE, `--base-url=${E2E_BASE}`, `--session-key=topic:${topicId}`], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === "number") this.waiting.get(msg.id)?.(msg);
      } catch { /* not a frame */ }
    });
  }
  call(method: string, params?: unknown): Promise<any> {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${method}: no answer`)), 30_000);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close(): void { this.proc.kill(); }
}

/**
 * A minimal MCP Apps host: a sandboxed iframe (scripts, no same origin, as
 * the spec asks), answering `ui/initialize` with a theme and one colour
 * variable, sizing the frame on `size-changed`, recording `ui/open-link`, and
 * sending the tool result once the view says it is initialized.
 */
async function mountInHost(page: Page, html: string, opts: { theme: "light" | "dark"; toolResult?: unknown }): Promise<Frame> {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#888"><iframe sandbox="allow-scripts" style="display:block;width:100%;height:120px;border:0" title="view"></iframe></body></html>`);
  await page.evaluate(({ html, theme, toolResult }) => {
    const w = window as unknown as { sizes: number[]; opened: string[] };
    w.sizes = [];
    w.opened = [];
    const iframe = document.querySelector("iframe")!;
    window.addEventListener("message", (e) => {
      if (e.source !== iframe.contentWindow) return;
      const m = e.data as { id?: number; method?: string; params?: any };
      const reply = (result: unknown) => iframe.contentWindow!.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
      if (m.method === "ui/initialize") {
        reply({ protocolVersion: "2026-01-26", hostInfo: { name: "e2e-host", version: "1" }, hostCapabilities: {}, hostContext: { theme, styles: { variables: theme === "dark" ? { "--color-background-primary": "#101418" } : {} } } });
      } else if (m.method === "ui/notifications/initialized" && toolResult) {
        iframe.contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: toolResult }, "*");
      } else if (m.method === "ui/notifications/size-changed") {
        w.sizes.push(m.params.height);
        iframe.style.height = `${m.params.height}px`;
      } else if (m.method === "ui/open-link") {
        w.opened.push(m.params.url);
        reply({});
      }
    });
    iframe.srcdoc = html;
  }, { html, theme: opts.theme, toolResult: opts.toolResult ?? null });
  const handle = await page.locator("iframe").elementHandle();
  const frame = await handle!.contentFrame();
  await frame!.waitForLoadState();
  return frame!;
}
