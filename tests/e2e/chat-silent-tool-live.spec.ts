/**
 * A turn silent in a tool keeps its Stop in every window that watches it, and
 * a turn that is over, or was stopped, does not get one back.
 *
 * On 2026-09-25 (topic:3019832f) a live turn dropped out of the server's
 * streaming registry after three minutes without a provider event, which is
 * what a tool that prints nothing looks like. Every window but the sender's
 * reconciles against that registry: two misses and the chat was "finished",
 * the Stop gone, the queue drained, while the turn ran for twenty more
 * minutes. Nothing lit it again.
 *
 * The turns here are real server turns from a fake CLI whose Bash prints
 * nothing (`helpers/fake-claude-silent-tool.ts`). Where the sweep has to act,
 * its silence threshold is cut to 1 s (`/api/test/stale-stream-clock`) so its
 * real 30 s tick runs during the test and asks the child, which is alive. On a
 * checkout where `isStreaming` still had a clock, that cut hid the turn 29 s
 * out of 30.
 *
 * Two things are simulated, both at the network: a reply cut short without
 * [DONE] (a proxy or an idle timeout), by answering the page's own POST here
 * while the real one goes to the server; and a registry that dropped a live
 * turn (the bug above, or an older server), by answering the page's poll.
 *
 * @covers CHAT-REL-05
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the server resolves the CLI at every spawn and takes the highest. */
const CLI_ENTRY = join(VERSIONS_DIR, "999.0.1-e2e-silent-tool");
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';

/** Puts the fake CLI in front of the test server's, from the next spawn on. */
function installSilentToolCli(): void {
  // The server spawns the CLI with a trimmed environment: bun by absolute path.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  writeFileSync(CLI_ENTRY, `#!/usr/bin/env bash\nexec "${bun}" "${resolve(__dirname, "helpers/fake-claude-silent-tool.ts")}" "$@"\n`);
  chmodSync(CLI_ENTRY, 0o755);
}

async function serverStreaming(request: APIRequestContext, sessionKey: string): Promise<boolean> {
  const body = await (await request.get(`${E2E_BASE}/api/topics/streaming`)).json() as { sessions: Array<{ sessionKey: string }> };
  return body.sessions.some((x) => x.sessionKey === sessionKey);
}

/** Every change of the Stop in the page, sampled every 250 ms for `watchMs`: `[{t, on}]`, `t` in seconds. */
function watchStop(page: Page, watchMs: number): Promise<Array<{ t: number; on: boolean }>> {
  return page.evaluate(async ({ watchMs, sel }) => {
    const start = performance.now();
    const changes: Array<{ t: number; on: boolean }> = [];
    let prev: boolean | null = null;
    while (performance.now() - start < watchMs) {
      const on = !!document.querySelector(sel);
      if (on !== prev) changes.push({ t: Math.round((performance.now() - start) / 100) / 10, on });
      prev = on;
      await new Promise((r) => setTimeout(r, 250));
    }
    return changes;
  }, { watchMs, sel: STOP });
}

/**
 * The Stop is still up the instant a held reload is let go (the send is not
 * over yet): it must go within `withinS` and not come back.
 */
function expectStopGoesAndStays(trace: Array<{ t: number; on: boolean }>, withinS: number, what: string): void {
  const off = trace.find((x) => !x.on)?.t ?? Infinity;
  expect(off, `${what}: ${JSON.stringify(trace)}`).toBeLessThan(withinS);
  expect(trace.some((x) => x.on && x.t > off), `${what}, back on: ${JSON.stringify(trace)}`).toBe(false);
}

/** A topic on the fake CLI, open in the page. `warm` answers one message first, so a Stop is not a first message's wipe. */
async function openChat(page: Page, request: APIRequestContext, chatPage: { messageInput: { waitFor: (o: object) => Promise<void> } }, name: string, warm = false) {
  installSilentToolCli();
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "claude-code" });
  const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
  if (warm) expect((await request.post(`${E2E_BASE}/api/chat`, { data: { sessionKey, messages: [{ role: "user", content: "hello" }] }, timeout: 60_000 })).ok()).toBe(true);
  await resetPaneStore(request, [topic.id]);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topic.name));
  await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  return { topic, sessionKey };
}

/**
 * The page's first POST /api/chat goes to the server from here, and the page
 * gets a reply that ends with no [DONE] once the turn is registered. Later
 * POSTs pass untouched; `posts` lists what the page sent.
 */
async function cutFirstReply(page: Page, request: APIRequestContext, sessionKey: string, onCut: () => void = () => {}) {
  const posts: string[] = [];
  let turn: Promise<APIResponse> | null = null;
  await page.route((url) => url.pathname === "/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { messages?: Array<{ content?: string }> };
    posts.push(String(body?.messages?.at(-1)?.content ?? ""));
    if (turn) return route.continue();
    turn = request.post(`${E2E_BASE}/api/chat`, { data: body, timeout: 150_000 });
    await expect.poll(() => serverStreaming(request, sessionKey), { timeout: 20_000 }).toBe(true);
    onCut();
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": ping\n\n" });
  });
  return { posts, turn: () => turn };
}

/** Holds the page's next history read after `arm()` until `release()`, with the answer the server gave when asked. */
async function holdNextHistory(page: Page, sessionKey: string) {
  let armed = false;
  let released: () => void = () => {};
  const gate = new Promise<void>((r) => { released = r; });
  let heldResolve: () => void = () => {};
  const held = new Promise<void>((r) => { heldResolve = r; });
  await page.route((url) => url.pathname === `/api/history/${encodeURIComponent(sessionKey)}`, async (route) => {
    if (!armed) return route.continue();
    armed = false;
    const response = await route.fetch();
    heldResolve();
    await gate;
    await route.fulfill({ response });
  });
  return { arm: () => { armed = true; }, held, release: () => released() };
}

/** The sessions whose `stream:end` this page's socket has carried. Call before the page opens its socket. */
function recordStreamEnds(page: Page): Set<string> {
  const ended = new Set<string>();
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    if (!text.includes('"stream:end"')) return;
    for (const m of text.matchAll(/"sessionKey":"([^"]+)"/g)) ended.add(m[1]);
  }));
  return ended;
}

hermetic(test);

test.describe("a turn silent in a tool for longer than the stale threshold", () => {
  test.describe.configure({ timeout: 240_000 });
  // The app's service worker has a fetch handler: a page it controls sends
  // `/api/chat` through it, where `page.route` never sees the request.
  test.use({ serviceWorkers: "block" });

  // The threshold is the whole test server's: a spec that dies before its own
  // cleanup must not leave the next ones on 1 s.
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
    rmSync(CLI_ENTRY, { force: true });
  });

  test("the viewer keeps the Stop through the silence, and loses it only when the turn ends", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "silent-tool");
    try {
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      // Sent from outside this page: its own SSE would keep it lit whatever the registry said.
      const turn = request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "silent 50" }] },
        timeout: 150_000,
      });
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP).first()).toBeVisible({ timeout: 10_000 });

      // Well past the threshold and two registry polls.
      const trace = await watchStop(page, 42_000);
      expect(trace, "the Stop went away during a silent tool").toEqual([{ t: 0, on: true }]);

      // The gate reads the same registry: a second turn waits for this one.
      const second = await request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "a second turn" }] },
      });
      expect(second.status()).toBe(409);

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await turn).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a viewer that took a live turn for over is lit again by its next line and by its next tool", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "relight");
    try {
      const turn = request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "pulse 50 50" }] },
        timeout: 200_000,
      });
      const stop = page.locator(STOP).first();
      await expect(stop).toBeVisible({ timeout: 30_000 });
      // The registry says nothing is running, to this page only: its reconciler
      // settles the live turn, as every window did before the server fix.
      await page.route("**/api/topics/streaming", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) }));
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 45_000 });
      expect(await serverStreaming(request, sessionKey)).toBe(true);

      // The turn's next line is a live frame of it.
      await expect(page.getByText("PULSE-TEXT").first()).toBeVisible({ timeout: 45_000 });
      await expect(stop, "a live line did not light the turn again").toBeVisible({ timeout: 3_000 });

      // Settled again, and its next tool call is a live frame too.
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 45_000 });
      await expect(page.getByText("echo relit").first()).toBeVisible({ timeout: 45_000 });
      await expect(stop, "a live tool call did not light the turn again").toBeVisible({ timeout: 3_000 });

      await expect(page.getByText("PULSE-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await turn).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("the sender whose reply was cut short without [DONE] keeps the Stop while the server runs the turn", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "silent-cut");
    try {
      const chat = await cutFirstReply(page, request, sessionKey);
      await chatPage.sendMessage("silent 25");
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });

      const trace = await watchStop(page, 12_000);
      expect(trace, "the Stop went away after the reply was cut").toEqual([{ t: 0, on: true }]);

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await chat.turn())?.ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a turn that ends while the cut reply's history is in flight gets no Stop back, and shows its end", async ({ page, request, chatPage }) => {
    const ended = recordStreamEnds(page);
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-ends");
    try {
      const history = await holdNextHistory(page, sessionKey);
      await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 3");
      // The reload was answered "still streaming", and the turn ends before the
      // page reads it: its stream:end reaches the page while the page's own SSE
      // still holds the session.
      await history.held;
      await expect.poll(() => ended.has(sessionKey), { timeout: 30_000, intervals: [200] }).toBe(true);
      history.release();

      expectStopGoesAndStays(await watchStop(page, 15_000), 3, "a Stop on a finished turn");
      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a turn started from another window while the cut reply's history is in flight gets its Stop", async ({ page, request, chatPage }) => {
    const ended = recordStreamEnds(page);
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-next");
    try {
      // The pane was opened a moment ago, as when this goes wrong: its first
      // history read is still inside the 5 s dedup when the cut reply's reread
      // comes. The page's clock stops here to hold that, whatever the machine's
      // load; its timers keep running.
      await page.clock.setFixedTime(new Date());
      const history = await holdNextHistory(page, sessionKey);
      await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 3");
      await history.held;
      await expect.poll(() => ended.has(sessionKey), { timeout: 30_000, intervals: [200] }).toBe(true);
      // The next turn starts elsewhere; its stream:start reaches this page while
      // the page's own SSE still holds the session, so only a fresh read shows it.
      const next = request.post(`${E2E_BASE}/api/chat`, { data: { sessionKey, messages: [{ role: "user", content: "silent 25" }] }, timeout: 150_000 });
      await expect.poll(() => serverStreaming(request, sessionKey), { timeout: 20_000, intervals: [200] }).toBe(true);
      history.release();

      const trace = await watchStop(page, 12_000);
      expect(await serverStreaming(request, sessionKey), "the next turn still runs").toBe(true);
      expect(trace.at(-1)?.on, `a live turn without its Stop: ${JSON.stringify(trace)}`).toBe(true);
      const lastOff = [...trace].reverse().find((x) => !x.on)?.t ?? 0;
      expect(lastOff, `a live turn dark too long: ${JSON.stringify(trace)}`).toBeLessThan(4);
      expect((await next).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a Stop pressed while the cut reply's history is in flight stays pressed, and the queue stays put", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-stop", true);
    try {
      const history = await holdNextHistory(page, sessionKey);
      const chat = await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 60");
      await history.held;
      const stop = page.locator(STOP).first();
      await expect(stop).toBeVisible({ timeout: 5_000 });
      await chatPage.sendMessage("QUEUED-AFTER-STOP");
      await stop.click();
      await expect.poll(() => serverStreaming(request, sessionKey), { timeout: 15_000, intervals: [200] }).toBe(false);
      history.release();

      expectStopGoesAndStays(await watchStop(page, 15_000), 3, "the stopped turn lit again");
      expect(chat.posts.filter((c) => c.includes("QUEUED-AFTER-STOP")), "a stopped turn's queue fired").toEqual([]);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
