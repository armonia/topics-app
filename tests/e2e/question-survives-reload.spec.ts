import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A QUESTION WAITS FOR ITS PERSON, across a reload and across the death of the
 * process that asked it (29/09: "sembra possa scadere. Non ha senso").
 *
 * Two ways the answer reaches the model, both driven through the real server:
 *
 *   - the asker is still there (the bridge is polling, as a live CLI child
 *     does): reload, the panel is still there, the answer comes back as the
 *     tool's result on the bridge's next leg;
 *   - the asker is gone (the server restarted under a native turn, the child
 *     died): reload, the panel is still there and says the turn stopped, and
 *     the answer reaches the model as the next user message with the question
 *     quoted. The model here is the bench's `claude` stub, which answers "ok".
 *
 * A behaviour: the video is the proof.
 *
 * @covers ASK-11
 */
test.use({ video: "on" });

const BASE = E2E_BASE;

test.describe.serial("a question survives a reload", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  test.beforeAll(async ({ request }) => {
    topicName = `question-reload-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "the topic has a session key").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /** The turn that asked: the row as the stream (or the boot) leaves it. */
  async function seedQuestion(request: APIRequestContext, toolCallId: string, question: string, opts: { askerGone?: boolean } = {}) {
    const questions = [{ question, header: "Choice", options: [{ label: "Alpha" }, { label: "Beta" }], multiSelect: false }];
    await seedMessage(request, { sessionKey, role: "user", content: "help me pick one" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "I need your choice:",
      toolCalls: [{
        id: toolCallId,
        name: "mcp__topics__ask_user_question",
        args: { questions },
        status: "waiting_for_input",
        startedAt: Date.now() - 5_000,
        userInputSchema: { kind: "questions", questions },
        ...(opts.askerGone ? { askerGone: true } : {}),
      }],
    });
    return questions;
  }

  async function openChat(page: import("@playwright/test").Page, chatPage: { messageInput: import("@playwright/test").Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  test("asker alive: reload, the panel is still there, the answer is the tool's result", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_reload_live";
    const question = "Which one ships first?";
    const questions = await seedQuestion(request, toolCallId, question);

    // The bridge of a live CLI child: short legs, straight back on `pending`.
    let stop = false;
    const bridge = (async () => {
      for (let legs = 1; legs <= 400 && !stop; legs++) {
        const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, {
          data: { questions, legMs: 800 }, ignoreHTTPSErrors: true, timeout: 60_000,
        });
        const body = (await r.json()) as { answers?: Record<string, string>; pending?: boolean; cancelled?: boolean };
        if (!body.pending) return body;
      }
      return { cancelled: true };
    })();

    try {
      await openChat(page, chatPage);
      const form = page.getByTestId(`tool-input-form-${toolCallId}`);
      await expect(form).toBeVisible({ timeout: 15_000 });

      await page.reload();
      await openChat(page, chatPage);
      await expect(form, "the panel survives the reload").toBeVisible({ timeout: 15_000 });

      const choice = form.locator('input[type="radio"][value="Beta"]');
      await choice.check();
      await expect(choice).toBeChecked();
      await form.getByRole("button", { name: /Invia|Send/ }).click();

      // The model's side: the bridge's leg returns exactly the choice.
      const result = await bridge;
      expect(result.cancelled).toBeFalsy();
      expect(result.answers).toEqual({ [question]: "Beta" });
      await expect(form).toBeHidden({ timeout: 10_000 });
    } finally {
      stop = true;
    }
  });

  test("asker gone: reload, the panel is still there, the answer reaches the model as the next message", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_reload_gone";
    const question = "Which road do we take?";
    await seedQuestion(request, toolCallId, question, { askerGone: true });

    await openChat(page, chatPage);
    const form = page.getByTestId(`tool-input-form-${toolCallId}`);
    await expect(form).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await openChat(page, chatPage);
    await expect(form, "the panel survives the reload").toBeVisible({ timeout: 15_000 });
    // It says why the answer will travel as a message.
    await expect(page.getByTestId(`question-asker-gone-${toolCallId}`)).toBeVisible();

    const choice = form.locator('input[type="radio"][value="Alpha"]');
    await choice.check();
    await expect(choice).toBeChecked();
    await form.getByRole("button", { name: /Invia|Send/ }).click();

    // On screen: the question closes as answered, and the answer goes out as a
    // message quoting it.
    await expect(form).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText("Answer to the question you asked earlier", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    // The model's side: the message it was sent carries the question and the
    // choice, and the model (the bench's stub) answered it.
    await expect.poll(async () => {
      const res = await request.get(`${BASE}/api/history/${encodeURIComponent(sessionKey)}`, { ignoreHTTPSErrors: true });
      const messages = ((await res.json()) as { messages: Array<{ role: string; content: string }> }).messages;
      const at = messages.findIndex((m) => m.role === "user" && m.content.includes(`> ${question}`) && m.content.includes("Alpha"));
      return at >= 0 && messages.slice(at + 1).some((m) => m.role === "assistant" && m.content.trim().length > 0);
    }, { message: "the late answer reached the model and it replied", timeout: 30_000 }).toBe(true);
  });
});
