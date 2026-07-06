/**
 * E2E tests for /project slash commands (create, open, info).
 *
 * These commands are handled server-side and return synthetic SSE responses,
 * so no AI mocking is needed — we test against the real server.
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

  if (!found) throw new Error(`Could not find topic matching ${name} in sidebar`);

  await item.click();
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

    const errorMsg = page.locator(".message-content").filter({ hasText: /Directory not found/ });
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-6: /project with no args shows list when no project bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, "/project");

    const infoMsg = page.locator(".message-content").filter({ hasText: /No project bound/ });
    await expect(infoMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-1: /project create creates directory and binds to topic", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project create ${testProjectName}`);

    const successMsg = page.locator(".message-content").filter({
      hasText: new RegExp(`Created project.*${testProjectName}`),
    });
    await expect(successMsg).toBeVisible({ timeout: 10_000 });

    // Verify directory was created on disk
    expect(existsSync(testProjectDir)).toBe(true);
    expect(existsSync(join(testProjectDir, "CLAUDE.md"))).toBe(true);

    // Verify topic was bound (check via API)
    const res = await page.request.get(`${BASE}/api/topics`);
    const data = await res.json();
    expect(data.topics[topicId]?.projectPath).toBe(testProjectDir);
  });

  test("AC-2: /project create with existing name shows error", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, `/project create ${testProjectName}`);

    const errorMsg = page.locator(".message-content").filter({ hasText: /already exists/ });
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-6b: /project shows current project when bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, "/project");

    const currentMsg = page.locator(".message-content").filter({ hasText: /Current project/ });
    await expect(currentMsg).toBeVisible({ timeout: 10_000 });
  });

  test("AC-3: /project open binds existing project by name", async ({ page, request }) => {
    // Unbind via API
    await request.patch(`${BASE}/api/topics/${topicId}`, { data: { projectPath: null } });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project open ${testProjectName}`);

    const successMsg = page.locator(".message-content").filter({
      hasText: new RegExp(`Opened project.*${testProjectName}`),
    });
    await expect(successMsg).toBeVisible({ timeout: 10_000 });

    const res = await page.request.get(`${BASE}/api/topics`);
    const data = await res.json();
    expect(data.topics[topicId]?.projectPath).toBe(testProjectDir);
  });

  test("AC-4: /project open binds by absolute path", async ({ page, request }) => {
    // Unbind first
    await request.patch(`${BASE}/api/topics/${topicId}`, { data: { projectPath: null } });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, `/project open ${testProjectDir}`);

    // Wait for the response to appear (may match previous "Opened project" too)
    const allMsgs = page.locator(".message-content").filter({
      hasText: new RegExp(`Opened project.*${testProjectName}`),
    });
    // At least 2 should exist now (from AC-3 + AC-4)
    await expect(allMsgs.last()).toBeVisible({ timeout: 10_000 });

    // Verify binding via API
    const res = await page.request.get(`${BASE}/api/topics`);
    const data = await res.json();
    expect(data.topics[topicId]?.projectPath).toBe(testProjectDir);
  });
});
