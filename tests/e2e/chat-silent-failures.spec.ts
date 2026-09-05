import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file restarts from the globalSetup baseline, not from
// the state the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

/**
 * FOUR CHAT ACTIONS THAT USED TO FAIL IN SILENCE.
 *
 * Each scenario breaks ONE route and looks at the screen. Before this round the
 * screen was identical to a success: `catch {}`, `console.warn`, or a `void` on
 * a promise nobody watched. The toast is the only proof that counts, and what is
 * read inside it is the server's own sentence ("boom"), not a copy of ours: that
 * way the assertion does not freeze a piece of interface copy.
 *
 * On the goal rename the proof is double: the toast AND the edit field still
 * open with the typed text. Closing it before the answer put the OLD title back
 * on screen, which is exactly how a success looks, and the text just typed was
 * gone.
 *
 * @covers CHAT-FAIL-01
 */
test.describe("Errori silenziosi nelle azioni della chat", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `silent-fail-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${topicId.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `chatPage.messageInput` is STRICT (no `.first()`): one chat pane left open by
  // another spec is enough to fail this whole file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function openChat(page: Page, chatPage: { messageInput: Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** The error toast on screen, carrying the text the server really sent. */
  function errorToast(page: Page) {
    return page.getByTestId("toast").filter({ hasText: "boom" });
  }

  test("«Remember this» rifiutato lo dice invece di disegnare un successo", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "una risposta da ricordare",
    });

    await openChat(page, chatPage);
    const bubble = page.getByTestId("chat-message").filter({ hasText: "una risposta da ricordare" });
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/memory/*/append", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    // The action bar shows up on bubble hover.
    await bubble.hover();
    await bubble.getByRole("button", { name: "Save to memory" }).click();

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
  });

  test("la rinomina dell'obiettivo che fallisce tiene il campo aperto col testo digitato", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await request.put(`/api/topics/${topicId}/goal`, { data: { content: "Obiettivo di partenza" } });

    await openChat(page, chatPage);
    const bar = page.getByTestId("goal-bar");
    await expect(bar).toContainText("Obiettivo di partenza", { timeout: 15_000 });

    // The WRITE only: the goal GET has to keep answering, otherwise the bar
    // disappears and the test would be proving something else.
    await page.route("**/api/topics/*/goal", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });

    await bar.getByTestId("goal-edit").click();
    const field = page.getByTestId("goal-bar-edit").getByRole("textbox");
    await expect(field).toBeVisible();
    await field.fill("Obiettivo riscritto");
    await field.press("Enter");

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
    // The field is still there, holding what the person typed: not the old title,
    // which would be indistinguishable from a write that went through.
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("Obiettivo riscritto");

    const stored = await (await request.get(`/api/topics/${topicId}/goal`)).json();
    expect(stored.goal?.content).toBe("Obiettivo di partenza");
  });

  test("la pastiglia di contesto che non si spegne lo dice, e resta accesa", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await patchTopic(request, topicId, { contextFiles: [`${process.cwd()}/package.json`] });

    await openChat(page, chatPage);
    const pill = page.getByTestId("context-pill").filter({ hasText: "package.json" });
    await expect(pill).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/topics/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });

    await pill.click();

    await expect(errorToast(page)).toBeVisible({ timeout: 10_000 });
    // No optimistic update: the file is still in the context, and the pill says so
    // by staying lit.
    await expect(pill).not.toHaveAttribute("title", /excluded/);
  });

  test("un'immagine illeggibile non porta via le altre e viene nominata", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FAIL-01" });
    await openChat(page, chatPage);

    // A real 1x1 PNG and a handful of bytes no decoder accepts: `img.onerror`
    // fires on the second one, and it used to take the first one with it, along
    // with the composer's text.
    const readable =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.evaluate((pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "buona.png", { type: "image/png" }));
      data.items.add(new File([new Uint8Array([1, 2, 3, 4])], "rotta.png", { type: "image/png" }));
      const target = document.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Message input"]');
      target?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, readable);

    // The readable one made it into the composer.
    await expect(page.getByTestId("composer-attachment")).toHaveCount(1, { timeout: 10_000 });
    // And the dropped one has a name: without it the only sign was one preview
    // fewer.
    await expect(page.getByTestId("toast").filter({ hasText: "rotta.png" })).toBeVisible({ timeout: 10_000 });
  });
});
