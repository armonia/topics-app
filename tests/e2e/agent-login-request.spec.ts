import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE, daemonAuthHeaders } from "./helpers/test-server";
import { createTopic, deleteTopic, waitForTopicVisible, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// request_login on a 1440 px window: the login tab opens, the topic pops out
// into a detached window above the main one, and the history gets a notice
// that links to the topic. The clip is the proof of the window appearing.
test.use({ viewport: { width: 1440, height: 900 }, video: { mode: "on", size: { width: 1440, height: 900 } } });

test("request_login raises a detached window and records a linked notice", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "BROWSER-LOGIN-01" });
  const topic = await createTopic(request, "Login request");
  try {
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);

    const loginWindow = page.waitForEvent("popup");
    const opened = await request.post(`${E2E_BASE}/api/topics/${topic.id}/browser/open-pane`, {
      data: { url: "https://example.com/login", name: "Login" },
      ignoreHTTPSErrors: true,
    });
    expect(opened.ok()).toBeTruthy();
    const { contextId } = (await opened.json()) as { contextId: string };

    // focus-pane is an agent route: it answers 401 without the daemon token,
    // which is what request_login sends.
    const focused = await request.post(`${E2E_BASE}/api/topics/${topic.id}/browser/focus-pane`, {
      data: { contextId, loginRequest: true, detached: true },
      headers: daemonAuthHeaders(),
      ignoreHTTPSErrors: true,
    });
    expect(focused.ok()).toBeTruthy();

    // Detached window: a second page that carries this topic.
    expect((await loginWindow).url()).toContain(`topics=${topic.id}`);

    // Notice: one history row, clickable to the topic.
    await expect.poll(async () => {
      const res = await request.get(`${E2E_BASE}/api/notifications?limit=20`, { ignoreHTTPSErrors: true });
      const { rows } = (await res.json()) as { rows: Array<{ title: string; targetId: string | null }> };
      return rows.some((r) => r.title.startsWith("Sign-in needed") && r.targetId === topic.id);
    }).toBe(true);
  } finally {
    await closeAllBrowserContexts(request);
    await deleteTopic(request, topic.id);
  }
});
