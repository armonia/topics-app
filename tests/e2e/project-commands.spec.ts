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
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
// Must agree with the server's WORKSPACE_DIR (server/routes/topics.ts —
// `join(OPENCLAW_DIR, "workspace")`). global-setup.ts propagates OPENCLAW_DIR
// to this runner process so both sides resolve the same isolated path.
const WORKSPACE_DIR = join(
  process.env.OPENCLAW_DIR || join(process.env.HOME || "/tmp", ".openclaw"),
  "workspace"
);

/** Apre la topic dalla sidebar, se ci compare. `true` se ci è riuscita. */
async function openTopicFromSidebar(
  page: import("@playwright/test").Page,
  name: string | RegExp,
  projectName?: string,
): Promise<boolean> {
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
    // Try expanding sezione Chat
    const chatsBtn = page.getByRole("button", { name: "sezione Chat" });
    if (await chatsBtn.isVisible().catch(() => false)) {
      await chatsBtn.click().catch(() => {});
      await page.getByRole("treeitem").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    }
    found = await item.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  }

  if (!found) return false;
  await item.click();
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
  return true;
}

/**
 * Apre la topic dalla palette ⌘K. `true` se ci è riuscita.
 *
 * È la strada di una topic LEGATA a un progetto: viene assorbita nella finestra
 * del progetto e non compare più come treeitem a sé. `buildSidebarItems` elenca
 * la chat figlia di un progetto solo se ha una tab interna APERTA (o una
 * notifica, o è pinnata), e il layout interno del progetto sta in localStorage —
 * che NON sopravvive a un contesto Playwright nuovo (ogni test ne riceve uno, e
 * al reload la finestra del progetto torna con "No chats open").
 *
 * La palette invece funziona sempre: `onOpenTopic` → `handleTopicClick` apre la
 * finestra del progetto E ci mette a fuoco dentro la chat di questa topic
 * (usePanelLifecycle.ts — setPendingProjectFocus).
 */
async function openTopicFromPalette(
  page: import("@playwright/test").Page,
  name: string | RegExp,
): Promise<boolean> {
  await page.keyboard.press("Meta+k");
  const overlay = page.locator('[data-testid="command-palette"]');
  const opened = await overlay.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  if (!opened) return false;

  const query = typeof name === "string" ? name : name.source;
  await overlay.getByRole("textbox").fill(query);
  const option = overlay.getByRole("option", { name }).first();
  const hasOption = await option.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  if (!hasOption) {
    await page.keyboard.press("Escape");
    return false;
  }
  await option.click();
  await overlay.waitFor({ state: "hidden", timeout: 5000 });
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
  return true;
}

/**
 * Apre una topic ovunque si trovi, scegliendo la strada in base a COM'È FATTA.
 *
 * Prima questa funzione provava sempre la sidebar e teneva la palette come
 * ripiego: tre sonde in cascata da 3+5+5 secondi, poi ⌘K. Per una topic legata a
 * un progetto quelle tre sonde sono destinate a fallire — lo spiega il commento
 * di `openTopicFromPalette`, ed è la ragione per cui il ripiego esiste — quindi
 * erano TREDICI SECONDI spesi a dimostrare una cosa che il codice sapeva già.
 * Costavano 14,6s a testa ad AC-2 e AC-6b, i due test più lenti dell'intera
 * suite dopo FILE-17.
 *
 * Ora il caso noto va per la sua strada: `projectName` presente significa
 * "questa topic è legata a un progetto" — si passa dalla palette. L'altra strada
 * resta come ripiego in entrambi i versi, così nessuno dei due casi perde
 * copertura se la UI cambia.
 */
async function openTopicAnywhere(
  page: import("@playwright/test").Page,
  name: string | RegExp,
  projectName?: string
) {
  if (projectName) {
    if (await openTopicFromPalette(page, name)) return;
    if (await openTopicFromSidebar(page, name, projectName)) return;
  } else {
    if (await openTopicFromSidebar(page, name)) return;
    if (await openTopicFromPalette(page, name)) return;
  }
  throw new Error(
    `openTopicAnywhere: la topic ${name} non si apre ne' dalla sidebar ne' dalla palette` +
      (projectName ? ` (progetto: ${projectName})` : ""),
  );
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

  // `sendCommand` prende il composer con un locator STRICT: una sola pane chat
  // superstite di un file precedente (il pane-store è unico per tutta la suite
  // seriale) lo fa risolvere a 2 elementi e affonda il file intero. Reset al
  // solo topic seminato dal beforeAll — che serve, perché `openTopicAnywhere`
  // lo cerca nella sidebar, dove compare solo se ha un tab aperto.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("PROJCMD-7: /project appears in slash command autocomplete", async ({ page }) => {
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

  test("PROJCMD-5: /project open with nonexistent path shows error", async ({ page }) => {
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

  test("PROJCMD-6: /project with no args shows list when no project bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName));

    await sendCommand(page, "/project");

    // Result renders in the command-result banner (regex = substring match over
    // the whitespace-pre-wrapped banner text), not a `.message-content` message.
    const infoMsg = page.getByText(/No project bound/i).first();
    await expect(infoMsg).toBeVisible({ timeout: 10_000 });
  });

  test("PROJCMD-1: /project create creates directory and binds to topic", async ({ page }) => {
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

  test("PROJCMD-2: /project create with existing name shows error", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, `/project create ${testProjectName}`);

    // 409 → error banner via errMessage(e) = server's `error` string.
    const errorMsg = page.getByText(/already exists/i).first();
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });
  });

  test("PROJCMD-6b: /project shows current project when bound", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopicAnywhere(page, new RegExp(topicName), testProjectName);

    await sendCommand(page, "/project");

    const currentMsg = page.getByText(/Current project/i).first();
    await expect(currentMsg).toBeVisible({ timeout: 10_000 });
  });

  test("PROJCMD-3: /project open binds existing project by name", async ({ page, request }) => {
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

  test("PROJCMD-4: /project open binds by absolute path", async ({ page, request }) => {
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
