/**
 * OPEN_BROWSER_PANE HAS TO END WITH AN ATTACHED PANE (card c5c1c68f).
 *
 * On 24/09 an agent in a project topic called `open_browser_pane`, and after
 * 8.5 s the tool answered that NO visible pane was mounted: no
 * `/ws/browser/<ctx>` socket attached, and the tab never showed. The server's
 * half of the sequence was sound: `browser:navigate`, 2.5 s for a pane to
 * attach, then `browser:force-open` and 2.5 s more. The client's half lost it,
 * because neither branch of force-open ever activated a pane that already
 * existed in a project window that was not mounted:
 *   - owner known (the window was mounted once, then evicted by residency,
 *     which keeps three hidden project windows): the project was brought to
 *     the front and nothing else. The window remounted with its saved layout,
 *     the browser a background tab of its cell, and nobody activated it;
 *   - no owner (the window never mounted in this session): the reopen path ran,
 *     and it leaves a pane that is already in a group where it is.
 *
 * WHAT IS REPLAYED, AND WHY. The first two tests play the server's two
 * broadcasts on the app socket, with the server's own budget between them,
 * instead of calling the route. With no pane attached, step 3 of the route
 * navigates a headless Chromium context, and no Chromium runs on this Mac.
 * Once the pane has attached, the real route is called and answers through the
 * pane, which is what the agent reads.
 *
 * The pane is the native one: `__TAURI_INTERNALS__` is faked (the same disguise
 * as `browser-heavy-pane-pause.spec.ts`), so it registers as the executor of
 * its context over a real socket to the test server, as the WKWebView pane
 * does in production.
 */
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { goToApp } from "./helpers";
import { createTopic } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { slackMs } from "../helpers/time-slack";
import { projectPanesKey } from "../../shared/project-keys";

hermetic(test);

/** `PANE_WAIT_MS` of `server/routes/browser-bridge.ts`: how long the route
 *  waits for a pane to attach, before navigating and again after force-open. */
const PANE_WAIT_MS = 2_500;
const APP_WS = /\/ws(\?|$)/;
const NO_CHROMIUM_HERE = process.platform === "darwin" && process.env.GITHUB_ACTIONS !== "true";

/** A fresh project directory, by its canonical path (the one the app keys on). */
function makeProject(tag: string): string {
  const dir = join(tmpdir(), `e2e-pane-attach-${tag}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  return realpathSync(dir);
}

const projectPaneId = (path: string): string => `project:${encodeURIComponent(path)}`;

/**
 * The app-level tab strip: one project tab per path, in this order. Written in
 * one PUT, because the order and the set are the precondition and the helpers
 * that append one tab at a time leave both to the timing of their writes.
 */
async function seedProjectTabs(request: APIRequestContext, paths: string[]): Promise<void> {
  const cur = (await (await request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`)).json()) as { value?: { lastSeq?: number } };
  const ids = paths.map(projectPaneId);
  const put = await request.put(`${E2E_BASE}/api/ui-state/pane-store-v2`, {
    data: {
      panes: Object.fromEntries(ids.map((id, i) => [id, { id, type: "project", title: `P${i}`, projectPath: paths[i] }])),
      groups: { "group:default": { id: "group:default", paneIds: ids, splitRatio: 1, splitAxis: "horizontal" } },
      groupOrder: ["group:default"],
      closedStack: [],
      projects: {},
      lastSeq: (cur.value?.lastSeq ?? 0) + 1,
    },
  });
  expect(put.ok(), "the project tabs are seeded").toBeTruthy();
}

/** A project's inner layout: its chat, and a browser pane on the same context. */
async function seedProjectLayout(request: APIRequestContext, path: string, topicId: string | null): Promise<void> {
  const put = await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(path)}`, {
    data: topicId
      ? {
          nonChatPanes: [{ id: `browser:${topicId}`, type: "browser", title: "Project page", url: "https://example.com/before", projectPath: path }],
          openChatTopicIds: [topicId],
          activeChatTopicId: topicId,
        }
      : { nonChatPanes: [], openChatTopicIds: [] },
  });
  expect(put.ok(), "the project layout is seeded").toBeTruthy();
}

/** The Tauri shell, faked: the loopback proxy sent home, every command answered. */
async function fakeTauriShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: unknown };
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
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: (cmd: string) => {
        if (cmd === "browser_devtools_open") return Promise.resolve(false);
        if (cmd.startsWith("browser_take_") || cmd === "browser_download_progress") return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  });
}

/**
 * What the page says and does about pane sockets, stamped with the test clock.
 * `[pane-attach]` lines are the client's own trace; they are attached to the
 * report so a red run says which branch was taken without a rerun.
 */
function watchPage(page: Page, ctx: string) {
  const t0 = Date.now();
  const lines: string[] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  page.on("console", (m) => {
    const text = m.text();
    if (text.includes("[pane-attach]")) lines.push(`${Date.now() - t0}ms ${text}`);
  });
  page.on("websocket", (ws) => {
    if (!ws.url().includes(`/ws/browser/${ctx}`)) return;
    opens.push(Date.now());
    lines.push(`${Date.now() - t0}ms pane socket OPEN`);
    ws.on("close", () => {
      closes.push(Date.now());
      lines.push(`${Date.now() - t0}ms pane socket CLOSE`);
    });
  });
  return {
    lines,
    /** Pane sockets opened for this context since `since` (epoch ms). */
    opensSince: (since: number) => opens.filter((t) => t >= since).length,
    /** Pane sockets closed for this context since `since` (epoch ms). */
    closesSince: (since: number) => closes.filter((t) => t >= since).length,
    attach: async () => test.info().attach("pane-attach trace", { body: lines.join("\n"), contentType: "text/plain" }),
  };
}

/** Pass-through proxy on the app socket, so server frames can be played into it. */
async function proxyAppSocket(page: Page): Promise<{ send: (frame: Record<string, unknown>) => void }> {
  let route: WebSocketRoute | null = null;
  await page.routeWebSocket(APP_WS, (ws) => {
    route = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
  return {
    send: (frame) => {
      if (!route) throw new Error("the app socket is not connected yet");
      route.send(JSON.stringify(frame));
    },
  };
}

const projectTab = (page: Page, path: string) => page.locator(`[role="tab"][data-pane-id="${projectPaneId(path)}"]`).first();
const innerTab = (page: Page, paneId: string) => page.locator(`[role="tab"][data-pane-id="${paneId}"]`).first();

/**
 * Show the project, then make its CHAT the active tab of the cell, so the
 * browser is a background tab there: the shape of the card. The browser was
 * visible once, so it stays mounted as long as its window does.
 */
async function leaveBrowserInBackground(page: Page, path: string, topicId: string): Promise<void> {
  await projectTab(page, path).click();
  await expect(innerTab(page, `browser:${topicId}`)).toBeVisible({ timeout: 15_000 });
  await innerTab(page, `chat:${topicId}`).click();
  await expect(innerTab(page, `chat:${topicId}`)).toHaveAttribute("data-active", "true");
  await expect(innerTab(page, `browser:${topicId}`)).toHaveAttribute("data-active", "false");
}

/**
 * The server's half of `open_browser_pane` when no pane attaches: navigate,
 * the route's wait, force-open. Returns when force-open was played.
 */
async function replayOpenPaneWithoutAttach(page: Page, app: { send: (f: Record<string, unknown>) => void }, ctx: string, url: string): Promise<number> {
  app.send({ type: "browser:navigate", topicId: ctx, contextId: ctx, url });
  await page.waitForTimeout(PANE_WAIT_MS);
  const at = Date.now();
  app.send({ type: "browser:force-open", contextId: ctx, url });
  return at;
}

/** The route the MCP tool calls, once a pane is attached to answer it. */
async function openPaneRoute(request: APIRequestContext, topicId: string, url: string) {
  const res = await request.post(`${E2E_BASE}/api/topics/${topicId}/browser/open-pane`, { data: { url } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { url: string; visible: boolean };
}

test.describe("open_browser_pane attaches the project pane", () => {
  test.describe.configure({ timeout: 150_000 });

  test("the owning project window never mounted in this session: force-open shows the tab and it attaches", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "c5c1c68f" });
    const owner = makeProject("owner");
    const other = makeProject("other");
    const topic = await createTopic(request, "Pane attach, never mounted", { projectPath: owner });
    const ctx = topic.id;
    await seedProjectTabs(request, [owner, other]);
    await seedProjectLayout(request, owner, ctx);
    await seedProjectLayout(request, other, null);

    await fakeTauriShell(page);
    const app = await proxyAppSocket(page);
    const watch = watchPage(page, ctx);
    try {
      await goToApp(page);
      await leaveBrowserInBackground(page, owner, ctx);
      await projectTab(page, other).click();
      await expect(projectTab(page, other)).toHaveAttribute("data-active", "true");

      // A reload with the OTHER project on screen: the owner's window is a tab
      // that nothing shows, so it is not mounted and its pane has no socket.
      await page.reload();
      await expect(projectTab(page, other)).toHaveAttribute("data-active", "true", { timeout: 15_000 });
      await page.waitForTimeout(1_000);
      const since = Date.now();
      expect(watch.opensSince(since - 1_000), "no pane socket before open_browser_pane").toBe(0);

      const url = "https://example.com/opened-by-the-agent";
      const forcedAt = await replayOpenPaneWithoutAttach(page, app, ctx, url);
      await expect
        .poll(() => watch.opensSince(forcedAt), { timeout: slackMs(PANE_WAIT_MS), message: "a pane socket attaches within the route's wait after force-open" })
        .toBeGreaterThan(0);
      await expect(projectTab(page, owner)).toHaveAttribute("data-active", "true");
      await expect(innerTab(page, `browser:${ctx}`)).toHaveAttribute("data-active", "true");

      const answer = await openPaneRoute(request, ctx, url);
      expect(answer.visible).toBe(true);
    } finally {
      await watch.attach();
    }
  });

  test("the owning project window was evicted by residency: force-open shows the background tab and it attaches", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "c5c1c68f" });
    // Five project tabs, as on the machine of 24/09: residency keeps three
    // hidden project windows mounted, so visiting four others evicts the first.
    const owner = makeProject("owner");
    const others = [1, 2, 3, 4].map((i) => makeProject(`other${i}`));
    const topic = await createTopic(request, "Pane attach, evicted", { projectPath: owner });
    const ctx = topic.id;
    await seedProjectTabs(request, [owner, ...others]);
    await seedProjectLayout(request, owner, ctx);
    for (const p of others) await seedProjectLayout(request, p, null);

    await fakeTauriShell(page);
    const app = await proxyAppSocket(page);
    const watch = watchPage(page, ctx);
    try {
      await goToApp(page);
      await leaveBrowserInBackground(page, owner, ctx);
      await expect.poll(() => watch.opensSince(0), { timeout: 15_000 }).toBeGreaterThan(0);
      const visitsFrom = Date.now();
      for (const p of others) {
        await projectTab(page, p).click();
        await expect(projectTab(page, p)).toHaveAttribute("data-active", "true");
      }
      // The owner is now the fourth most recent hidden window: after the dwell
      // (4 s) and the eviction delay (1.5 s) its window, and the pane inside
      // it, are unmounted, and the pane's socket goes with them.
      await expect
        .poll(() => watch.closesSince(visitsFrom), { timeout: 20_000, message: "residency evicts the owner window and its pane socket" })
        .toBeGreaterThan(0);

      const url = "https://example.com/opened-by-the-agent";
      const forcedAt = await replayOpenPaneWithoutAttach(page, app, ctx, url);
      await expect
        .poll(() => watch.opensSince(forcedAt), { timeout: slackMs(PANE_WAIT_MS), message: "a pane socket attaches within the route's wait after force-open" })
        .toBeGreaterThan(0);
      await expect(projectTab(page, owner)).toHaveAttribute("data-active", "true");
      await expect(innerTab(page, `browser:${ctx}`)).toHaveAttribute("data-active", "true");

      const answer = await openPaneRoute(request, ctx, url);
      expect(answer.visible).toBe(true);
    } finally {
      await watch.attach();
    }
  });

  /**
   * The restart of 24/09, played for real: the server goes down with SIGTERM
   * and comes back, and at boot its orphan cleanup strips the browser
   * tombstone of the topic (a chat's browser context IS its topic id). It was
   * the suspect of the card. Measured here, it does not unmount a live pane:
   * the pane socket reconnects by itself and the tool attaches through it.
   * This test keeps it that way.
   *
   * Nightly only, like `terminal-session-resume`, the other spec that restarts
   * the server: on the PR gate a restart in the middle of the suite would be
   * paid by whichever spec runs next.
   */
  test("a server restart whose boot strips the pane's browser tombstone leaves the live pane attached @nightly", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "c5c1c68f" });
    const owner = makeProject("owner");
    const topic = await createTopic(request, "Pane attach, restart", { projectPath: owner });
    const ctx = topic.id;
    await seedProjectTabs(request, [owner]);
    await seedProjectLayout(request, owner, ctx);

    await fakeTauriShell(page);
    const watch = watchPage(page, ctx);
    try {
      await goToApp(page);
      await projectTab(page, owner).click();
      await expect.poll(() => watch.opensSince(0), { timeout: 15_000 }).toBeGreaterThan(0);

      // A tombstone for this context reaches the server (a close of the same
      // context on another device), as it had on 24/09 before the restart.
      const put = await request.put(`${E2E_BASE}/api/ui-state/tombstones-browser`, {
        data: { entries: [{ id: ctx, ts: Date.now() }] },
        headers: { "X-Client-Id": "another-device" },
      });
      expect(put.ok()).toBeTruthy();

      const boot = await restartServer();
      // eslint-disable-next-line no-control-regex -- Bun colours the object it logs
      expect(boot.join("").replace(/\x1b\[[0-9;]*m/g, ""), "the boot cleanup rewrote tombstones-browser").toMatch(/key: "tombstones-browser"/);
      const back = Date.now();
      await expect
        .poll(() => watch.opensSince(back), { timeout: 20_000, message: "the pane socket reconnects after the restart" })
        .toBeGreaterThan(0);
      await page.waitForTimeout(5_000);
      expect(watch.lines.filter((l) => l.includes("pane socket released")), "the pane was never unmounted").toEqual([]);

      const answer = await openPaneRoute(request, ctx, "https://example.com/after-restart");
      expect(answer.visible).toBe(true);
    } finally {
      await watch.attach();
    }
  });
});

async function portOpen(): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const s = net.createConnection({ port: E2E_PORT, host: "127.0.0.1" }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(800, () => { s.destroy(); res(false); });
  });
}

/**
 * SIGTERM the test server (as the file watcher does in production) and start
 * it again with the environment it was born with. Returns its stdout, where the
 * boot cleanup reports what it rewrote.
 *
 * On a Mac outside CI `CHROMIUM_PATH` points nowhere, on purpose: a headless
 * launch attempted by mistake fails loudly instead of starting a Chromium
 * there (the same condition as the Mac ban in `playwright.config.ts`).
 * Elsewhere the server comes back with the environment it had, so the specs
 * that run after this one still find the Chromium global-setup gave it.
 */
async function restartServer(): Promise<string[]> {
  const pids = execSync(`lsof -ti :${E2E_PORT} -sTCP:LISTEN 2>/dev/null || true`).toString().trim();
  if (pids) execSync(`kill ${pids.split("\n").join(" ")} 2>/dev/null || true`);
  const down = Date.now();
  while (Date.now() - down < 15_000 && (await portOpen())) await new Promise((r) => setTimeout(r, 200));
  const out: string[] = [];
  const proc = spawn("bash", [resolve(__dirname, "../../scripts/start-test-server.sh")], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      ...testServerEnv(E2E_PORT),
      ...(NO_CHROMIUM_HERE ? { CHROMIUM_PATH: "/nonexistent/no-chromium-on-this-mac" } : {}),
    },
  });
  proc.unref();
  proc.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  proc.stderr?.on("data", (d: Buffer) => out.push(d.toString()));
  const up = Date.now();
  while (Date.now() - up < 45_000) {
    if (await portOpen()) {
      const r = await fetch(`${E2E_BASE}/api/topics`).catch(() => null);
      if (r?.ok) return out;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the test server did not come back:\n${out.join("")}`);
}
