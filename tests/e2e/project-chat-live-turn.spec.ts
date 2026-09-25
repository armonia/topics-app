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
  return { ranTool: () => sse.includes("tool-visible"), done };
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
