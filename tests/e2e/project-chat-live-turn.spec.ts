/**
 * A CHAT INSIDE A PROJECT PANE SHOWS THE TRUE STATE OF ITS TURN, WITHOUT A
 * RELOAD (card 1fc3a9fa).
 *
 * The layout this was reported on holds project panes only: every chat lives
 * inside one. The window built three things from `openPanels`, which holds the
 * PROJECT ids and no chat: its `subscribe` frame, its reconcile on
 * `topic:updated` and its catch-up after a reconnect. So a chat in a project
 * received the per-token frames of its turn only while it was THE focused
 * topic, and nothing reloaded it afterwards: on 25/09, 70 turn ends and 0
 * history reloads. The bubble stayed where the focus had left it until a
 * manual refresh.
 *
 * Each test drives one turn on chat A (project P1) from outside the page, as
 * an agent or another window does, with a fake CLI: text, a Bash call, text.
 * The focus is on chat B of project P2 for part of the turn. A hidden pane
 * keeps receiving its messages (`PaneKeepAlive` freezes props, not state), so
 * the bubble A holds when the person comes back is the one under test.
 *
 * @covers CCPROV-02
 */
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { projectPanesKey } from "../../shared/project-keys";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 90_000 });

const APP_WS = /\/ws(\?|$)/;
const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";
/** The fake turn: START, a Bash call, MIDDLE, END, this far apart. */
const TURN = "TOOLTURN:1500";

function makeProject(tag: string): string {
  const dir = join(tmpdir(), `e2e-project-chat-${tag}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  return realpathSync(dir);
}

const projectPaneId = (path: string): string => `project:${encodeURIComponent(path)}`;
const projectTab = (page: Page, path: string) => page.locator(`[role="tab"][data-pane-id="${projectPaneId(path)}"]`).first();

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

/** Two project tabs, P1 and P2, each with its one chat active. */
async function seedLayout(request: APIRequestContext, p1: string, a: string, p2: string, b: string): Promise<void> {
  const cur = (await (await request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`)).json()) as { value?: { lastSeq?: number } };
  const ids = [projectPaneId(p1), projectPaneId(p2)];
  const put = await request.put(`${E2E_BASE}/api/ui-state/pane-store-v2`, {
    data: {
      panes: { [ids[0]!]: { id: ids[0], type: "project", title: "P1", projectPath: p1 }, [ids[1]!]: { id: ids[1], type: "project", title: "P2", projectPath: p2 } },
      groups: { "group:default": { id: "group:default", paneIds: ids, splitRatio: 1, splitAxis: "horizontal" } },
      groupOrder: ["group:default"],
      closedStack: [],
      projects: {},
      lastSeq: (cur.value?.lastSeq ?? 0) + 1,
    },
  });
  expect(put.ok(), "the project tabs are seeded").toBeTruthy();
  for (const [path, topicId] of [[p1, a], [p2, b]] as const) {
    const inner = await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(path)}`, {
      data: { nonChatPanes: [], openChatTopicIds: [topicId], activeChatTopicId: topicId },
    });
    expect(inner.ok(), "the project layout is seeded").toBeTruthy();
  }
}

interface Turn {
  /** The server said the turn ran its tool (the SSE of the request carries it). */
  ranTool: () => boolean;
  /** What the turn's event stream carried so far. */
  said: () => string;
  /** Resolves when the server has closed the turn. */
  done: Promise<void>;
}

/** POST /api/chat from outside the page, its event stream drained in the background. */
function startTurn(sessionKey: string, content: string): Turn {
  let sse = "";
  const done = (async () => {
    const res = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      sse += decoder.decode(value);
    }
  })();
  // Awaited by the test at the end; handled now, so a refusal is reported there
  // and not as an unhandled rejection in the middle of the run.
  done.catch(() => {});
  return { ranTool: () => sse.includes("tool-visible"), said: () => sse, done };
}

/**
 * The app socket, proxied: the frames about A that reach this window, and a
 * switch that drops the socket and refuses reconnections while it is on.
 */
async function proxyAppSocket(page: Page, sessionKey: string) {
  const state = { refuse: false, opens: 0, frames: [] as string[] };
  const live = new Set<WebSocketRoute>();
  await page.routeWebSocket(APP_WS, (ws) => {
    if (state.refuse) {
      void ws.close({ code: 4000, reason: "refused by the test" }).catch(() => {});
      return;
    }
    state.opens += 1;
    live.add(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === "string" && m.includes(sessionKey)) {
        try {
          const type = (JSON.parse(m) as { type?: string }).type;
          if (type) state.frames.push(type);
        } catch { /* not JSON */ }
      }
      ws.send(m);
    });
    ws.onClose(() => { live.delete(ws); void server.close().catch(() => {}); });
    server.onClose(() => { live.delete(ws); void ws.close().catch(() => {}); });
  });
  return {
    state,
    saw: (type: string) => state.frames.includes(type),
    count: (type: string) => state.frames.filter((t) => t === type).length,
    /** Drop the socket and keep it down until `state.refuse` goes back to false. */
    cut: async () => {
      state.refuse = true;
      for (const ws of [...live]) await ws.close({ code: 4000, reason: "cut by the test" }).catch(() => {});
    },
  };
}

/** The last assistant bubble of a chat, read in the DOM whether it is on screen or not. */
async function bubbleOf(page: Page, topicId: string): Promise<{ start: boolean; middle: boolean; end: boolean; tools: number }> {
  return page.evaluate((id) => {
    const pane = document.querySelector(`[data-chat-topic-id="${id}"]`);
    const bubbles = pane ? pane.querySelectorAll('[data-testid="chat-message"][data-role="assistant"]') : [];
    const last = bubbles[bubbles.length - 1];
    const text = last?.textContent ?? "";
    return {
      start: text.includes("START of the answer"),
      middle: text.includes("MIDDLE of the answer"),
      end: text.includes("END of the answer"),
      tools: last ? last.querySelectorAll('[data-testid="tool-call-name"], [data-testid="tool-group-row"], [data-testid="task-work-summary"]').length : 0,
    };
  }, topicId);
}

const WHOLE = { start: true, middle: true, end: true, tools: 1 };

/** The chunk numbers `<tag>-NNN` the last assistant bubble of a chat shows, in order. */
async function chunksOf(page: Page, topicId: string, tag: string): Promise<number[]> {
  const text = await page.evaluate((id) => {
    const bubbles = document.querySelector(`[data-chat-topic-id="${id}"]`)?.querySelectorAll('[data-testid="chat-message"][data-role="assistant"]');
    return bubbles?.[bubbles.length - 1]?.textContent ?? "";
  }, topicId);
  return (text.match(new RegExp(`${tag}-(\\d{3})`, "g")) ?? []).map((c) => Number(c.slice(-3)));
}

/** The chat still says a turn is running: the streaming indicator, or the Stop button. */
const busy = (page: Page, topicId: string) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-chat-topic-id="${id}"]`);
    return !!pane?.querySelector('[data-testid="chat-streaming-indicator"], button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]');
  }, topicId);

/**
 * Holds every history answer of a session, once armed, until `until()` holds.
 * `held` and `delivered` count them.
 */
function holdHistoryUntil(page: Page, sessionKey: string, until: () => boolean) {
  const state = { armed: false, held: 0, delivered: 0 };
  void page.route(`**/api/history/${encodeURIComponent(sessionKey)}`, async (route) => {
    if (!state.armed) return route.continue();
    state.held++;
    const response = await route.fetch();
    const body = await response.text();
    const since = Date.now();
    while (!until() && Date.now() - since < 20_000) await new Promise((r) => setTimeout(r, 50));
    await route.fulfill({ response, body });
    state.delivered++;
  });
  return { state, arm: () => { state.armed = true; } };
}

/** Every history request of a session, by the time it left. */
function historyRequests(page: Page, sessionKey: string): number[] {
  const at: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/api/history/${encodeURIComponent(sessionKey)}`)) at.push(Date.now());
  });
  return at;
}

/**
 * A history read of a chat less than 5 s old is answered from memory
 * (`HISTORY_DEDUP_MS` in useChat.ts): a case that needs the next read to reach
 * the server waits for the last one to be older than that.
 */
async function pastHistoryDedup(sent: number[]): Promise<void> {
  await expect.poll(() => Date.now() - Math.max(0, ...sent), { timeout: 10_000 }).toBeGreaterThan(5_500);
}

test.describe("a chat inside a project pane shows the true state of its turn", () => {
  let uninstall: () => void = () => {};
  let p1 = "";
  let p2 = "";
  let a = "";
  let b = "";
  let skA = "";

  test.beforeAll(async ({ request }) => {
    uninstall = installSlowTurnCli();
    p1 = makeProject("a");
    p2 = makeProject("b");
    a = (await createTopic(request, "Live A", { projectPath: p1, provider: "claude-code" })).id;
    b = (await createTopic(request, "Live B", { projectPath: p2, provider: "claude-code" })).id;
    skA = await sessionKeyOf(request, a);
    // The first spawn of the CLI is the slow one: paid here, not inside a turn
    // whose timing the tests read.
    await startTurn(skA, "warm up").done;
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    await deleteTopic(request, a).catch(() => {});
    await deleteTopic(request, b).catch(() => {});
    for (const dir of [p1, p2]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request }) => {
    await seedLayout(request, p1, a, p2, b);
  });

  /** Both project windows mounted, A's chat seen once, the focus on `onScreen`. */
  async function openBoth(page: Page, onScreen: "P1" | "P2"): Promise<void> {
    await goToApp(page);
    await projectTab(page, p1).click();
    await expect(page.locator(`[data-chat-topic-id="${a}"]`).first()).toBeVisible({ timeout: 20_000 });
    await projectTab(page, p2).click();
    await expect(page.locator(`[data-chat-topic-id="${b}"]`).first()).toBeVisible({ timeout: 20_000 });
    if (onScreen === "P1") {
      await projectTab(page, p1).click();
      await expect(page.locator(`[data-chat-topic-id="${a}"]`).first()).toBeVisible();
    }
  }

  /**
   * The turn ended on the page and every held answer landed after it: A,
   * brought on screen, shows no running turn and holds `words`.
   */
  async function expectClosedTurn(
    page: Page,
    app: { saw: (type: string) => boolean },
    answers: ReturnType<typeof holdHistoryUntil>,
    words: string[],
  ): Promise<void> {
    const { state } = answers;
    await expect.poll(() => app.saw("stream:end"), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(() => state.delivered > 0 && state.delivered === state.held, { timeout: 15_000, message: "the held answers have landed" })
      .toBe(true);
    await projectTab(page, p1).click();
    await expect(page.locator(`[data-chat-topic-id="${a}"]`).first()).toBeVisible();
    await expect.poll(() => busy(page, a), { timeout: 5_000, message: "no turn running on screen" }).toBe(false);
    const text = (await page.locator(`[data-chat-topic-id="${a}"] [data-testid="chat-message"][data-role="assistant"]`).last().textContent()) ?? "";
    for (const word of words) expect(text, "the last bubble holds the whole turn").toContain(word);
  }

  test("the focus leaves the chat mid-turn: the bubble still ends whole", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const app = await proxyAppSocket(page, skA);
    await openBoth(page, "P1");
    const turn = startTurn(skA, TURN);
    await expect.poll(() => app.saw("stream:tool_result"), { timeout: 20_000, message: "A is focused: its tool reaches the window" }).toBe(true);
    await projectTab(page, p2).click();
    await expect.poll(() => app.saw("stream:end"), { timeout: 30_000 }).toBe(true);
    await expect
      .poll(() => bubbleOf(page, a), { timeout: 1_000, message: `within 1 s of the end, frames about A: ${app.state.frames.join(",")}` })
      .toEqual(WHOLE);
    await turn.done;
    await projectTab(page, p1).click();
    await expect.poll(() => bubbleOf(page, a)).toEqual(WHOLE);
  });

  test("the focus arrives on the chat mid-turn: the bubble has the part it did not see", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const app = await proxyAppSocket(page, skA);
    await openBoth(page, "P2");
    const turn = startTurn(skA, TURN);
    await expect.poll(() => turn.ranTool(), { timeout: 20_000, message: "the server ran the tool" }).toBe(true);
    await projectTab(page, p1).click();
    await expect(page.locator(`[data-chat-topic-id="${a}"]`).first()).toBeVisible();
    await expect.poll(() => app.saw("stream:end"), { timeout: 30_000 }).toBe(true);
    await expect
      .poll(() => bubbleOf(page, a), { timeout: 1_000, message: `within 1 s of the end, frames about A: ${app.state.frames.join(",")}` })
      .toEqual(WHOLE);
    await turn.done;
  });

  /**
   * The chat on screen, fast turns from outside, one token at a time as Codex
   * sends them: every chunk shows once. A history read in the middle of the
   * turn (the reconcile on `topic:updated`) answered with a snapshot that
   * already held the chunk the window was still buffering for its next frame,
   * the chunk was drawn twice, and the reconcile at the end was skipped as a
   * repeat within 5 s: the doubled chunk stayed until a refresh.
   */
  test("the chat on screen, fast turns from outside: every chunk shows once", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    test.setTimeout(180_000);
    // Its own chat: six turns of 150 chunks make a thread long enough that the
    // virtualised list no longer draws its tail, and the tests after this one
    // read the last bubble of theirs.
    const d = (await createTopic(request, "Live fast", { projectPath: p1, provider: "claude-code" })).id;
    try {
      const skD = await sessionKeyOf(request, d);
      await startTurn(skD, "warm up").done;
      await seedLayout(request, p1, d, p2, b);
      const sent = historyRequests(page, skD);
      await goToApp(page);
      await projectTab(page, p1).click();
      await expect(page.locator(`[data-chat-topic-id="${d}"]`).first()).toBeVisible({ timeout: 20_000 });
      const all = Array.from({ length: 150 }, (_, i) => i + 1);
      for (let rep = 1; rep <= 6; rep++) {
        await pastHistoryDedup(sent);
        const tag = `f${rep}`;
        await startTurn(skD, `FAST:150:20:${tag}`).done;
        await expect.poll(() => chunksOf(page, d, tag), { timeout: 5_000, message: `turn ${rep}` }).toEqual(all);
      }
    } finally {
      await deleteTopic(request, d).catch(() => {});
    }
  });

  /**
   * A history answer that lands after the turn ended does not open it again.
   * It carries the turn as the server had it when the request was READ: still
   * partial, still streaming. Applied after the end, it brought the spinner
   * back for good over the closed bubble, and the reconcile at the end found
   * the request in flight and skipped. The answer is held until the page has
   * seen the end, as the network of a phone or a loaded server does.
   *
   * Two ways a read can be in flight across the end: the reconcile on the
   * `topic:updated` that opens a turn, and the reload after a socket blip.
   */
  test("a history answer older than the end of the turn does not reopen it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const sent = historyRequests(page, skA);
    const app = await proxyAppSocket(page, skA);
    const answers = holdHistoryUntil(page, skA, () => app.saw("stream:end"));
    await openBoth(page, "P2");
    await pastHistoryDedup(sent);
    answers.arm();
    await startTurn(skA, "SLOW:1:qq").done;
    await expectClosedTurn(page, app, answers, ["qq-01"]);
  });

  test("a socket blip mid-turn: the reload that lands after the end does not reopen it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const app = await proxyAppSocket(page, skA);
    const answers = holdHistoryUntil(page, skA, () => app.saw("stream:end"));
    await openBoth(page, "P2");
    const turn = startTurn(skA, "SLOW:6:blip");
    await expect.poll(() => turn.said().includes("blip-04"), { timeout: 30_000 }).toBe(true);
    answers.arm();
    const opens = app.state.opens;
    await app.cut();
    app.state.refuse = false;
    await expect.poll(() => app.state.opens, { timeout: 20_000, message: "the socket comes back" }).toBeGreaterThan(opens);
    await turn.done;
    await expectClosedTurn(page, app, answers, ["blip-01", "blip-02", "blip-03", "blip-04", "blip-05", "blip-06"]);
  });

  /**
   * A turn stopped before it said anything, with a history read in flight: no
   * bubble is left behind. The server deletes an empty turn's row at its end
   * (`stream:end.discardedMessageId`), and an answer read before the delete
   * brought it back as a bubble with a spinner and a locked composer, until a
   * reload. Its own chat: the fake CLI of the silent turn is still asleep when
   * the test ends, and would hold up the next turn of a shared one.
   */
  test("a turn stopped before it said anything, a read in flight: no bubble left behind", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const c = (await createTopic(request, "Live silent", { projectPath: p1, provider: "claude-code" })).id;
    try {
      const skC = await sessionKeyOf(request, c);
      await startTurn(skC, "warm up").done;
      await seedLayout(request, p1, c, p2, b);
      const sent = historyRequests(page, skC);
      const app = await proxyAppSocket(page, skC);
      const answers = holdHistoryUntil(page, skC, () => app.saw("stream:end"));
      await goToApp(page);
      await projectTab(page, p1).click();
      await expect(page.locator(`[data-chat-topic-id="${c}"]`).first()).toBeVisible({ timeout: 20_000 });
      await pastHistoryDedup(sent);
      startTurn(skC, "SILENT:30000");
      await expect.poll(() => app.saw("stream:start"), { timeout: 20_000 }).toBe(true);
      answers.arm();
      const opens = app.state.opens;
      await app.cut();
      app.state.refuse = false;
      await expect.poll(() => app.state.opens, { timeout: 20_000, message: "the socket comes back" }).toBeGreaterThan(opens);
      await expect.poll(() => answers.state.held, { timeout: 15_000, message: "the reconnect reads the history" }).toBeGreaterThan(0);
      const stop = await fetch(`${E2E_BASE}/api/chat/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
        body: JSON.stringify({ sessionKey: skC }),
      });
      expect(stop.ok, "the turn is stopped").toBeTruthy();
      await expect.poll(() => app.saw("stream:end"), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => answers.state.delivered === answers.state.held, { timeout: 15_000 }).toBe(true);
      const rows = ((await (await request.get(`${E2E_BASE}/api/topics/${c}/messages?limit=50`)).json()) as { messages: { role: string }[] })
        .messages.filter((m) => m.role === "assistant").length;
      const bubbles = () => page.locator(`[data-chat-topic-id="${c}"] [data-testid="chat-message"][data-role="assistant"]`).count();
      await expect.poll(bubbles, { timeout: 5_000, message: "one bubble per assistant row of the database" }).toBe(rows);
      await expect.poll(() => busy(page, c), { timeout: 5_000, message: "no turn running on screen" }).toBe(false);
    } finally {
      await deleteTopic(request, c).catch(() => {});
    }
  });

  test("the socket is down when the turn ends: its return reloads the chat", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CCPROV-02" });
    const app = await proxyAppSocket(page, skA);
    const historyOfA: number[] = [];
    page.on("request", (r) => {
      if (r.url().includes(`/api/history/${encodeURIComponent(skA)}`)) historyOfA.push(Date.now());
    });
    await openBoth(page, "P2");
    const turn = startTurn(skA, TURN);
    await expect.poll(() => app.saw("stream:start"), { timeout: 20_000 }).toBe(true);
    await app.cut();
    await turn.done;
    const back = app.state.opens;
    const reopenedAt = Date.now();
    app.state.refuse = false;
    await expect.poll(() => app.state.opens, { timeout: 20_000, message: "the socket comes back" }).toBeGreaterThan(back);
    await expect
      .poll(() => historyOfA.filter((t) => t >= reopenedAt).length, { timeout: 10_000, message: "the reconnect reloads A" })
      .toBeGreaterThanOrEqual(1);
    await expect.poll(() => bubbleOf(page, a), { timeout: 5_000 }).toEqual(WHOLE);
    await projectTab(page, p1).click();
    await expect.poll(() => bubbleOf(page, a)).toEqual(WHOLE);
  });
});
