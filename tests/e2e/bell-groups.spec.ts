/**
 * THE BELL IN GROUPS (hub-smistamento, HUBBR-06 and HUBBR-07).
 *
 * The bell's «Now» tab lists, in one order, the group to decide (the waits of
 * Topics and the hub's «waiting for you» items together, deadlines first),
 * the broken group, quotas and accounts, the group to look at and the
 * finished one. History merges the hub's diary, without the routine runs that
 * went well. The pill says the figure of the group to decide, no sum.
 *
 * The Topics side is real: a Claude Code terminal asks a question and another
 * finishes a turn (the hooks route), a chat asks a permission (the bridge's own
 * legs, answered from the bell's row), a card waits in review (the board's
 * route). The hub side is a fake (helpers/fake-hub.ts) on the port the test
 * server reads (`TOPICS_HUB_URL`, `TOPICS_SWITCHBOARD_URL`): the real :3360 and
 * :3335 are never touched, and the names are placeholders.
 *
 * The four states of the mockup are filmed and shot: the groups (desktop, light
 * and dark, and the phone at 390 px), the hub down after it answered (band,
 * «Retry», the foot that says since when), and the empty panel.
 *
 * Mutation: with the hub's source taken out of the bell (`useBellHub` answering
 * no hub), «decidi tu in cima» is red: the first row of «Decidi tu» is the
 * Topics question, not the hub's item due first.
 *
 * The shots are taken in the mockups' workspace (helpers/shot-scene.ts):
 * acme-web and studio-x with their chats in the sidebar, a chat with messages.
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-campanella-a-gruppi-*.png`).
 *
 * @covers HUBBR-06
 * @covers HUBBR-07
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { openMainChat, seedScene, type Scene as ShotScene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { createTopic, deleteTask, deleteTerminalSession, deleteTopic } from "./helpers/api-fixtures";
import { createClaudeTerminal, postHook, sessionKeyOf, type ClaudeTerminal } from "./helpers/attention";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { taskSubject, terminalSubject, topicSubject } from "../../shared/attention";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const TOOL_INPUT = { command: "npm publish" };

async function askQuestion(request: APIRequestContext, t: ClaudeTerminal): Promise<void> {
  await postHook(request, "UserPromptSubmit", { session_id: t.claudeSessionId, cwd: t.cwd, prompt: "prepare the release" });
  await postHook(request, "PreToolUse", {
    session_id: t.claudeSessionId, cwd: t.cwd, tool_name: "mcp__topics__ask_user_question", tool_use_id: `toolu_ask_${t.id.slice(0, 6)}`,
    tool_input: { questions: [{ question: "Carico il certificato nuovo?", options: [{ label: "Sì" }, { label: "No" }] }] },
  });
}

async function finishTurn(request: APIRequestContext, t: ClaudeTerminal): Promise<void> {
  await postHook(request, "UserPromptSubmit", { session_id: t.claudeSessionId, cwd: t.cwd, prompt: "run the smoke test" });
  await postHook(request, "Stop", { session_id: t.claudeSessionId, cwd: t.cwd });
}

/** The bridge's legs, as the CLI's permission tool makes them, until somebody decides. */
async function askPermission(request: APIRequestContext, sessionKey: string, toolUseId: string): Promise<{ decision?: string; cancelled?: boolean }> {
  for (let legs = 0; legs < 400; legs++) {
    const r = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/permission`, {
      data: { toolName: "Bash", input: TOOL_INPUT, toolUseId, legMs: 1000 }, timeout: 30_000,
    }).catch(() => null);
    if (!r) return { cancelled: true };
    const body = (await r.json()) as { decision?: string; cancelled?: boolean; pending?: boolean };
    if (!body.pending) return body;
  }
  return { cancelled: true };
}

/** The reader holds the fake hub's waiting list: the bell can read it. */
async function waitForHub(request: APIRequestContext, items = 1): Promise<void> {
  await expect.poll(async () => {
    const resp = await request.get(`${E2E_BASE}/api/hub-live`);
    const snap = (await resp.json()) as Record<string, { data?: { items?: unknown[] } }>;
    return snap.attesa?.data?.items?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThanOrEqual(items);
}

/** The reader says the hub is silent: every topic in error. */
async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.pace?.error;
  }, { timeout: 30_000 }).toBe("string");
}

/**
 * The Topics subjects: a question and a finished turn (terminals, hooks), a
 * permission (a chat, the bridge), a card in review. They come to the page over
 * the socket. WebKit on the Windows runner never completes the socket handshake
 * with the test server (0 «hello» in its log, 2 for the Chromium tests of the
 * same run, 05/11): there the hub's side is asserted alone. On the Mac, WebKit
 * (the engine the desktop shell ships) takes the socket and the whole scene.
 */
const socketOn = (project: string) => !(project === "webkit" && process.platform === "win32");

interface Scene {
  question: ClaudeTerminal;
  done: ClaudeTerminal;
  chat: { id: string };
  sessionKey: string;
  toolCallId: string;
  decided: Promise<{ decision?: string; cancelled?: boolean }>;
  cardId: string;
  boardId: string;
  dir: string;
}

/** A folder named like the mockup's projects, so the rows say «acme-web» and not a temporary path. */
function projectDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** In the root of the shot scene: the same acme-web folder, so its chats and its waits are one project row. */
async function buildScene(request: APIRequestContext, root: string): Promise<Scene> {
  const web = projectDir(root, "acme-web");
  const api = projectDir(root, "acme-api");
  const question = await createClaudeTerminal(request, "Claude Code", web);
  const done = await createClaudeTerminal(request, "Smoke test della release", web);
  await askQuestion(request, question);
  await finishTurn(request, done);

  // A chat of acme-api asks to run `npm publish`: the row the route paints, then the bridge's legs.
  const chat = await createTopic(request, "Claude Code", { provider: "claude-code", projectPath: api });
  const sessionKey = await sessionKeyOf(request, chat.id);
  const toolCallId = `toolu_bell_perm_${Date.now()}`;
  await request.delete(`${E2E_BASE}/api/tool-grants/${encodeURIComponent("Bash")}`);
  await request.patch(`${E2E_BASE}/api/topics/${chat.id}`, { data: { autonomyLevel: "auto-apply" } });
  const tc = {
    id: toolCallId, name: "Bash", args: TOOL_INPUT, status: "awaiting_permission" as const, startedAt: Date.now(),
    permissionRequest: { toolName: "Bash", input: TOOL_INPUT, requestedAt: Date.now() },
  };
  await seedMessage(request, { sessionKey, role: "user", content: "publish the package" });
  await seedMessage(request, { sessionKey, role: "assistant", content: "Publishing:", toolCalls: [tc], blocks: [{ kind: "text", text: "Publishing:" }, { kind: "tool", toolCall: tc }] });
  const decided = askPermission(request, sessionKey, toolCallId);

  // A card of acme-web in review.
  const boardId = projectIdForPath(web);
  const created = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, { data: { text: "Sign release builds", status: "review" } });
  expect(created.ok(), await created.text()).toBe(true);
  const cardId = ((await created.json()) as { id: string }).id;

  return { question, done, chat, sessionKey, toolCallId, decided, cardId, boardId, dir: root };
}

async function dropScene(request: APIRequestContext, scene: Scene | null): Promise<void> {
  if (!scene) return;
  for (const t of [scene.question, scene.done]) await deleteTerminalSession(request, t.id).catch(() => {});
  await deleteTopic(request, scene.chat.id).catch(() => {});
  await deleteTask(request, scene.boardId, scene.cardId).catch(() => {});
}

const panel = (page: Page) => page.getByTestId("inbox-panel");
const groupKeys = (page: Page) => panel(page).locator("[data-bell-group]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bellGroup));

test.describe("the bell in groups", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;
  // The mockups' workspace (projects with their chats, a chat with messages) the shots are taken in.
  let shot: ShotScene | null = null;
  let withTopics = true;
  // The scene's own request context: the bridge's legs run across the tests,
  // and the `request` of a hook is disposed when the hook ends.
  let api: APIRequestContext | null = null;
  test.beforeAll(async ({ request }, testInfo) => {
    hub = await startFakeHub();
    await waitForHub(request);
    withTopics = socketOn(testInfo.project.name);
    api = await playwrightRequest.newContext();
    shot = await seedScene(api, `${canonicalTmpRoot()}/e2e-bell-groups-${Date.now().toString(36)}`);
    if (withTopics) scene = await buildScene(api, shot.root);
  });
  // The live reader keeps the fake's numbers until its next tick: the next
  // file (hub-off) asserts that nobody answers, so the hub goes down here and
  // the reader is waited on until it says so.
  test.afterAll(async ({ request }) => {
    await dropScene(request, scene);
    await shot?.cleanup(request);
    await api?.dispose();
    await hub?.close();
    await waitForHubDown(request);
  });

  test("phone, 390 px: the same groups in the bottom sheet, the waits of Topics among the hub's", async ({ browser, request }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      // 3 of the hub, and (with the socket) the question, the permission and the review of Topics.
      await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", withTopics ? "6" : "3", { timeout: 20_000 });
      await page.getByTestId("inbox-button").click();
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look", ...(withTopics ? ["finished"] : [])]);
      const decide = panel(page).getByTestId("inbox-waiting").locator("li");
      await expect(decide.first()).toHaveAttribute("data-source", "waiting");
      if (withTopics) {
        await expect(decide).toHaveCount(6);
        await expect(decide.nth(3)).toHaveAttribute("data-subject", terminalSubject(scene!.question.id));
        await expect(decide.nth(3)).toBeInViewport();
      }
      // Nothing wider than the phone: no row, chip or button pushes the sheet sideways.
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        sheet: document.querySelector<HTMLElement>('[data-testid="inbox-panel"]')!.scrollWidth,
        list: document.querySelector<HTMLElement>('[data-testid="inbox-panel-now"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.sheet).toBeLessThanOrEqual(390);
      expect(widths.list).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-telefono.png") });
      // The rest of the list, scrolled to its end: the finished at the bottom, the foot still in view.
      await panel(page).getByTestId("inbox-panel-now").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      if (withTopics) await expect(panel(page).getByTestId("inbox-finished")).toBeInViewport();
      await expect(panel(page).locator('[data-hub="live"]')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-telefono-fine.png") });
    } finally {
      await ctx.close();
    }
  });

  test("Now: decide first with the hub's deadline on top, then broken, quotas, to look at, finished; the rows answer in place", async ({ page, request }, testInfo) => {
    try {
      // Tall enough for the five groups at once, as the mockup shows them.
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.emulateMedia({ colorScheme: "dark" });
      await goToApp(page);
      await openMainChat(page, shot!);
      await expect(page.getByTestId("inbox-button")).toBeVisible({ timeout: 15_000 });
      // The pill is the figure of the group to decide: 3 of the hub, 3 of Topics; never a sum with the warnings.
      await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", withTopics ? "6" : "3", { timeout: 20_000 });

      // The button is amber: something waits for the person.
      const button = page.getByTestId("inbox-button");
      await expect(button).toHaveAttribute("data-tone", "needs-you");

      await button.click();
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look", ...(withTopics ? ["finished"] : [])]);

      // Decidi tu in cima: the item due in two hours, then the one due
      // tomorrow, then the oldest wait (the hub's, from yesterday), then the
      // waits of Topics, the oldest first: the question, the permission, the review.
      const decide = panel(page).getByTestId("inbox-waiting");
      await expect(decide).toHaveAttribute("data-count", withTopics ? "6" : "3");
      const decideRows = decide.locator("li");
      await expect(decideRows.first()).toHaveAttribute("data-source", "waiting");
      await expect(decideRows.first()).toContainText("Passare studio-x al piano Launch");
      await expect(decideRows.nth(1)).toContainText("Slide del corso");
      await expect(decideRows.nth(2)).toContainText("Rilasciare Topics 0.48");
      if (withTopics) {
        // All six in view: a wait for the person is never folded under «N more».
        await expect(decideRows).toHaveCount(6);
        await expect(decide.getByTestId("bell-more")).toHaveCount(0);
        const question = decideRows.nth(3);
        await expect(question).toHaveAttribute("data-subject", terminalSubject(scene!.question.id));
        await expect(question).toContainText("Carico il certificato nuovo?");
        await expect(question.getByTestId("bell-answer")).toHaveText("Rispondi");
        const permission = decideRows.nth(4);
        await expect(permission).toHaveAttribute("data-subject", topicSubject(scene!.chat.id));
        await expect(permission).toContainText("Permesso: npm publish");
        await expect(permission).toContainText("acme-api");
        await expect(permission.getByTestId("bell-allow")).toHaveText("Consenti");
        await expect(permission.getByTestId("bell-deny")).toHaveText("Nega");
        const review = decideRows.nth(5);
        await expect(review).toHaveAttribute("data-subject", taskSubject(scene!.cardId));
        await expect(review).toContainText("Review: Sign release builds");
        await expect(review.getByTestId("bell-answer")).toHaveText("Apri la card");
      }

      // A service switched off on purpose or asleep on demand is not broken.
      const broken = panel(page).getByTestId("bell-group-broken");
      await expect(broken).toHaveAttribute("data-count", "2");
      await expect(broken).not.toContainText("Gateway vecchio");
      await expect(broken).not.toContainText("Router dei modelli gratis");
      const quota = panel(page).getByTestId("bell-group-quota");
      await expect(quota).toHaveAttribute("data-count", "3");
      await expect(panel(page).getByTestId("bell-group-look")).toHaveAttribute("data-count", "2");
      if (withTopics) await expect(panel(page).getByTestId("inbox-finished")).toHaveAttribute("data-count", "1");
      // The chips on top say the same numbers as the groups.
      const keys = ["decide", "broken", "quota", "look", ...(withTopics ? ["finished"] : [])];
      await expect(panel(page).getByTestId("bell-chip")).toHaveCount(keys.length);
      for (const key of keys) {
        const n = await panel(page).locator(`[data-bell-group="${key}"]`).getAttribute("data-count");
        await expect(panel(page).locator(`[data-testid="bell-chip"][data-group="${key}"]`)).toHaveAttribute("data-count", n ?? "");
      }
      // No file name of the contradiction reaches the screen.
      await expect(panel(page)).not.toContainText("rules-a.md");
      // The pill and the chip of the group to decide say the same number.
      await expect(panel(page).locator('[data-testid="bell-chip"][data-group="decide"]')).toHaveAttribute("data-count", (await page.getByTestId("inbox-count").getAttribute("data-notification-count")) ?? "");
      // The times read as words of the panel (allow-italian: the copy under test): «adesso», «N min», a clock, «ieri».
      for (const time of await panel(page).getByTestId("bell-time").allTextContents()) {
        expect(time).toMatch(/^(adesso|\d+ min|\d{2}:\d{2}|ieri|\d{1,2} \S+)$/);
      }
      // The foot: who is at work and whether the hub answers.
      await expect(panel(page).locator('[data-hub="live"]')).toBeVisible();
      // Every group is on screen at once, the last one included.
      if (withTopics) await expect(panel(page).getByTestId("inbox-finished")).toBeInViewport();
      await expect(panel(page).getByTestId("bell-group-look")).toBeInViewport();

      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-scuro.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-chiaro.png") });
      await page.emulateMedia({ colorScheme: "dark" });

      // The fix button queues the job on the hub, the done button closes the item there.
      await broken.getByTestId("bell-fix").click();
      await expect(broken.getByTestId("bell-fix-queued")).toBeVisible();
      expect(hub!.posts).toContainEqual({ path: "fix", key: "gh:docs-reindex" });
      // The expired token is renewed on the proxy, under its own name for the account.
      await quota.getByTestId("bell-renew").click();
      await expect(quota.getByTestId("bell-renewed")).toBeVisible();
      expect(hub!.posts).toContainEqual({ path: "refresh", name: "prof-c" });
      await decideRows.first().getByTestId("bell-done").click();
      await expect(decide).toHaveAttribute("data-count", withTopics ? "5" : "2");
      await expect(decide).not.toContainText("Passare studio-x al piano Launch");
      expect(hub!.posts).toContainEqual({ kind: "chiudi", ref: "e2e-spend" });
      if (withTopics) {
        // «Consenti» on the row is the decision of the chat's panel: the bridge's leg gets `allow`, the row goes.
        await decide.locator(`[data-subject="${topicSubject(scene!.chat.id)}"]`).getByTestId("bell-allow").click();
        expect((await scene!.decided).decision).toBe("allow");
        await expect(decide.locator(`[data-subject="${topicSubject(scene!.chat.id)}"]`)).toHaveCount(0, { timeout: 15_000 });
        await expect(decide).toHaveAttribute("data-count", "4");
      }

      // Cronologia: the diary without the routine runs, and its filter.
      await panel(page).getByTestId("inbox-tab-history").click();
      await expect(panel(page).getByTestId("bell-history-filter")).toBeVisible();
      const diary = panel(page).getByTestId("bell-diary-row");
      await expect(diary.first()).toBeVisible();
      await panel(page).getByTestId("bell-history-hub").click();
      await expect(diary).toHaveCount(3);
      await expect(panel(page).getByTestId("inbox-history-row")).toHaveCount(0);
      await expect(panel(page)).not.toContainText("Backup del Mac");
      await expect(panel(page)).not.toContainText("Brief del mattino");
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-cronologia-scuro.png") });

      // A stopped service is read where the machine is: its button closes the bell and opens Processes.
      await panel(page).getByTestId("inbox-tab-now").click();
      const open = panel(page).getByTestId("bell-group-broken").getByTestId("bell-open-processes");
      await expect(open).toHaveCount(1);
      await expect(open).toHaveText("Apri in Processi");
      await open.click();
      await expect(panel(page)).toHaveCount(0);
      await expect(page.getByTestId("machine-processes")).toBeVisible({ timeout: 15_000 });
    } finally {
      await request.post(`${E2E_BASE}/api/hub/e2e-reset`).catch(() => {});
    }
  });

  test("the hub stops answering: Topics alone under the band, the foot says since when, «Riprova» brings the hub back", async ({ page, request }, testInfo) => {
    // The band comes from the reader's error frame, on the socket.
    test.skip(!withTopics, "WebKit on the Windows runner has no socket with the test server");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, shot!);
    await page.getByTestId("inbox-button").click();
    await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look", "finished"]);

    await hub!.close();
    await waitForHubDown(request);
    const band = panel(page).getByTestId("bell-hub-down");
    await expect(band).toBeVisible({ timeout: 30_000 });
    await expect(band).toContainText("Hub non raggiungibile: vedi solo Topics");
    await expect(band.getByTestId("bell-hub-retry")).toHaveText("Riprova");
    // Only the groups of Topics: the question and the review to decide, the finished turn.
    await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "finished"]);
    await expect(panel(page).getByTestId("inbox-waiting").locator("li")).toHaveCount(2);
    await expect(panel(page).getByTestId("inbox-waiting").locator('[data-source="waiting"]')).toHaveCount(0);
    // The pill is the figure of Topics alone.
    await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "2");
    const foot = panel(page).locator('[data-hub="down"]');
    await expect(foot).toBeVisible();
    await expect(foot.getByTestId("bell-footer-hub")).toHaveText(/^hub fermo (ora|da \d+ (min|h))$/);
    await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-hub-giu-scuro.png") });

    // The hub is back: «Retry» asks now, without waiting for the reader's next tick.
    hub = await startFakeHub();
    await band.getByTestId("bell-hub-retry").click();
    await expect(band).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look", "finished"]);
    await expect(panel(page).locator('[data-hub="live"]')).toBeVisible();
  });

  test("nothing waits, nothing broken: one line, and the log one click away", async ({ page, request }, testInfo) => {
    // A hub with nothing to say, and no subject of Topics lit.
    await hub?.close();
    await waitForHubDown(request);
    hub = await startFakeHub([], { quiet: true });
    await expect.poll(async () => {
      const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown }>;
      return snap.attesa?.data !== undefined;
    }, { timeout: 30_000 }).toBe(true);
    await dropScene(request, scene);
    scene = null;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, shot!);
    await expect(page.getByTestId("inbox-count")).toHaveCount(0, { timeout: 20_000 });
    await page.getByTestId("inbox-button").click();
    const empty = panel(page).getByTestId("inbox-empty");
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toContainText("Niente aspetta te, niente di rotto.");
    await expect(panel(page).getByTestId("bell-chip")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-vuoto-scuro.png") });
    await empty.getByTestId("inbox-empty-history").click();
    await expect(panel(page).getByTestId("inbox-tab-history")).toHaveAttribute("aria-selected", "true");
  });
});
