import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Slice 5 verification — per-topic model persistence + cross-window sync.
 *
 * Goal: closing and reopening a topic remembers the model. Two windows on
 * the same topic stay aligned without polling. The picker becomes a thin
 * reflection of `topic.provider` + `topic.model`; updates flow over the
 * existing `topic:updated` broadcast.
 *
 * @covers CHAT-DEF-03
 */
test.describe.serial("Topic model persistence + cross-window sync", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Model Persist " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Il picker è per-pane e i test qui lo leggono senza scoping: le pane
  // lasciate aperte dai file precedenti (pane-store unico per la suite) lo
  // renderebbero ambiguo. Reset al solo topic seminato dal beforeAll.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("PATCH /api/topics/:id accepts model + round-trips through GET", async ({ request }) => {
    const set = await request.patch(`/api/topics/${topicId}`, {
      data: { provider: "codex", model: "gpt-5.5" },
    });
    expect(set.ok()).toBeTruthy();
    const setBody = await set.json();
    expect(setBody.provider).toBe("codex");
    expect(setBody.model).toBe("gpt-5.5");

    // Read back via the list endpoint to confirm DB persistence.
    const all = await request.get("/api/topics");
    expect(all.ok()).toBeTruthy();
    const data = await all.json();
    expect(data.topics[topicId].provider).toBe("codex");
    expect(data.topics[topicId].model).toBe("gpt-5.5");

    // Clear it.
    const cleared = await request.patch(`/api/topics/${topicId}`, {
      data: { provider: null, model: null },
    });
    expect(cleared.ok()).toBeTruthy();
    const clearedBody = await cleared.json();
    expect(clearedBody.provider).toBeNull();
    expect(clearedBody.model).toBeNull();
  });

  test("picker survives a page refresh", async ({ page, request }) => {
    // Pre-seed the topic with a provider+model via API. The picker should
    // render that selection on first paint without any user interaction.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: "codex", model: "gpt-5.4" },
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const picker = page.getByTestId("provider-model-picker");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await expect(picker).toContainText("gpt-5.4", { timeout: 5_000 });

    // Hard reload — picker should still show the persisted model on next
    // paint (sourced from `topic.model` via the snapshot/topic broadcast).
    await page.reload();
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const picker2 = page.getByTestId("provider-model-picker");
    await picker2.waitFor({ state: "visible", timeout: 10_000 });
    await expect(picker2).toContainText("gpt-5.4", { timeout: 5_000 });
  });

  test("cross-window: PATCH from window A updates window B without refresh", async ({ browser, request }) => {
    // Reset to a known starting point.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: "codex", model: "gpt-5.4" },
    });

    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await goToApp(pageA);
    await pageA.keyboard.press("Escape");
    await openTopic(pageA, new RegExp(topicName));
    await goToApp(pageB);
    await pageB.keyboard.press("Escape");
    await openTopic(pageB, new RegExp(topicName));

    const pickerA = pageA.getByTestId("provider-model-picker");
    const pickerB = pageB.getByTestId("provider-model-picker");
    await pickerA.waitFor({ state: "visible", timeout: 10_000 });
    await pickerB.waitFor({ state: "visible", timeout: 10_000 });
    await expect(pickerA).toContainText("gpt-5.4", { timeout: 5_000 });
    await expect(pickerB).toContainText("gpt-5.4", { timeout: 5_000 });

    // Simulate "user clicks a model in window A" via the same PATCH the
    // picker's onChange wrapper performs. Both windows must update via the
    // existing `topic:updated` WS broadcast.
    await request.patch(`/api/topics/${topicId}`, {
      data: { provider: "codex", model: "gpt-5.4-mini" },
    });

    await expect(pickerA).toContainText("gpt-5.4-mini", { timeout: 5_000 });
    await expect(pickerB).toContainText("gpt-5.4-mini", { timeout: 5_000 });

    await ctxA.close();
    await ctxB.close();
  });
});
