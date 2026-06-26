import { expect } from "@playwright/test";
import { test, type TerminalPage } from "./fixtures/terminal.fixture";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  reloadTerminalSession,
  listTerminalSessions,
  deleteTerminalSession,
} from "./helpers/api-fixtures";
import { goToApp, openTopic } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * Coverage for the tab right-click "Ricarica" action (terminal-tab-reload change).
 * Core logic (kill → wait exit → recreate same id, with --resume for claude/codex)
 * is exercised at the server-endpoint level; the UI test verifies the menu item
 * appears for terminal tabs and triggers the reload. Real `claude` sessions are not
 * driven in E2E (subscription/billing constraint) — the `--resume` branch is covered
 * by the server endpoint + manual smoke.
 */
test.describe.serial("Terminal tab reload", () => {
  const projectPath = "/tmp";
  const topicName = `e2e-term-reload-${Date.now()}`;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    // Clean slate: stale /tmp shell sessions from prior runs would make the
    // project-terminal open reconnect to a dead PTY (empty xterm) and flake.
    for (const s of await listTerminalSessions(request)) {
      await deleteTerminalSession(request, s.id);
    }
    const topic = await createTopic(request, topicName, { projectPath });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      const sessions = await listTerminalSessions(request, topicId);
      for (const s of sessions) await deleteTerminalSession(request, s.id);
      await deleteTopic(request, topicId);
    }
  });

  test("POST /reload restarts a shell session in place (same id, still active)", async ({
    request,
  }) => {
    const created = await createTerminalSession(request, {
      cwd: projectPath,
      type: "shell",
      topicId,
    });
    try {
      const { status, body } = await reloadTerminalSession(request, created.id);
      expect(status).toBe(200);
      expect(body?.id).toBe(created.id);
      expect(body?.type).toBe("shell");
      // The session keeps its id and remains in the live roster after reload.
      const after = await listTerminalSessions(request, topicId);
      expect(after.some((s) => s.id === created.id)).toBe(true);
    } finally {
      await deleteTerminalSession(request, created.id);
    }
  });

  test("POST /reload on an unknown session returns 404", async ({ request }) => {
    const { status } = await reloadTerminalSession(
      request,
      `nope-${Date.now()}`
    );
    expect(status).toBe(404);
  });

  test("tab right-click shows 'Ricarica' for a terminal tab and reloading keeps the session", async ({
    page,
    terminalPage,
  }) => {
    await navigateAndOpenTerminal(page, terminalPage);

    // The terminal pane tab carries data-testid `pane-tab-terminal:<sessionId>`.
    const tab = page.locator('[data-testid^="pane-tab-terminal:"]').first();
    await tab.waitFor({ state: "visible", timeout: 15_000 });
    const testId = await tab.getAttribute("data-testid");
    const sessionId = (testId ?? "").replace("pane-tab-terminal:", "");
    expect(sessionId.length).toBeGreaterThan(0);

    // Right-click → the context menu shows "Ricarica" (only for terminal tabs).
    // Disambiguate from other "Ricarica"-named controls (e.g. a browser pane's
    // reload icon) via this item's unique title.
    await tab.click({ button: "right" });
    const ricarica = page.getByTitle(/^Riavvia la sessione/);
    await expect(ricarica).toBeVisible();

    // Clicking the item POSTs to the reload endpoint for THIS session and gets 200
    // (the server-side restart behavior itself is covered by the endpoint tests).
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/terminal/sessions/${sessionId}/reload`) &&
          r.request().method() === "POST",
        { timeout: 15_000 }
      ),
      ricarica.click(),
    ]);
    expect(resp.status()).toBe(200);
  });

  test("'Ricarica' is NOT shown for a non-terminal (chat) tab", async ({
    page,
  }) => {
    await goToApp(page);
    await openTopic(page, topicName);
    // The chat pane tab carries data-testid `pane-tab-chat:<topicId>`.
    const chatTab = page.locator(`[data-testid="pane-tab-chat:${topicId}"]`);
    await chatTab.waitFor({ state: "visible", timeout: 10_000 });
    await chatTab.click({ button: "right" });
    // The menu opens (a known item is present) but the reload item is NOT.
    await expect(page.getByText("Close now")).toBeVisible();
    await expect(page.getByTitle(/^Riavvia la sessione/)).toHaveCount(0);
  });
});

/**
 * Open a shell terminal inside the project via the sidebar "Add to project" → "Shell".
 * Mirrors terminal.spec.ts; returns once xterm rows are visible.
 */
async function navigateAndOpenTerminal(page: Page, terminalPage: TerminalPage) {
  await goToApp(page);

  const projectsSection = page.getByRole("button", { name: /Projects section/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }

  const projectHeader = page.locator(`button[title="${"/tmp"}"]`);
  await projectHeader.waitFor({ state: "visible", timeout: 10_000 });
  await projectHeader.click();

  const xtermAlreadyVisible = await terminalPage.xtermRows
    .first()
    .isVisible()
    .catch(() => false);
  if (xtermAlreadyVisible) {
    await terminalPage.waitForReady();
    return;
  }

  await projectHeader.hover();
  const addBtn = projectHeader
    .locator("..")
    .locator('button[title="Add to project"]');
  await addBtn.waitFor({ state: "visible", timeout: 5_000 });
  await addBtn.click();

  const shellBtn = page.getByRole("button", { name: "Shell", exact: true });
  await shellBtn.waitFor({ state: "visible", timeout: 5_000 });
  await shellBtn.click();

  await expect(terminalPage.xtermRows.first()).toBeVisible({ timeout: 15_000 });
  await terminalPage.waitForReady();
}
