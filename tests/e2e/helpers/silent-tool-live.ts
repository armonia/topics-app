/**
 * What the three `chat-silent-tool-live*.spec.ts` files share: the fake CLI
 * whose Bash prints nothing, and the probes that watch the Stop and the socket.
 *
 * The suite was one file of seven turns, 553 s over the two engines, and the
 * shard plan cannot split a file: it was the floor of every e2e job. Three
 * files of 150-210 s each let the plan spread them.
 */
import { resolve } from "node:path";
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { installFakeCli } from "./fake-claude-cli";
import { goToApp, openTopic } from "../helpers";
import { createTopic, patchTopic, resetPaneStore } from "./api-fixtures";
import { E2E_BASE } from "./test-server";

/** The removal of the fake CLI the running test installed. */
let removeCli: (() => void) | null = null;
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
export const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';

/** Puts the fake CLI in front of the test server's, from the next spawn on. */
function installSilentToolCli(): void {
  removeCli = installFakeCli(resolve(__dirname, "fake-claude-silent-tool.ts"));
}

export async function serverStreaming(request: APIRequestContext, sessionKey: string): Promise<boolean> {
  const body = await (await request.get(`${E2E_BASE}/api/topics/streaming`)).json() as { sessions: Array<{ sessionKey: string }> };
  return body.sessions.some((x) => x.sessionKey === sessionKey);
}

/** Every change of the Stop in the page, sampled every 250 ms for `watchMs`: `[{t, on}]`, `t` in seconds. */
export function watchStop(page: Page, watchMs: number): Promise<Array<{ t: number; on: boolean }>> {
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
export function expectStopGoesAndStays(trace: Array<{ t: number; on: boolean }>, withinS: number, what: string): void {
  const off = trace.find((x) => !x.on)?.t ?? Infinity;
  expect(off, `${what}: ${JSON.stringify(trace)}`).toBeLessThan(withinS);
  expect(trace.some((x) => x.on && x.t > off), `${what}, back on: ${JSON.stringify(trace)}`).toBe(false);
}

/** A topic on the fake CLI, open in the page. `warm` answers one message first, so a Stop is not a first message's wipe. */
export async function openChat(page: Page, request: APIRequestContext, chatPage: { messageInput: { waitFor: (o: object) => Promise<void> } }, name: string, warm = false) {
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
export async function cutFirstReply(page: Page, request: APIRequestContext, sessionKey: string, onCut: () => void = () => {}) {
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
export async function holdNextHistory(page: Page, sessionKey: string) {
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
export function recordStreamEnds(page: Page): Set<string> {
  const ended = new Set<string>();
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    if (!text.includes('"stream:end"')) return;
    for (const m of text.matchAll(/"sessionKey":"([^"]+)"/g)) ended.add(m[1]);
  }));
  return ended;
}

/** The frames this page's socket has carried that contain `needle`. Call before the page opens its socket. */
export function recordFrames(page: Page, needle: string): Set<string> {
  const seen = new Set<string>();
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    if (text.includes(needle)) seen.add(text);
  }));
  return seen;
}

/** Undoes `installSilentToolCli`: the next spawn gets the test server's own CLI again. */
export function removeSilentToolCli(): void {
  removeCli?.();
  removeCli = null;
}
