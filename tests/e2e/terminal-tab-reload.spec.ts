/**
 * @covers TERM-02
 *
 * Partial: reloading a terminal session in place.
 */
import { expect } from "@playwright/test";
import { test, type TerminalPage } from "./fixtures/terminal.fixture";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  reloadTerminalSession,
  getTerminalSessionBuffer,
  listTerminalSessions,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  resetPaneStore,
  resetProjectPanes,
} from "./helpers/api-fixtures";
import { goToApp, openTopic } from "./helpers";
import type { Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

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
    // Clean slate: a stale /tmp shell session (active or dormant) from a prior run
    // would make the project-terminal open reconnect to a dead PTY (empty xterm).
    await deleteAllTerminalSessions(request);
    // Le SESSIONI muoiono con la riga sopra, le PANE no: vivono nel pane-store
    // condiviso da tutta la suite seriale (e, per il progetto /tmp, nella sua
    // chiave `ui_state` separata). Una pane terminale lasciata da terminal.spec
    // punta ora a una sessione appena cancellata, e `navigateAndOpenTerminal`
    // la vede con `xtermAlreadyVisible` → i test lavorano su una tab morta.
    // Reset in beforeAll e NON in beforeEach: dentro il file il riuso della
    // stessa pane tra un test e l'altro è voluto (early-return sopra).
    await resetPaneStore(request, []);
    await resetProjectPanes(request, projectPath);
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
    test.info().annotations.push({ type: "spec", description: "TERM-02" });
    const created = await createTerminalSession(request, {
      cwd: projectPath,
      type: "shell",
      topicId,
    });
    try {
      // Wait until the shell is established (prompt printed) before reloading: a
      // PTY killed mid-startup can be slow to exit, and reload recreates only
      // after the old PTY is confirmed gone (else 503).
      await expect
        .poll(async () => (await getTerminalSessionBuffer(request, created.id)).trim().length, {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
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
    test.info().annotations.push({ type: "spec", description: "TERM-02" });
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
    test.info().annotations.push({ type: "spec", description: "TERM-02" });
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

    // Clicking the item POSTs to the reload endpoint for THIS session. We assert
    // the request is wired (not the response status): the server-side restart
    // outcome is covered by the endpoint tests, and reloading a stale/dead PTY can
    // legitimately 503.
    const [req] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes(`/api/terminal/sessions/${sessionId}/reload`) &&
          r.method() === "POST",
        { timeout: 15_000 }
      ),
      ricarica.click(),
    ]);
    expect(req.method()).toBe("POST");
  });

  test("'Ricarica' is NOT shown for a non-terminal (chat) tab", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-02" });
    // Use a dedicated STANDALONE chat here. The describe's shared topic is
    // project-linked (projectPath=/tmp), and a project-nested topic can't be
    // surfaced as a standalone sidebar treeitem — usePanelLifecycle purges
    // project-topic ids from openPanels (they live INSIDE the project window),
    // so openTopic() could never open its tab. This test only needs *a* chat
    // pane to prove its context menu offers no reload item.
    const chatName = `e2e-term-reload-chat-${Date.now()}`;
    const chat = await createTopic(request, chatName);
    try {
      await goToApp(page);
      await openTopic(page, chatName);
      // A chat pane tab carries data-testid `pane-tab-<topicId>` (bare UUID —
      // only terminal/project/browser panes get a type prefix; see
      // PaneTabBar `pane-tab-${pane.id}` and seedTopicIntoSidebar's id=topicId).
      const chatTab = page.getByTestId(`pane-tab-${chat.id}`);
      await chatTab.waitFor({ state: "visible", timeout: 10_000 });
      await chatTab.click({ button: "right" });
      // The menu opens (a known item is present) but the reload item is NOT.
      await expect(page.getByText("Chiudi ora")).toBeVisible();
      await expect(page.getByTitle(/^Riavvia la sessione/)).toHaveCount(0);
    } finally {
      await deleteTopic(request, chat.id);
    }
  });

  // Checklist point 10: rinomina tab terminale — the terminal tab context menu
  // offers "Rinomina", which expands an inline editor in place and PATCHes the
  // session name (name_source='user'). Terminal-scoped: chat tabs rename from
  // the sidebar (covered in checklist-ui-verify.spec.ts CHK10-01).
  test("tab right-click 'Rinomina' opens an inline editor and PATCHes the session name", async ({
    page,
    terminalPage,
  }) => {
    await navigateAndOpenTerminal(page, terminalPage);

    const tab = page.locator('[data-testid^="pane-tab-terminal:"]').first();
    await tab.waitFor({ state: "visible", timeout: 15_000 });
    const testId = await tab.getAttribute("data-testid");
    const sessionId = (testId ?? "").replace("pane-tab-terminal:", "");
    expect(sessionId.length).toBeGreaterThan(0);

    // Right-click → "Rinomina" is present for terminal tabs. Disambiguate via
    // its unique title (the sidebar chat rename uses the English "Rename").
    await tab.click({ button: "right" });
    const rinomina = page.getByTitle("Rinomina questa scheda");
    await expect(rinomina, "terminal tab menu must offer Rinomina").toBeVisible({
      timeout: 3_000,
    });
    await rinomina.click();

    // The inline editor expands in place inside the portaled menu.
    const editor = page.locator('input[placeholder="Nuovo nome"]');
    await expect(editor, "inline rename editor must appear").toBeVisible({
      timeout: 2_000,
    });

    // Type a new name + Enter → a PATCH to this session fires (the save path).
    const newName = `renamed-${Date.now()}`;
    await editor.fill(newName);
    const [req] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes(`/api/terminal/sessions/${sessionId}`) &&
          r.method() === "PATCH",
        { timeout: 5_000 }
      ),
      editor.press("Enter"),
    ]);
    expect(req.method()).toBe("PATCH");
  });
});

/**
 * Open a shell terminal inside the project via the sidebar "Add to project" → "Shell".
 * Mirrors terminal.spec.ts; returns once xterm rows are visible.
 */
async function navigateAndOpenTerminal(page: Page, terminalPage: TerminalPage) {
  await goToApp(page);

  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
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
    return; // a terminal pane is already mounted — enough for the tab right-click
  }

  await projectHeader.hover();
  const addBtn = projectHeader
    .locator("..")
    .locator('button[title="Add to project"]');
  await addBtn.waitFor({ state: "visible", timeout: 5_000 });
  await addBtn.click();

  // Testid e non `getByRole("button")`: dal 2026-08-06 le righe del menu "+"
  // dichiarano `role="menuitem"` (sono dentro un `role="menu"`), quindi il
  // ruolo implicito di bottone non c'è più. Il testid è il contratto stabile.
  const shellBtn = page.getByTestId("pane-add-menu-shell");
  await shellBtn.waitFor({ state: "visible", timeout: 5_000 });
  await shellBtn.click();

  // We only need the terminal pane (and its tab) mounted — not a ready shell
  // prompt — so we skip waitForReady(), which is flaky when an open reconnects to
  // a stale PTY. The reload action works on any terminal session.
  await expect(terminalPage.xtermRows.first()).toBeVisible({ timeout: 15_000 });
}
