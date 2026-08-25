/**
 * Cloud session → Topics project (client render behaviour).
 *
 * When a session binds itself to a project — via the `open_project` /
 * `create_project` control tool (MCP for claude-code/codex, SDK passthrough for
 * claude/openai; both hit `POST /api/sessions/:sessionKey/{open,create}-project`),
 * the `/project` command, or auto-detect — the server runs
 * `bindTopicToProject(topicId, dir, { focus: true })`, which persists projectPath
 * (topic:updated) AND emits `pane:focus-suggest` carrying the projectPath inline.
 * The client must then open that project's window and nest the session inside it,
 * so the session appears scoped to its project (à la Warp). This locks that
 * client behaviour, independent of WHICH surface triggered the bind.
 *
 * (Historical note: the trigger used to be the `{{PROJECT_OPEN:name}}` text
 * marker, retired in the replace-markers-with-tools change. The client contract
 * asserted here — the two broadcasts below — is unchanged, so this test ports
 * over verbatim: it drives the SAME frames the tool/endpoint now emits.)
 *
 * Real backend via interceptWebSocket passthrough; the two frames are injected
 * exactly as bindTopicToProject emits them. No waitForTimeout.
 *
 * @covers PROJECT-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("cloud session opens as a Topics project", () => {
  test("topic:updated + pane:focus-suggest open the project window and nest the session", async ({
    page,
    request,
  }) => {
    const ts = Date.now().toString(36);
    const projectPath = `/tmp/e2e-cloud-proj-${ts}`;
    const projectPaneId = `project:${encodeURIComponent(projectPath)}`;

    // Own the (single, server-synced) pane channel with a clean baseline before
    // seeding/navigating — otherwise a concurrent worker's higher-server_seq PUT
    // HYDRATE-clobbers the project pane this test injects via the WS frames below.
    // Reset BEFORE createTopic so createTopic re-seeds the topic (keeps it visible).
    await resetPaneStore(request, []);

    // A standalone cloud session, not yet scoped to a project.
    const topic = await createTopic(request, `E2E-CloudSession-${ts}`);

    const ws = await interceptWebSocket(page, /\/ws/);
    await goToApp(page);
    // Standalone session is rendered (and the WS is connected, so ws.send is safe).
    await waitForTopicVisible(page, topic.id);

    // Precondition: this project's window is not open yet.
    await expect(page.locator(`[data-pane-id="${projectPaneId}"]`)).toHaveCount(0);

    // Exactly what bindTopicToProject(topicId, dir, { focus: true }) broadcasts:
    // (1) persist projectPath on the topic, (2) ask clients to open + nest it.
    ws.send({
      type: "topic:updated",
      topic: { id: topic.id, name: topic.name, slug: topic.slug, projectPath, provider: "openclaw", archived: false },
    });
    ws.send({ type: "pane:focus-suggest", topicId: topic.id, projectPath });

    // The project window opens...
    await expect(page.locator(`[data-pane-id="${projectPaneId}"]`).first()).toBeVisible({
      timeout: 10000,
    });
    // ...the session nests under that project in the sidebar (and is selected)...
    await expect(
      page.getByRole("treeitem", { name: topic.name }).first(),
    ).toBeVisible({ timeout: 10000 });
    // ...and renders as an interactive chat inside the project window.
    await expect(
      page.getByRole("textbox", { name: /Message input/ }),
    ).toBeVisible({ timeout: 10000 });

    await deleteTopic(request, topic.id);
  });

  test("an openclaw-backed (cloud) topic shows a Cloud indicator", async ({ page, request }) => {
    const ts = Date.now().toString(36);
    const topic = await createTopic(request, `E2E-Cloud-Badge-${ts}`, { provider: "openclaw" });

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);

    // The cloud (OpenClaw) attribute glyph (sidebar row and/or tab) is labelled.
    await expect(page.getByLabel("Sessione cloud (OpenClaw)").first()).toBeVisible({
      timeout: 10000,
    });

    await deleteTopic(request, topic.id);
  });
});
