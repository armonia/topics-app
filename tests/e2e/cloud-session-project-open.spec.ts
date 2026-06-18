/**
 * Cloud session → Topics project.
 *
 * When a cloud (gateway) session binds itself to a project — via the
 * {{PROJECT_OPEN:name}} marker, the /project command, or auto-detect — the
 * server runs `bindTopicToProject(topicId, dir, { focus: true })`, which
 * persists projectPath (topic:updated) AND emits `pane:focus-suggest` carrying
 * the projectPath inline. The client must then open that project's window and
 * nest the session inside it, so the cloud session appears scoped to its
 * project (à la Warp). This locks that client behaviour.
 *
 * CONVENTION: real backend via interceptWebSocket passthrough; the focus-suggest
 * is injected exactly as the server emits it. No waitForTimeout.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";

test.describe("cloud session opens as a Topics project", () => {
  test("pane:focus-suggest with an inline projectPath opens the project window and nests the session", async ({
    page,
    request,
  }) => {
    const projectPath = `/tmp/e2e-cloud-proj-${Date.now().toString(36)}`;
    const projectPaneId = `project:${encodeURIComponent(projectPath)}`;

    // A cloud session already bound to a project (mirrors the server having set
    // projectPath inside bindTopicToProject before it emits focus-suggest).
    const topic = await createTopic(request, `E2E-CloudSession-${Date.now()}`, {
      projectPath,
    });

    const ws = await interceptWebSocket(page, /\/ws/);
    await goToApp(page);
    // Session is rendered (and the WS is connected, so ws.send is safe).
    await waitForTopicVisible(page, topic.id);

    // Precondition: the project window is not open yet.
    await expect(page.locator(`[data-pane-id="${projectPaneId}"]`)).toHaveCount(0);

    // The server emits this when the session opens/binds a project.
    ws.send({ type: "pane:focus-suggest", topicId: topic.id, projectPath });

    // The project window opens...
    await expect(page.locator(`[data-pane-id="${projectPaneId}"]`).first()).toBeVisible({
      timeout: 10000,
    });
    // ...and the session is nested inside it (its name shows in a project tab bar).
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').getByText(topic.name).first(),
    ).toBeVisible({ timeout: 10000 });

    await deleteTopic(request, topic.id);
  });
});
