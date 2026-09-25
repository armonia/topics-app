import { test, expect } from "./fixtures/test-fixtures";
import type { Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";

hermetic(test);

/**
 * AN EMPTY TURN THE MACHINE STOPPED OFFERS NO RETRY (card 46617a7f).
 *
 * A land, a delegation's deadline or the stall judge stops a turn on purpose.
 * When that turn had said nothing, its row is discarded and the chat used to
 * end on the card's envelope: the composer showed its no-reply banner with a
 * Retry button, and Retry resent the envelope, a paid turn to redo work already
 * on main. The server now writes one row carrying only a `machine-stop` block
 * (`server/lib/machine-stop-notice.ts`); this spec is the client half of that
 * contract, on the engine that ships: the row as the server stores it (after a
 * reload) and the frames the server sends (live).
 *
 * The server half, red before the fix and green after, drives the real chat and
 * abort routes: `tests/integration/machine-stop-parity.test.ts`.
 *
 * It is a behaviour, so the video is the proof.
 * @covers CHAT-01
 */
test.use({ video: "on" });

const ENVELOPE = "You are the exclusive owner of task 46617a7f. Merge the branch.";
const LANDED = "Fermato: il lavoro della card è già atterrato o è passato altrove";

async function seedTopic(request: import("@playwright/test").APIRequestContext, name: string, rows: Array<{ role: "user" | "assistant"; content: string; blocks?: unknown[] }>) {
  const topicId = (await createTopic(request, name)).id;
  for (const r of rows) {
    const res = await request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
      data: { role: r.role, content: r.content, ...(r.blocks ? { blocks: r.blocks } : {}) }, ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBe(true);
  }
  return topicId;
}

/** Nothing on screen offers to resend the envelope. */
async function expectNoRetry(page: Page) {
  await expect(page.getByTestId("no-reply-banner")).toHaveCount(0);
  await expect(page.getByTestId("message-retry")).toHaveCount(0);
  await expect(page.getByTestId("turn-interrupted-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Riprova/ })).toHaveCount(0);
}

test.describe("an empty turn the machine stopped", () => {
  const made: string[] = [];
  test.afterAll(async ({ request }) => { for (const id of made) await deleteTopic(request, id).catch(() => {}); });

  test("the landed card's chat says why in one line and offers no Riprova, after a reload too", async ({ page, chatPage, request }) => {
    const name = `machine-stop-${Date.now()}`;
    const topicId = await seedTopic(request, name, [
      { role: "user", content: ENVELOPE, blocks: [{ kind: "dispatched-envelope" }] },
      // What `/api/chat/abort` writes: no text, the block is the whole row.
      { role: "assistant", content: "", blocks: [{ kind: "machine-stop", cause: "superseded", text: LANDED }] },
    ]);
    made.push(topicId);
    await resetPaneStore(request, [topicId]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const line = page.getByTestId("machine-stop-row");
    await expect(line).toHaveAttribute("data-cause", "superseded", { timeout: 15_000 });
    await expect(line).toHaveText(LANDED);
    await expectNoRetry(page);

    await page.reload();
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.getByTestId("machine-stop-row")).toHaveText(LANDED, { timeout: 15_000 });
    await expectNoRetry(page);
    await page.screenshot({ path: test.info().outputPath("machine-stop-after-reload.png") });
  });

  test("live: the frames of a machine stop leave the line, not the no-reply banner", async ({ page, chatPage, request }) => {
    // The order of Variant A (claude-code): the chat route discards the empty
    // row and says so on `stream:end`, then the abort route announces the
    // service row. Between the two frames the chat ends on the envelope.
    const name = `machine-stop-live-${Date.now()}`;
    const topicId = await seedTopic(request, name, [
      { role: "user", content: "domanda di prima" },
      { role: "assistant", content: "risposta di prima" },
    ]);
    made.push(topicId);
    await resetPaneStore(request, [topicId]);
    const topics = (await (await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)!.sessionKey;

    const wire = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => wire.getByType("subscribe").some(({ direction, data }) =>
      direction === "client" && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);

    wire.send({ type: "message:new", topicId, sessionKey, role: "user", messageId: `env-${Date.now()}`, content: ENVELOPE, preview: ENVELOPE.slice(0, 100) });
    const turn = `turn-${Date.now()}`;
    wire.send({ type: "stream:start", sessionKey, topicId, messageId: turn });
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 10_000 });
    wire.send({ type: "stream:end", sessionKey, topicId, messageId: turn, discardedMessageId: turn, stopReason: "cancelled", completed: false });
    wire.send({
      type: "message:new", topicId, sessionKey, role: "assistant", messageId: `stop-${Date.now()}`,
      content: LANDED, preview: "", blocks: [{ kind: "machine-stop", cause: "superseded", text: LANDED }],
    });

    await expect(page.getByTestId("machine-stop-row")).toHaveText(LANDED, { timeout: 10_000 });
    await expect(chatPage.streamingIndicator).toBeHidden();
    await expectNoRetry(page);
  });

  test("the opposite: a turn that really came back empty still says so and offers Riprova", async ({ page, chatPage, request }) => {
    // No stop at all: the provider closed the turn with nothing, and the chat
    // route wrote its notice (`routes/chat.ts`, the empty-turn branch). That
    // is a failure the person can act on.
    const name = `empty-for-real-${Date.now()}`;
    const topicId = await seedTopic(request, name, [
      { role: "user", content: "rispondi" },
      {
        role: "assistant",
        content: "⚠️ Nessuna risposta: il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.",
        blocks: [{ kind: "error", text: "Nessuna risposta: il turno si è chiuso senza produrre niente." }],
      },
    ]);
    made.push(topicId);
    await resetPaneStore(request, [topicId]);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    for (const round of ["open", "reload"]) {
      if (round === "reload") {
        await page.reload();
        await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
      }
      await expect(page.getByText(/Nessuna risposta: il turno si è chiuso/).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("message-retry")).toBeVisible();
      await expect(page.getByTestId("machine-stop-row")).toHaveCount(0);
    }
  });
});
