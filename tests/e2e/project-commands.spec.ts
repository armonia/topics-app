/**
 * E2E tests for /project slash commands (create, open, info).
 *
 * These commands are intercepted CLIENT-side in ChatPane (commandApi.project →
 * POST /api/command), and the result renders in the command-result BANNER
 * (a `font-mono` row that auto-dismisses after ~5s) — NOT as a `.message-content`
 * chat message. No AI mocking is needed; we test against the real server.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { existsSync, rmSync } from "fs";
import { join } from "path";

const BASE = "http://localhost:13334";
// Must agree with the server's WORKSPACE_DIR (server/routes/topics.ts —
// `join(OPENCLAW_DIR, "workspace")`). global-setup.ts propagates OPENCLAW_DIR
// to this runner process so both sides resolve the same isolated path.
const WORKSPACE_DIR = join(
  process.env.OPENCLAW_DIR || join(process.env.HOME || "/tmp", ".openclaw"),
  "workspace"
);

/**
 * Open a topic by finding it anywhere in the sidebar.
 * If not visible directly, tries to expand the project group node.
 */
async function openTopicAnywhere(
  page: import("@playwright/test").Page,
  name: string | RegExp,
  projectName?: string
) {
  const item = page.getByRole("treeitem", { name });

  let found = await item.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);

  if (!found && projectName) {
    // Topic is nested under a project node — click the project expand button
    const projectBtn = page.locator('button').filter({ hasText: new RegExp(projectName) }).first();
    if (await projectBtn.isVisible().catch(() => false)) {
      await projectBtn.click();
      found = await item.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    }
  }

  if (!found) {
    // Try expanding Chats section
    const chatsBtn = page.getByRole("button", { name: /Chats/ });
    if (await chatsBtn.isVisible().catch(() => false)) {
      await chatsBtn.click().catch(() => {});
      await page.getByRole("treeitem").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    }
    found = await item.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  }

  if (found) {
    await item.click();
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
    return;
  }

  // Fallback: a project-BOUND topic is absorbed into its project window and no
  // longer renders as a standalone sidebar treeitem. buildSidebarItems only
  // lists a project's child chat when it has an OPEN inner tab (or a
  // notification / pin), and the project's inner-pane layout is localStorage-
  // scoped — which does NOT survive a fresh Playwright context (each test gets
  // a new context, so a reload restores the project window with "No chats
  // open"). Open the topic via the ⌘K command palette instead: its
  // onOpenTopic → handleTopicClick opens the project window AND focuses this
  // topic's chat inside it (usePanelLifecycle.ts:1097 — setPendingProjectFocus).
  await page.keyboard.press("Meta+k");
  const overlay = page.locator('[data-testid="command-palette"]');
  await overlay.waitFor({ state: "visible", timeout: 5000 });
  const query = typeof name === "string" ? name : name.source;
  await overlay.getByRole("textbox").fill(query);
  const option = overlay.getByRole("option", { name }).first();
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();
  await overlay.waitFor({ state: "hidden", timeout: 5000 });
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Send a slash command in the open chat.
 *  Dismisses the slash autocomplete menu first (it intercepts Enter). */
async function sendCommand(page: import("@playwright/test").Page, command: string) {
  const textarea = page.getByRole("textbox", { name: /Message input/ });
  await textarea.waitFor({ state: "visible", timeout: 15_000 });
  await textarea.click();
  await textarea.fill(command);
  // Dismiss slash command menu if open (it intercepts Enter/Ctrl+Enter)
  await textarea.press("Escape");
  await textarea.press("Control+Enter");
}

test.describe.serial("Project Commands", () => {
  let topicId: string;
  const topicName = "ProjectCmd E2E " + Date.now();
  const testProjectName = `e2e-test-proj-${Date.now()}`;
  const testProjectDir = join(WORKSPACE_DIR, testProjectName);

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  test("AC-7: /project appears in slash command autocomplete", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });
    await textarea.click();
    await textarea.fill("/pro");

    const projectCmd = page.locator("span.font-mono").filter({ hasText: "/project" });
    await expect(projectCmd).toBeVisible({ timeout: 5_000 });
  });

  test("AC-5: /project open with nonexistent path shows error", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, "/project open /nonexistent/path/e2e-test");

    // A failed slash command renders in the command-result banner (ChatPane —
    // red `font-mono` row), NOT as a `.message-content` chat message. Target the
    // error text wherever it lands (it auto-dismisses after 5s, so poll fast).
    const errorMsg = page.getByText(/Project not found/i).first();
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-6: /project with no args shows list when no project bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, "/project");

    // Result renders in the command-result banner (regex = substring match over
    // the whitespace-pre-wrapped banner text), not a `.message-content` message.
    const infoMsg = page.getByText(/No project bound/i).first();
    await expect(infoMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-1: /project create creates directory and binds to topic", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project create ${testProjectName}`);

    // `/project create` binds the topic and FOCUSES the new project
    // (bindTopicToProject(..., { focus: true })), which transforms the standalone
    // chat pane into a project window — unmounting the transient command-result
    // banner almost immediately (it never paints a frame Playwright can catch).
    // So assert the DURABLE, authoritative outcome — which is exactly this test's
    // contract ("creates directory and binds to topic"): the topic→project
    // binding (the poll also gates on the async create finishing) + the dir and
    // CLAUDE.md on disk.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data.topics[topicId]?.projectPath;
        },
        { timeout: 10_000 }
      )
      .toBe(testProjectDir);

    expect(existsSync(testProjectDir)).toBe(true);
    expect(existsSync(join(testProjectDir, "CLAUDE.md"))).toBe(true);
  });

  test("AC-2: /project create with existing name shows error", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, `/project create ${testProjectName}`);

    // 409 → error banner via errMessage(e) = server's `error` string.
    const errorMsg = page.getByText(/already exists/i).first();
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-6b: /project shows current project when bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, "/project");

    const currentMsg = page.getByText(/Current project/i).first();
    await expect(currentMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-3: /project open binds existing project by name", async ({ page, request }) => {
    // Unbind via API
    await request.patch(`${BASE}/api/topics/${topicId}`, { data: { projectPath: null } });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project open ${testProjectName}`);

    // Like create, `/project open` binds + FOCUSES the project, transforming the
    // pane and unmounting the transient banner before it can be asserted. Assert
    // the durable binding (which is this test's contract: "binds existing project
    // by name"); the poll also gates on the async open completing.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data.topics[topicId]?.projectPath;
        },
        { timeout: 10_000 }
      )
      .toBe(testProjectDir);
  });

  test("AC-4: /project open binds by absolute path", async ({ page, request }) => {
    // Unbind first
    await request.patch(`${BASE}/api/topics/${topicId}`, { data: { projectPath: null } });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project open ${testProjectDir}`);

    // `/project open <abs path>` binds + FOCUSES the project, transforming the
    // pane and unmounting the transient banner. Assert the durable binding — the
    // real proof of "bind by absolute path".
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data.topics[topicId]?.projectPath;
        },
        { timeout: 10_000 }
      )
      .toBe(testProjectDir);
  });
});
