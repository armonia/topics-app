/**
 * ONE SEEN-STATE PER SUBJECT, ONE NUMBER: what the inbox says and what every
 * other surface shows are the same fact (NOTIF-ONE-01, NOTIF-ONE-02 modified by
 * notifications-redesign).
 *
 * The report (2026-09-29): 133 on the dock; opening the sidebar's notifications
 * cleared them there and nowhere else. The global number summed MESSAGES, and
 * seeing in the panel cleared the panel only.
 *
 * Since notifications-redesign the number is the lit subjects, composed on the
 * server, and the seen is one door. So the chats here finish REAL turns (the
 * chat route, a fake CLI), the global number is read where the Dock and the PWA
 * badge read it (the Badging API, recorded), and the bell must say the same.
 *
 * What this file measured before and its twins now: the panel as a mark all
 * (opening marks nothing: `attention-inbox.spec.ts`), a card in review on the
 * bell (`attention-board-sidebar.spec.ts`), a finished chat seen in one window
 * and dark in the other (`attention-sync.spec.ts`), a hookless finished chat
 * counted once (`chat-finished-banner.spec.ts`).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { postHook, runChatTurn, sessionKeyOf, setAwake, stubBannersAndWindow } from "./helpers/attention";

hermetic(test);

const BASE = E2E_BASE;

type Unread = Record<string, { unreadCount?: number } | undefined>;

async function unreadOf(request: APIRequestContext, topicId: string): Promise<number> {
  const res = await request.get(`${BASE}/api/unread`);
  return ((await res.json()) as Unread)[topicId]?.unreadCount ?? 0;
}

/** Raise a chat's unread the way a message nobody asked for does. */
async function messages(request: APIRequestContext, topicId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: `msg ${i + 1}` } });
    expect(res.ok()).toBe(true);
  }
}

/** The Dock / PWA number, as last painted. */
const globalNumber = (page: Page) => page.evaluate(() => (window as unknown as { __appBadge: number }).__appBadge);
const bellCount = (page: Page) => page.getByTestId("inbox-count");
const bellNumber = async (page: Page): Promise<number> =>
  (await bellCount(page).count()) ? Number(await bellCount(page).getAttribute("data-notification-count")) : 0;
/**
 * What the spec's own chats add to both surfaces: the dock and the bell must
 * say the same thing.
 *
 * The number counts what is lit on the whole test server, and a spec that ran
 * earlier in the shard can leave something lit (a card in review, a question):
 * on PR #224 the board tab carried a review badge before this spec created
 * anything, and both surfaces said 1 where 0 was expected. The contract is what
 * THESE chats do to the number, so each reading is taken against `before`,
 * the number the app painted before they finished anything.
 */
async function expectBoth(page: Page, before: number, n: number): Promise<void> {
  await expect.poll(async () => (await globalNumber(page)) - before, { timeout: 10_000 }).toBe(n);
  await expect.poll(async () => (await bellNumber(page)) - before, { timeout: 10_000 }).toBe(n);
}

/** The number the app painted once its attention state arrived, before the spec lights anything. */
async function paintedBefore(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __appBadgePainted?: boolean }).__appBadgePainted === true), { timeout: 15_000 }).toBe(true);
  const before = await globalNumber(page);
  await expect.poll(() => bellNumber(page), { timeout: 10_000 }).toBe(before);
  return before;
}
const rowBadge = (page: Page, name: string) =>
  page.getByRole("treeitem", { name: new RegExp(name) }).first().locator("[data-notification-count]");
const tabBadge = (page: Page, topicId: string) => page.locator(`[data-pane-id="${topicId}"] [data-notification-count]`);

/** The OS badge, recorded where the app paints it. */
async function stubAppBadge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __appBadge: number; __appBadgePainted: boolean };
    w.__appBadge = 0;
    w.__appBadgePainted = false;
    const nav = navigator as unknown as { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> };
    nav.setAppBadge = (n?: number) => { w.__appBadge = n ?? 0; w.__appBadgePainted = true; return Promise.resolve(); };
    nav.clearAppBadge = () => { w.__appBadge = 0; w.__appBadgePainted = true; return Promise.resolve(); };
  });
}

const BOARD = "__board__";

test.describe("one number, one seen", () => {
  test.describe.configure({ timeout: 90_000 });
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  test("NOTIF-ONE: two chats, six messages: the Dock and the bell say 2; opening one from the inbox drops its unread, row, tab and number together", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
    test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-01" });
    const stamp = Date.now();
    const many = await createTopic(request, `OneTruth-Many-${stamp}`, { provider: "claude-code" });
    const few = await createTopic(request, `OneTruth-Few-${stamp}`, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [many.id, few.id, BOARD]);
      await stubAppBadge(page);
      await stubBannersAndWindow(page);
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
      await page.locator(`[data-pane-id="${BOARD}"]`).click();
      const before = await paintedBefore(page);

      // Two chats finish: one with three messages before its answer, one with one.
      await messages(request, many.id, 3);
      await runChatTurn(request, many.id, "many");
      await messages(request, few.id, 1);
      await runChatTurn(request, few.id, "few");
      expect(await unreadOf(request, many.id), "the first chat holds several unread").toBeGreaterThan(1);

      // Subjects, not messages: two.
      await expectBoth(page, before, 2);
      await page.getByTestId("inbox-button").click();
      for (const subject of [`topic:${many.id}`, `topic:${few.id}`]) {
        await expect(page.getByTestId("inbox-panel").locator(`[data-testid="inbox-row"][data-subject="${subject}"]`)).toHaveCount(1);
      }
      // The row and the tab may show the chat's own messages.
      await expect(tabBadge(page, many.id)).toHaveAttribute("data-notification-count", String(await unreadOf(request, many.id)));

      // Opening it from the inbox is seeing it: everything drops together.
      await setAwake(page, true);
      await page.getByTestId("inbox-panel").locator(`[data-testid="inbox-row"][data-subject="topic:${many.id}"] [data-inbox-row]`).click();
      await expectBoth(page, before, 1);
      await expect.poll(() => unreadOf(request, many.id), { timeout: 10_000 }).toBe(0);
      await expect(rowBadge(page, many.name)).toHaveCount(0);
      await expect(tabBadge(page, many.id)).toHaveCount(0);
    } finally {
      await deleteTopic(request, many.id);
      await deleteTopic(request, few.id);
    }
  });

  test("NOTIF-ONE: a chat read while its phase stays awaiting-user does not count", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
    const stamp = Date.now();
    const chat = await createTopic(request, `OneTruth-Hooked-${stamp}`, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [chat.id, BOARD]);
      await stubAppBadge(page);
      await stubBannersAndWindow(page);
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
      await page.locator(`[data-pane-id="${BOARD}"]`).click();
      const before = await paintedBefore(page);

      // The turn ends, and its CLI's hook says so too: the phase is
      // `awaiting-user`, which used to count until the next turn.
      await runChatTurn(request, chat.id, "finish");
      const key = await sessionKeyOf(request, chat.id);
      let cli = "";
      await expect.poll(async () => {
        const { sessions } = (await (await request.get(`${BASE}/api/claude-sessions`)).json()) as { sessions: { sessionKey: string | null; claudeSessionId: string }[] };
        cli = sessions.find((s) => s.sessionKey === key)?.claudeSessionId ?? "";
        return cli;
      }, { timeout: 10_000 }).not.toBe("");
      await postHook(request, "Stop", { session_id: cli });
      await expectBoth(page, before, 1);

      // Read: nothing counts, though the phase is still awaiting-user.
      await setAwake(page, true);
      await page.locator(`[data-pane-id="${chat.id}"]`).click();
      await expectBoth(page, before, 0);
      await expect(rowBadge(page, chat.name)).toHaveCount(0);
    } finally {
      await deleteTopic(request, chat.id);
    }
  });
});
