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
 * process that asked it (29/09: "it looks like it can expire. That makes no sense").
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
 * @covers ASK-11, ASK-12
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
  async function seedQuestion(
    request: APIRequestContext, toolCallId: string, question: string,
    opts: { askerGone?: boolean; answeredAndQueued?: string } = {},
  ) {
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
        status: opts.answeredAndQueued ? "success" : "waiting_for_input",
        startedAt: Date.now() - 5_000,
        userInputSchema: { kind: "questions", questions },
        ...(opts.askerGone ? { askerGone: true } : {}),
        ...(opts.answeredAndQueued ? {
          answerRelay: "queued",
          userResponse: { kind: "questions", answers: { [question]: opts.answeredAndQueued }, submittedAt: new Date().toISOString() },
        } : {}),
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

      // The choice stays on screen with its question, and the server kept it:
      // after a reload it comes back from the history, not from this tab.
      const recap = page.getByTestId(`question-answer-${toolCallId}`);
      await expect(page.getByTestId(`tool-call-row-${toolCallId}`)).toContainText(question);
      await expect(recap.getByTestId("question-answer-value")).toHaveText("Beta");
      await page.reload();
      await openChat(page, chatPage);
      await expect(recap.getByTestId("question-answer-value"), "the choice survives the reload").toHaveText("Beta", { timeout: 15_000 });
      await expect(form).toHaveCount(0);
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
    await expect(page.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-value")).toHaveText("Alpha");
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

  test("an answer queued behind a turn in flight says it is on its way, across a reload", async ({ page, chatPage, request }) => {
    // The row as the answer route leaves it when a machine turn holds the
    // session: answered, and queued for the model as the next message.
    const toolCallId = "toolu_reload_queued";
    await seedQuestion(request, toolCallId, "Which port do we open?", { askerGone: true, answeredAndQueued: "Beta" });

    await openChat(page, chatPage);
    const note = page.getByTestId(`question-answer-queued-${toolCallId}`);
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`tool-input-form-${toolCallId}`), "an answered panel takes no second click").toHaveCount(0);

    await page.reload();
    await openChat(page, chatPage);
    await expect(note, "the note survives the reload").toBeVisible({ timeout: 15_000 });
    // And it says WHAT was answered, not only that something was.
    await expect(page.getByTestId(`question-answer-${toolCallId}`).getByTestId("question-answer-value")).toHaveText("Beta");
  });

  test("an answered multi-select with free text reads right across a reload, closed and open", async ({ page, chatPage, request }) => {
    // The row as the answer route persists it: a multi-select where the person
    // ticked two options and wrote one of their own, with commas in it.
    const toolCallId = "toolu_reload_multi";
    const question = "Which checks do we run before the push?";
    const questions = [{
      question, header: "Checks", multiSelect: true,
      options: [{ label: "Lint" }, { label: "Typecheck (Recommended)" }, { label: "E2E" }],
    }];
    await seedMessage(request, { sessionKey, role: "user", content: "what do we run?" });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "Pick the checks:",
      toolCalls: [{
        id: toolCallId, name: "AskUserQuestion", args: { questions },
        status: "success", startedAt: Date.now() - 9_000, endedAt: Date.now() - 2_000,
        userInputSchema: { kind: "questions", questions },
        userResponse: {
          kind: "questions",
          answers: { [question]: "Lint, Typecheck (Recommended), the copy check, only on landing" },
          submittedAt: new Date().toISOString(),
        },
      }],
    });

    await openChat(page, chatPage);
    await page.reload();
    await openChat(page, chatPage);

    // Closed: one line, options as a list, the written text in quotes.
    const recap = page.getByTestId(`question-answer-${toolCallId}`);
    await expect(recap).toBeVisible({ timeout: 15_000 });
    await expect(recap.getByTestId("question-answer-value"))
      .toHaveText("Lint, Typecheck, «the copy check, only on landing»");

    // Open: every option offered, the chosen ones ticked, the free text too.
    const row = page.getByTestId(`tool-call-row-${toolCallId}`);
    await row.locator("button[aria-expanded]").first().click();
    const card = page.getByTestId(`question-answer-card-${toolCallId}`);
    await expect(card).toBeVisible();
    await expect(recap, "open, the card says it once").toBeHidden();
    const chosen = card.locator('[data-testid="question-answer-option"][data-chosen="true"]');
    await expect(chosen).toHaveText(["Lint", "Typecheck", "Altro: «the copy check, only on landing»"]);
    await expect(chosen.locator("svg")).toHaveCount(3);
    await expect(card.locator('[data-testid="question-answer-option"]:not([data-chosen])')).toHaveText(["E2E"]);
  });

  test("an answered question stays out of the folded turn: [tool, answered question, tool, text] after a reload", async ({ page, chatPage, request }) => {
    // The common shape (04/10): the agent asks mid-turn, works on and closes
    // with a text. The finished turn folds into «N actions», and the question
    // with its answer went into the fold with the rest.
    const askId = "toolu_fold_ask";
    const question = "Which database for the cache?";
    const questions = [{ question, header: "Database", multiSelect: false, options: [{ label: "SQLite" }, { label: "Redis" }] }];
    const now = Date.now();
    const read = { id: "toolu_fold_read", name: "Read", args: { file_path: "/tmp/fold/config.ts" }, status: "success" as const, result: "export {}", startedAt: now - 9_000, endedAt: now - 8_500 };
    const ask = {
      id: askId, name: "AskUserQuestion", args: { questions }, status: "success" as const, startedAt: now - 8_000, endedAt: now - 6_000,
      userInputSchema: { kind: "questions", questions },
      userResponse: { kind: "questions", answers: { [question]: "SQLite" }, submittedAt: new Date().toISOString() },
    };
    const bash = { id: "toolu_fold_bash", name: "Bash", args: { command: "bun test cache" }, status: "success" as const, result: "ok", startedAt: now - 5_000, endedAt: now - 4_000 };
    const answer = "Done: the cache now runs on SQLite.";
    await seedMessage(request, { sessionKey, role: "user", content: "set up the cache" });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: answer,
      toolCalls: [read, ask, bash],
      blocks: [{ kind: "tool", toolCall: read }, { kind: "tool", toolCall: ask }, { kind: "tool", toolCall: bash }, { kind: "text", text: answer }],
    });

    await openChat(page, chatPage);
    await page.reload();
    await openChat(page, chatPage);

    // The work still folds, counted without the question; the question and
    // its answer stay in sight, above the closing text.
    const bubble = page.getByTestId("message-content-assistant").filter({ hasText: answer }).last();
    const fold = bubble.getByTestId("turn-work-fold");
    await expect(fold).toBeVisible({ timeout: 15_000 });
    await expect(fold).toHaveAttribute("data-open", "false");
    await expect(fold).toHaveAttribute("data-actions", "2");
    await expect(page.getByTestId("tool-call-row-toolu_fold_bash")).toHaveCount(0);
    await expect(fold.getByTestId(`tool-call-row-${askId}`)).toHaveCount(0);
    await expect(bubble.getByTestId(`question-answer-${askId}`).getByTestId("question-answer-value")).toHaveText("SQLite");
    await expect(bubble.getByText(answer)).toBeVisible();
    await bubble.screenshot({ path: test.info().outputPath("answer-outside-fold.png") });
  });

  test("on a 320 px pane the answer is never cut: it wraps, and the open row says it once", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_narrow_multi";
    const qChecks = "Which checks do we run before every push to main?";
    const qDb = "Quale database usiamo per la cache locale?";
    const questions = [
      { question: qChecks, header: "Checks", multiSelect: true, options: [{ label: "Lint" }, { label: "Typecheck" }, { label: "E2E" }] },
      { question: qDb, header: "Database", multiSelect: false, options: [{ label: "SQLite" }, { label: "Redis" }] },
    ];
    const freeChecks = "the copy check, only on landing pages";
    const freeDb = "DuckDB, per l'analitica in locale";
    await seedMessage(request, { sessionKey, role: "user", content: "decide for me" });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "Two things to decide:",
      toolCalls: [{
        id: toolCallId, name: "AskUserQuestion", args: { questions },
        status: "success", startedAt: Date.now() - 9_000, endedAt: Date.now() - 2_000,
        userInputSchema: { kind: "questions", questions },
        userResponse: {
          kind: "questions",
          answers: { [qChecks]: `Lint, Typecheck, ${freeChecks}`, [qDb]: freeDb },
          submittedAt: new Date().toISOString(),
        },
      }],
    });

    await openChat(page, chatPage);
    await page.setViewportSize({ width: 320, height: 760 });
    const row = page.getByTestId(`tool-call-row-${toolCallId}`);
    await row.scrollIntoViewIfNeeded();
    const recap = page.getByTestId(`question-answer-${toolCallId}`);
    const values = recap.getByTestId("question-answer-value");
    await expect(values).toHaveText([`Lint, Typecheck, «${freeChecks}»`, `«${freeDb}»`], { timeout: 15_000 });
    const rowWidth = await row.evaluate((el) => el.getBoundingClientRect().width);
    expect(rowWidth, "the row is as narrow as the pane").toBeLessThanOrEqual(320);
    for (const v of await values.all()) {
      const m = await v.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(m.scroll, "the answer is not cut").toBeLessThanOrEqual(m.client);
    }
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth), "nothing spills sideways").toBe(true);
    // Two questions: each line keeps its own, the header shows only the first.
    await expect(recap.getByTestId("question-answer-question")).toHaveCount(2);
    await row.screenshot({ path: test.info().outputPath("answer-recap-320.png") });

    // Open: the card with every option; the closed lines are gone, not repeated.
    await row.locator("button[aria-expanded]").first().click();
    await expect(page.getByTestId(`question-answer-card-${toolCallId}`)).toBeVisible();
    await expect(recap).toBeHidden();
  });

  test("an MCP form answer reads field by field, named as the form named them, never as JSON", async ({ page, chatPage, request }) => {
    const toolCallId = "toolu_elicit_issue";
    const message = "Create this issue on armonia/topics-app?";
    await seedMessage(request, { sessionKey, role: "user", content: "open an issue for the login bug" });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "Opening it:",
      toolCalls: [{
        id: toolCallId, name: "mcp__github__create_issue", args: { repo: "armonia/topics-app" },
        status: "success", startedAt: Date.now() - 9_000, endedAt: Date.now() - 2_000,
        userInputSchema: {
          kind: "elicitation", message,
          requestedSchema: { type: "object", properties: { title: { type: "string", title: "Title" }, confirm: { type: "boolean", title: "Confirm" } }, required: ["title"] },
        },
        userResponse: { kind: "elicitation", value: { title: "Fix the login bug", confirm: true }, submittedAt: new Date().toISOString() },
      }],
    });

    await openChat(page, chatPage);
    const row = page.getByTestId(`tool-call-row-${toolCallId}`);
    const recap = page.getByTestId(`question-answer-${toolCallId}`);
    const lines = recap.getByTestId("question-answer-line");
    await expect(lines).toHaveCount(2, { timeout: 15_000 });
    await expect(lines.nth(0).getByTestId("question-answer-question")).toHaveText("Title");
    await expect(lines.nth(0).getByTestId("question-answer-value")).toHaveText("Fix the login bug");
    await expect(lines.nth(1).getByTestId("question-answer-question")).toHaveText("Confirm");
    await expect(lines.nth(1).getByTestId("question-answer-value")).toHaveText("Sì");
    expect(await recap.innerText(), "no JSON on the closed row").not.toMatch(/[{}"]/);
    await row.screenshot({ path: test.info().outputPath("elicitation-recap-closed.png") });

    await row.locator("button[aria-expanded]").first().click();
    const card = page.getByTestId(`question-answer-card-${toolCallId}`);
    await expect(card).toBeVisible();
    await expect(recap).toBeHidden();
    await expect(card).toContainText(message);
    await expect(card.getByTestId("question-answer-field")).toHaveText(["Title: Fix the login bug", "Confirm: Sì"]);
    expect(await card.innerText(), "no JSON in the card").not.toMatch(/[{}"]/);
  });
});
