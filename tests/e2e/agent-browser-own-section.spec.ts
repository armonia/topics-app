/**
 * AN AGENT'S BROWSER STAYS IN THE AGENT'S SECTION (10/11).
 *
 * Asked by Attilio on 10/11: after agent chats left the tab bar (#721), the
 * browser those agents opened still mounted in his workspace (a pane in the
 * layout, or a forced window). Now a chat an agent opened (here a Jarvis
 * channel chat, i.e. a topic under a root via `parentId`) loads its page on
 * its own context and puts nothing on his screen; a chat he opened behaves as
 * before.
 *
 * Driven through the agent's real door (`POST …/browser/open-pane`).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
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

async function openPane(request: APIRequestContext, topicId: string, label: string) {
  const res = await request.post(`${BASE}/api/topics/${encodeURIComponent(topicId)}/browser/open-pane`, {
    data: { url: URL_OF(label) },
    ignoreHTTPSErrors: true,
    timeout: 45_000,
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { contextId?: string; visible?: boolean; url?: string };
}

test.describe("agent browsers live in the agent's section", () => {
  test.describe.configure({ timeout: 90_000 });

  let mineId = "";
  let agentId = "";

  test.beforeAll(async ({ request }) => {
    mineId = (await createTopic(request, `E2E-Mine-${Date.now()}`)).id;
    // A Jarvis channel chat: a topic Jarvis opened under one of its roots.
    agentId = (await createTopic(request, `E2E-Agent-${Date.now()}`, { parentId: mineId })).id;
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
    if (agentId) await deleteTopic(request, agentId);
    if (mineId) await deleteTopic(request, mineId);
  });

  test("agent's open: page alive, zero panes, zero windows; Attilio's open: pane as before", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-CHAT-AGENT-01" });
    await resetPaneStore(request, [mineId]);
    await goToApp(page);
    await waitForTopicVisible(page, mineId, { timeout: 15_000 });
    await page.locator(`[data-pane-id="${mineId}"], [data-topic-id="${mineId}"]`).first().click();
    await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15_000 });
    await beat(page, 800);

    const forced: unknown[] = [];
    page.on("websocket", (ws) => ws.on("framereceived", (f) => {
      const s = typeof f.payload === "string" ? f.payload : "";
      if (s.includes('"browser:force-open"')) forced.push(s);
    }));

    const agent = await openPane(request, agentId, "Agente");
    expect(agent.contextId).toBe(agentId);
    expect(agent.visible, "nothing on Attilio's screen").toBe(false);
    await beat(page, 2500);
    await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(0);
    expect(forced, "no forced window").toEqual([]);

    const mine = await openPane(request, mineId, "Mia");
    expect(mine.visible).toBe(true);
    await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(1, { timeout: 20_000 });
    await beat(page, 2500);
  });
});
