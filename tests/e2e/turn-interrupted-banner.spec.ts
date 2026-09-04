import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { CHAT_ROUTE_PATTERN, HISTORY_ROUTE_PATTERN } from "./helpers/sse-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";

hermetic(test);
const BASE = E2E_BASE;

/**
 * AN INTERRUPTED TURN SAYS WHY, AND OFFERS A WAY OUT.
 *
 * The 2026-09-03 report: the watchdog closes a turn at 22:25 and the chat
 * "sits there with no feedback at all". The only sign was a line appended at
 * the bottom of a long message, "[Response timed out]", which nobody reads:
 * getting to the bottom of a wall of text takes scrolling on purpose. The real
 * cause was in the server log, and there was no way out: resend the message or
 * keep waiting was left to guesswork.
 *
 * Now the verdict travels as an `error` BLOCK with the cause as a code
 * (`cause`, the same vocabulary as `stream:end`) and the composer turns it into
 * an amber banner above the box, headed "Risposta interrotta", with the cause  allow-italian: the banner's exact wording, which the assertions match on
 * in the reader's language and Retry, which resends the user's last message.
 *
 * WHY THE CLOSED TURN IS SEEDED instead of tripping the real watchdog. The
 * watchdog waits minutes of silence, and a test that waits them is a test
 * nobody runs; lowering the threshold through an env var measures a different
 * configuration. The block the watchdog writes is ONE
 * (`server/lib/interrupted-turn-block.ts`, with its unit tests) and the seed
 * puts it on the page in exactly the shape `handleGraceExpiry` persists: what
 * is proven here is what the user sees starting from that row, not the timer.
 *
 * THREE CASES, and the third is not a luxury: without it the banner could light
 * up on EVERY `error` block, including a stop pressed by hand, which already
 * has its own banner and is not an interruption to explain.
 *
 * The second case runs inside `clipDiConsegna` (helpers/clip.ts): with
 * `E2E_CLIP=1` it films the useful stretch only, and fails if it goes past 20s.
 * Without it the path is the same and nothing is recorded.
 *
 * @covers CHAT-INT-01
 */

const DOMANDA = "Riassumi il documento che ti ho mandato";
const PROSA_INTERROTTA = "Il documento parla di tre cose. La prima";
const RISPOSTA_RIPROVA = "Ecco il riassunto, stavolta intero.";

/** The watchdog verdict, in the shape `handleGraceExpiry` persists it. */
const VERDETTO = "Response timed out";

const banner = (page: Page) => page.locator('[data-testid="turn-interrupted-banner"]');
const userBubbles = (page: Page) => page.locator('[data-testid="chat-message"][data-role="user"]');
const assistantBubbles = (page: Page) => page.locator('[data-testid="chat-message"][data-role="assistant"]');
const messageInput = (page: Page) => page.getByRole("textbox", { name: /Message input/ });

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  const key = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
  expect(key, "the topic must carry a sessionKey").toBeTruthy();
  return key;
}

/**
 * A turn the server closed: the user's question, then the assistant bubble
 * with the prose it had written before dying and the `error` block that names
 * the cause. `content` keeps the textual marker, as the server does for old
 * clients: the banner must read the block, never the English sentence.
 */
async function seedInterruptedTurn(
  request: APIRequestContext,
  sessionKey: string,
  cause: "watchdog" | "user",
): Promise<void> {
  await seedMessage(request, { sessionKey, role: "user", content: DOMANDA });
  await seedMessage(request, {
    sessionKey,
    role: "assistant",
    content: `${PROSA_INTERROTTA}\n\n---\n*[${VERDETTO}]*`,
    blocks: [
      { kind: "text", text: PROSA_INTERROTTA },
      { kind: "error", text: VERDETTO, cause, at: new Date().toISOString() },
    ],
  });
}

/**
 * The reply to the resent question, mocked at the browser's edge.
 *
 * Installed AFTER the chat has loaded, and by hand instead of via
 * `mockChatStream`: that helper answers EVERY history read with its two mocked
 * rows, the initial load included, so the reply showed up before Retry was
 * pressed and the seeded turn vanished after `[DONE]` (seen on the first clip).
 * Here the history the client re-reads after the stream is the server's REAL
 * rows plus the new turn: what a person would see once the model answered.
 */
async function mockRetryReply(page: Page, sessionKey: string): Promise<void> {
  const res = await page.request.get(`${BASE}/api/history/${encodeURIComponent(sessionKey)}?limit=0`, {
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), "the real history must answer").toBe(true);
  const { messages } = (await res.json()) as { messages: Array<Record<string, unknown>> };

  await page.route(CHAT_ROUTE_PATTERN, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const delta = JSON.stringify({ choices: [{ index: 0, delta: { content: RISPOSTA_RIPROVA } }] });
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: `data: ${delta}\n\ndata: [DONE]\n\n`,
    });
  });
  await page.route(HISTORY_ROUTE_PATTERN, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      json: {
        messages: [
          ...messages,
          { id: "retry-user", role: "user", content: DOMANDA, timestamp: now },
          { id: "retry-assistant", role: "assistant", content: RISPOSTA_RIPROVA, timestamp: now },
        ],
      },
    });
  });
}

async function openChat(page: Page, topicName: string): Promise<void> {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topicName));
  await messageInput(page).waitFor({ state: "visible", timeout: 15_000 });
  // The history is on the page: the banner's absence means nothing on an
  // empty chat still loading.
  await expect(assistantBubbles(page).last()).toContainText(PROSA_INTERROTTA, { timeout: 15_000 });
}

test.describe.serial("Turno interrotto: il banner sopra il composer", () => {
  let watchdogTopicId: string;
  let watchdogTopicName: string;
  let watchdogSessionKey: string;
  let stoppedTopicId: string;
  let stoppedTopicName: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    watchdogTopicName = `turno-watchdog-${stamp}`;
    const watchdogTopic = await createTopic(request, watchdogTopicName);
    watchdogTopicId = watchdogTopic.id;
    watchdogSessionKey = await sessionKeyOf(request, watchdogTopicId);
    await seedInterruptedTurn(request, watchdogSessionKey, "watchdog");

    stoppedTopicName = `turno-fermato-${stamp}`;
    const stoppedTopic = await createTopic(request, stoppedTopicName);
    stoppedTopicId = stoppedTopic.id;
    await seedInterruptedTurn(request, await sessionKeyOf(request, stoppedTopicId), "user");
  });

  test.afterAll(async ({ request }) => {
    if (watchdogTopicId) await deleteTopic(request, watchdogTopicId);
    if (stoppedTopicId) await deleteTopic(request, stoppedTopicId);
  });

  test("il watchdog ha chiuso il turno: il banner dice perché, nella lingua di chi legge", async ({ page, request }) => {
    // One chat pane only: `messageInput` is strict, and a surviving pane from
    // another topic would resolve it to two elements.
    await resetPaneStore(request, [watchdogTopicId]);
    await openChat(page, watchdogTopicName);

    const box = banner(page);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toHaveAttribute("data-cause", "watchdog");
    await expect(box).toContainText("Risposta interrotta");
    // The CAUSE, as a sentence: the code name must never reach the reader.
    await expect(box).toContainText(/il modello ha smesso di rispondere/);
    await expect(box).not.toContainText(/watchdog/i);
    await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toHaveText(/Riprova/);

    // The prose the turn had written is still there: the banner adds, it does
    // not replace.
    await expect(assistantBubbles(page).last()).toContainText(PROSA_INTERROTTA);
  });

  test("«Riprova» rimanda l'ultimo messaggio dell'utente, e il banner se ne va", async ({ request }) => {
    await resetPaneStore(request, [watchdogTopicId]);

    await clipDiConsegna({
      nome: "turn-interrupted-banner",
      // Our own context: nothing from `use` reaches it. Italian because the
      // assertions read the Italian sentence; 1280x680 is the board's ratio.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // Off camera: the app starting and the topic opening. The pane is
      // written on the server, so the scene's page finds it already open.
      prologo: async (p) => {
        await openChat(p, watchdogTopicName);
      },
      scena: async (page) => {
        await openChat(page, watchdogTopicName);

        // FIRST STATE: the interrupted turn, the banner with its cause, and
        // exactly one assistant bubble: nothing has answered yet.
        const box = banner(page);
        await expect(box).toBeVisible({ timeout: 15_000 });
        await expect(box).toContainText(/il modello ha smesso di rispondere/);
        await expect(userBubbles(page).last()).toContainText(DOMANDA);
        await expect(assistantBubbles(page)).toHaveCount(1);
        await didascalia(page, "Risposta interrotta: il banner dice perché");
        await beat(page, 1600);

        // The reply is mocked: this test is about the resend, not the model.
        await mockRetryReply(page, watchdogSessionKey);
        // What Retry sends is the OBSERVABLE: the POST body's last message is
        // the user's question, word for word. Registered before the click so
        // a fast request cannot slip past the listener.
        const postRiprova = page.waitForRequest((req) => {
          if (req.method() !== "POST" || !req.url().endsWith("/api/chat")) return false;
          const body = req.postDataJSON() as { messages?: Array<{ role: string; content: string }> } | null;
          const last = body?.messages?.[body.messages.length - 1];
          return last?.role === "user" && last.content === DOMANDA;
        }, { timeout: 15_000 });

        const retry = page.locator('[data-testid="turn-interrupted-retry"]');
        await expect(retry).toBeVisible();
        await didascalia(page, "Un click su «Riprova»");
        await beat(page, 1000);
        await retry.click();

        // SECOND STATE: the question left again as a new turn, the reply
        // landed under it, and the interrupted turn is still there above.
        await postRiprova;
        await expect(assistantBubbles(page).last()).toContainText(RISPOSTA_RIPROVA, { timeout: 15_000 });
        await expect(userBubbles(page)).toHaveCount(2);
        await expect(userBubbles(page).last()).toContainText(DOMANDA);
        await expect(assistantBubbles(page).first()).toContainText(PROSA_INTERROTTA);
        // `toHaveCount(0)`, not `toBeHidden`: the node must not exist.
        await expect(box).toHaveCount(0);
        await didascalia(page, "Il messaggio è ripartito, il banner non c'è più");
        await beat(page, 1600);

        await page.unroute(CHAT_ROUTE_PATTERN);
        await page.unroute(HISTORY_ROUTE_PATTERN);
      },
    });
  });

  test("uno stop della persona non accende il banner", async ({ page, request }) => {
    // Same shape on the page: an assistant bubble with an `error` block. The
    // only difference is the cause, and it is the cause that decides.
    await resetPaneStore(request, [stoppedTopicId]);
    await openChat(page, stoppedTopicName);

    await expect(banner(page)).toHaveCount(0);
  });
});
