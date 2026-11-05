/**
 * THE BELL IN GROUPS (hub-smistamento, HUBBR-06 and HUBBR-07).
 *
 * The bell «Da guardare» > Ora lists, in one order, «Decidi tu» (the waits of
 * Topics and the hub's «waiting for you» items together, deadlines first),
 * «Si è rotto», «Quote e account», «Da guardare» and «Finite». History merges
 * the hub's diary, without the routine runs that went well.
 *
 * The Topics side is real: a Claude Code terminal asks a question and another
 * finishes a turn, through the hooks route. The hub side is a fake (helpers/fake-hub.ts) on the port the test server
 * reads (`TOPICS_HUB_URL`, `TOPICS_SWITCHBOARD_URL`): the real :3360 and :3335
 * are never touched, and the names are placeholders.
 *
 * Mutation: with the hub's source taken out of the bell (`useBellHub` answering
 * no hub), «decidi tu in cima» is red: the first row of «Decidi tu» is the
 * Topics question, not the hub's item due first.
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-campanella-a-gruppi-*.png`).
 *
 * @covers HUBBR-06
 * @covers HUBBR-07
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { deleteTerminalSession } from "./helpers/api-fixtures";
import { createClaudeTerminal, postHook, type ClaudeTerminal } from "./helpers/attention";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

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

/** The reader holds the fake hub's waiting list: the bell can read it. */
async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const resp = await request.get(`${E2E_BASE}/api/hub-live`);
    const snap = (await resp.json()) as Record<string, { data?: { items?: unknown[] } }>;
    return snap.attesa?.data?.items?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
}

interface Scene { question: ClaudeTerminal; done: ClaudeTerminal }

/**
 * The hub's 3 waiting items and 4 warnings (1 failed automation, 1 service, 1
 * full week, 1 project over budget) come over HTTP (`/api/hub-live`); the two
 * Topics subjects come over the socket. WebKit on the Windows runner never
 * completes the socket handshake with the test server (0 «hello» in its log,
 * 2 for the two Chromium tests of the same run, 05/11): there the hub's side is
 * asserted alone, which is the half this spec is about.
 */
const socketOn = (project: string) => !(project === "webkit" && process.platform === "win32");

async function buildScene(request: APIRequestContext, page: Page, withTopics: boolean): Promise<Scene | null> {
  const stamp = Date.now();
  await goToApp(page);
  await expect(page.getByTestId("inbox-button")).toBeVisible({ timeout: 15_000 });
  if (!withTopics) {
    await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "7", { timeout: 20_000 });
    return null;
  }
  const question = await createClaudeTerminal(request, `Certificato ${stamp}`);
  const done = await createClaudeTerminal(request, `Smoke test ${stamp}`);
  await askQuestion(request, question);
  await finishTurn(request, done);
  // Both subjects lit, read on the button: 2 of Topics beside the hub's 7.
  await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "9", { timeout: 20_000 });
  return { question, done };
}

const panel = (page: Page) => page.getByTestId("inbox-panel");
const groupKeys = (page: Page) => panel(page).locator("[data-bell-group]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bellGroup));

test.describe("the bell in groups", () => {
  let hub: FakeHub | null = null;
  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
  });
  // The live reader keeps the fake's numbers until its next tick: the next
  // file (hub-off) asserts that nobody answers, so the hub goes down here and
  // the reader is waited on until it says so.
  test.afterAll(async ({ request }) => {
    await hub?.close();
    await expect.poll(async () => {
      const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
      return typeof snap.pace?.error;
    }, { timeout: 30_000 }).toBe("string");
  });

  test("Ora: Decidi tu first with the hub's deadline on top, then Si è rotto, Quote e account, Da guardare, Finite", async ({ page, request }, testInfo) => {
    let scene: Scene | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      const withTopics = socketOn(testInfo.project.name);
      scene = await buildScene(request, page, withTopics);

      // The button is amber: something waits for the person.
      const button = page.getByTestId("inbox-button");
      await expect(button).toHaveAttribute("data-tone", "needs-you");

      await button.click();
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look", ...(withTopics ? ["finished"] : [])]);

      // Decidi tu in cima: the item due in two hours, then the one due
      // tomorrow, then the oldest wait (the hub's, from yesterday), then the
      // Topics question.
      const decide = panel(page).getByTestId("inbox-waiting");
      await expect(decide).toHaveAttribute("data-count", withTopics ? "4" : "3");
      const decideRows = decide.locator("li");
      await expect(decideRows.first()).toHaveAttribute("data-source", "waiting");
      await expect(decideRows.first()).toContainText("Passare studio-x al piano Launch");
      await expect(decideRows.nth(1)).toContainText("Slide del corso");
      await expect(decideRows.nth(2)).toContainText("Rilasciare Topics 0.48");
      if (withTopics) await expect(decideRows.nth(3)).toHaveAttribute("data-testid", "inbox-row");

      // A service switched off on purpose or asleep on demand is not broken.
      const broken = panel(page).getByTestId("bell-group-broken");
      await expect(broken).toHaveAttribute("data-count", "2");
      await expect(broken).not.toContainText("Gateway vecchio");
      await expect(broken).not.toContainText("Router dei modelli gratis");
      await expect(panel(page).getByTestId("bell-group-quota")).toHaveAttribute("data-count", "3");
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

      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-scuro.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-chiaro.png") });
      await page.emulateMedia({ colorScheme: "dark" });

      // «Risolvi tu» queues the job on the hub, «Fatto» closes the item there.
      await broken.getByTestId("bell-fix").click();
      await expect(broken.getByTestId("bell-fix-queued")).toBeVisible();
      expect(hub!.posts).toContainEqual({ path: "fix", key: "gh:docs-reindex" });
      await decideRows.first().getByTestId("bell-done").click();
      await expect(decide).toHaveAttribute("data-count", withTopics ? "3" : "2");
      await expect(decide).not.toContainText("Passare studio-x al piano Launch");
      expect(hub!.posts).toContainEqual({ kind: "chiudi", ref: "e2e-spend" });

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
    } finally {
      await request.post(`${E2E_BASE}/api/hub/e2e-reset`).catch(() => {});
      if (scene) for (const t of [scene.question, scene.done]) await deleteTerminalSession(request, t.id);
    }
  });

  test("phone, 390 px: the same groups in the bottom sheet", async ({ browser, request }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-notification-count", "7");
      await page.getByTestId("inbox-button").click();
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => groupKeys(page), { timeout: 15_000 }).toEqual(["decide", "broken", "quota", "look"]);
      await expect(panel(page).getByTestId("inbox-waiting").locator("li").first()).toHaveAttribute("data-source", "waiting");
      await page.screenshot({ path: testInfo.outputPath("vero-campanella-a-gruppi-telefono.png") });
    } finally {
      await ctx.close();
      await request.post(`${E2E_BASE}/api/hub/e2e-reset`).catch(() => {});
    }
  });
});
