/**
 * A SPAWNED AGENT'S BROWSER OPENS IN THE WINDOW OF THE CHAT THAT SPAWNED IT.
 *
 * Seen on 2026-10-08 in a real chat: every `spawn_agent` child that called
 * `open_browser_pane` (the stay search, the train search) added a new
 * layout tab. A child runs in a topic of its own that is a tab nowhere, so no
 * surface claimed its `browser:navigate`, and the server's `browser:force-open`
 * fallback mounted a standalone pane per child. The `name` the agent passes
 * had nothing to do with it: a chat's opens always share one context.
 *
 * Driven through the agent's real door (`POST …/browser/open-pane`), with the
 * real parent link (a `subagents` row, as `spawn_agent` writes it).
 *
 * @covers GENUI-05
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  closeAllBrowserContexts,
  waitForTopicVisible,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { beat } from "./helpers/evidence";

hermetic(test);

const BASE = E2E_BASE;
const URL_OF = (label: string): string =>
  `data:text/html,<body style='margin:0;background:%23101418;color:%2360f0a0;font:700 48px system-ui;display:grid;place-items:center'>${label}</body>`;

/** Link `childId` to `parentId` the way `spawn_agent` does for a native child. */
function linkChild(parentId: string, childId: string): void {
  // The sqlite3 CLI, as the other specs do: CI's Node has no `node:sqlite`.
  const db = join(E2E_DATA_DIR, "topics.db");
  const q = (id: string) => `(SELECT session_key FROM topics WHERE id = '${id.replace(/'/g, "''")}')`;
  execFileSync("sqlite3", [
    db,
    `INSERT INTO subagents (id, parent_session_key, name, cwd, state, created_at, runtime, session_key)
     VALUES ('${childId.replace(/'/g, "''")}', ${q(parentId)}, 'child', '/tmp', 'stopped', '${new Date().toISOString()}', 'topics', ${q(childId)});`,
  ]);
}

async function openPane(request: APIRequestContext, topicId: string, label: string, name: string) {
  const res = await request.post(`${BASE}/api/topics/${encodeURIComponent(topicId)}/browser/open-pane`, {
    data: { url: URL_OF(label), name },
    ignoreHTTPSErrors: true,
    timeout: 45_000,
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { contextId?: string; visible?: boolean };
}

test.describe("GENUI-05 one browser window per chat", () => {
  test.describe.configure({ timeout: 90_000 });

  let parentId = "";
  let childId = "";

  test.beforeAll(async ({ request }) => {
    parentId = (await createTopic(request, `E2E-Parent-${Date.now()}`)).id;
    childId = (await createTopic(request, `E2E-Child-${Date.now()}`)).id;
    linkChild(parentId, childId);
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
    if (childId) await deleteTopic(request, childId);
    if (parentId) await deleteTopic(request, parentId);
  });

  test("the parent's two named opens and the child's open: one window, no layout tab", async ({ page, request }) => {
    await resetPaneStore(request, [parentId]);
    await goToApp(page);
    await waitForTopicVisible(page, parentId, { timeout: 15_000 });
    await page.locator(`[data-pane-id="${parentId}"], [data-topic-id="${parentId}"]`).first().click();
    await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15_000 });
    await beat(page, 800);

    // The parent opens twice under two names: still ONE sheet on its context.
    expect((await openPane(request, parentId, "Nautilus", "Nautilus")).contextId).toBe(parentId);
    expect((await openPane(request, parentId, "El Cid", "El Cid")).contextId).toBe(parentId);
    const windowEl = page.locator('[data-testid="topic-browser-window"]');
    await expect(windowEl).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(1, { timeout: 15_000 });
    await beat(page, 1200);

    // The child opens: its own context, shown as a second sheet of the SAME window.
    const child = await openPane(request, childId, "Terza opzione", "Terza opzione");
    expect(child.contextId).toBe(childId);
    expect(child.visible, "the child's page must be on screen, not only alive").toBe(true);
    await expect(
      page.locator(`[data-testid="topic-browser-tab"][data-context-id="${childId}"]`),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(2);

    // And the layout gained no browser tab at all (the defect: one per child).
    await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);
    await beat(page, 2500);
  });
});
