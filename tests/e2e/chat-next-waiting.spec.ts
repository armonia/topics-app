/**
 * ⌘J: THE NEXT CHAT WAITING FOR YOU, and the same step from the phone's door.
 *
 * Three chats, seeded with no fake inside the app:
 *   - A parked on a permission: a `session:state` frame with the
 *     `awaiting-approval` phase, injected on the intercepted socket;
 *   - B parked on an in-app question: a turn in flight
 *     (`POST /api/test/streams/partial`) whose last row carries
 *     `mcp__topics__ask_user_question` in `waiting_for_input`, which
 *     `GET /api/topics/streaming` reports as `waiting`;
 *   - C with a turn in flight and no question: working, never a target.
 *
 * B and C are seeded BEFORE the page loads, so the first snapshot the client
 * asks for already tells them apart (a seed after the load would race the
 * snapshot that `stream:start` schedules 400 ms later).
 *
 * The expected order is read from the «Attende te» section of the state view,
 * not written here: the queue is defined as that sequence (CHAT-WAIT-03), and
 * this is the only place both can be compared on the same screen.
 *
 * Behaviour, so a video: the `.webm` of the three presses is the proof.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

interface Seeded { id: string; name: string; sessionKey: string }

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey?: string }> };
  const key = body.topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: the seed cannot reach it`);
  return key;
}

async function mk(request: APIRequestContext, label: string): Promise<Seeded> {
  const name = `next-waiting-${label}-${Date.now()}`;
  const t = await createTopic(request, name);
  return { id: t.id, name, sessionKey: await sessionKeyOf(request, t.id) };
}

/** A turn in flight; with `ask`, its last row is a question waiting for you. */
async function turnInFlight(request: APIRequestContext, s: Seeded, ask: boolean): Promise<void> {
  expect((await request.post(`${E2E_BASE}/api/test/streams/partial`, { data: { sessionKey: s.sessionKey } })).ok()).toBe(true);
  if (!ask) return;
  const question = "Quale ramo tengo?";
  const options = [{ label: "main", description: "" }, { label: "feat", description: "" }];
  await seedMessage(request, {
    sessionKey: s.sessionKey,
    role: "assistant",
    content: "Mi serve una scelta:",
    toolCalls: [{
      id: `ask-${Date.now()}`,
      name: "mcp__topics__ask_user_question",
      args: { questions: [{ question, header: "Ramo", options }] },
      status: "waiting_for_input",
      startedAt: Date.now() - 2_000,
      userInputSchema: { kind: "questions", questions: [{ question, header: "Ramo", options, multiSelect: false }] },
    }],
  });
}

/** The state view, seeded in storage like `tab-state-view.spec.ts`: the
 *  toggle lives in a sidebar popover, and driving it would test the menu. */
async function stateView(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const raw = window.localStorage.getItem("topics-sidebar-state");
      const prev = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem("topics-sidebar-state", JSON.stringify({ ...prev, viewMode: "state" }));
    } catch { /* no storage: the assertions below say so */ }
  });
}

function permission(ws: Awaited<ReturnType<typeof interceptWebSocket>>, s: Seeded): void {
  ws.send({ type: "session:state", sessionKey: s.sessionKey, state: { phase: "awaiting-approval", rev: 1, claudeSessionId: s.sessionKey } });
}

/** The ids of the «Attende te» rows, top to bottom. */
async function awaitingOrder(page: Page, seeded: Seeded[]): Promise<string[]> {
  const names = await page.locator('[data-testid="sidebar-state-section-awaiting"] [data-row-name="chat"]').allTextContents();
  return names.map((n) => seeded.find((s) => s.name === n.trim())?.id ?? `unknown:${n}`);
}

const activeTab = (page: Page) => page.locator('[role="tab"][data-active="true"]');
const focusedRow = (page: Page) => page.locator('[role="treeitem"][aria-selected="true"]');

test.describe("⌘J, on the desktop", () => {
  test("two chats waiting and one working: ⌘J walks the waiting ones and wraps", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    const c = await mk(request, "c");
    try {
      await turnInFlight(request, b, true);
      await turnInFlight(request, c, false);
      await resetPaneStore(request, [a.id, b.id, c.id]);
      await stateView(page);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(page.locator(`[role="tab"][data-pane-id="${c.id}"]`)).toBeVisible({ timeout: 15_000 });
      permission(ws, a);

      const awaiting = page.locator('[data-testid="sidebar-state-section-awaiting"]');
      await expect(awaiting.locator('[data-row-name="chat"]')).toHaveCount(2, { timeout: 20_000 });
      await expect(awaiting).toContainText(a.name);
      await expect(awaiting).toContainText(b.name);
      await expect(page.locator('[data-testid="sidebar-state-section-working"]')).toContainText(c.name);
      const order = await awaitingOrder(page, [a, b, c]);

      await page.locator(`[role="tab"][data-pane-id="${c.id}"]`).click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", c.id);

      for (const expected of [order[0], order[1], order[0]]) {
        await page.keyboard.press("Meta+j");
        await expect(activeTab(page)).toHaveAttribute("data-pane-id", expected!);
        await expect(activeTab(page)).not.toHaveAttribute("data-pane-id", c.id);
      }
    } finally {
      for (const s of [a, b, c]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test("in the app, no other chat waiting: a notice, and the focus stays", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-03" });
    const a = await mk(request, "only");
    try {
      await resetPaneStore(request, [a.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      const tab = page.locator(`[role="tab"][data-pane-id="${a.id}"]`);
      await expect(tab).toBeVisible({ timeout: 15_000 });
      permission(ws, a);
      await expect(tab).toHaveAttribute("data-attention", "input", { timeout: 15_000 });
      await tab.click();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);

      await page.keyboard.press("Meta+j");
      await expect(page.getByTestId("toast").filter({ hasText: "Nessun'altra chat ti aspetta" })).toBeVisible();
      await expect(activeTab(page)).toHaveAttribute("data-pane-id", a.id);
    } finally {
      await deleteTopic(request, a.id).catch(() => {});
    }
  });
});

test.describe("the «In attesa» door, on the phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const door = (page: Page) => page.locator('[data-testid="mobile-chrome-bar"] [data-testid="mobile-chrome-waiting"]');

  test("the door counts the two waiting and takes you to them, never to the working one", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-04" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    const c = await mk(request, "c");
    try {
      await turnInFlight(request, b, true);
      await turnInFlight(request, c, false);
      await resetPaneStore(request, [a.id, b.id, c.id]);
      await stateView(page);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(door(page)).toBeVisible({ timeout: 15_000 });
      permission(ws, a);

      await expect(door(page).locator("[data-notification-count]")).toHaveAttribute("data-notification-count", "2", { timeout: 20_000 });
      const queue = await awaitingOrder(page, [a, b, c]);
      expect([...queue].sort()).toEqual([a.id, b.id].sort());

      // Start from the working chat, as on the desktop.
      await page.locator(`[role="treeitem"][aria-label="${c.name}"]`).tap();
      await expect(focusedRow(page)).toHaveAttribute("aria-label", c.name);

      for (const expected of [queue[0], queue[1]]) {
        await door(page).tap();
        const name = [a, b].find((s) => s.id === expected)!.name;
        await expect(focusedRow(page)).toHaveAttribute("aria-label", name);
        await expect(focusedRow(page)).not.toHaveAttribute("aria-label", c.name);
      }
    } finally {
      for (const s of [a, b, c]) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test("at zero the door is off and nothing moves when the number comes", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-04" });
    const a = await mk(request, "a");
    const b = await mk(request, "b");
    try {
      await resetPaneStore(request, [a.id, b.id]);
      const ws = await interceptWebSocket(page);
      await goToApp(page);
      await expect(door(page)).toBeVisible({ timeout: 15_000 });
      await expect(door(page)).toBeDisabled();

      const widths = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="mobile-chrome-bar"] button')).map((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.width)];
        }),
      );
      const atZero = await widths();
      expect(atZero.length).toBe(5);

      permission(ws, a);
      permission(ws, b);
      await expect(door(page).locator("[data-notification-count]")).toHaveAttribute("data-notification-count", "2", { timeout: 15_000 });
      await expect(door(page)).toBeEnabled();
      expect(await widths()).toEqual(atZero);
    } finally {
      for (const s of [a, b]) await deleteTopic(request, s.id).catch(() => {});
    }
  });
});
