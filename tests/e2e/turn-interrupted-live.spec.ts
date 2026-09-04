import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat } from "./helpers/evidence";

hermetic(test);

const BASE = E2E_BASE;

/**
 * THE WATCHDOG FIRES WHILE SOMEBODY IS WATCHING - and the banner has to appear.
 *
 * Its twin, `turn-interrupted-banner.spec.ts`, covers the row that is ALREADY
 * written: the verdict is seeded, the page loads, the banner is there. That is
 * the case of whoever comes back later, and it left the main one uncovered.
 *
 * THE MAIN ONE IS THIS. The 2026-09-03 report is a person sitting in front of
 * the chat at 22:25 while the turn dies under them. The server writes the cause
 * on the row, but this page is already HOLDING that message in memory:
 * `stream:end` flipped the spinner off and left the bubble as it was, so the
 * banner showed up on the next reload. Which is to say: it did not show up to
 * the only person who was there to see it.
 *
 * A test that seeds and reloads cannot catch that, and mine did not: it was
 * green while the live path was broken. So this file drives the page the way
 * the server does - real WS frames, no reload anywhere - and the assertion is
 * the one the report is about: the banner appears BY ITSELF.
 *
 * THE SECOND TEST IS NOT A LUXURY. A rule that lights a banner at the end of a
 * turn has to stay silent on the ending that happens a thousand times a day:
 * the clean one. Without that test, "the banner appears when the turn ends"
 * would pass just as well with a banner on EVERY answer.
 *
 * WHY FRAMES AND NOT A REAL WATCHDOG: the watchdog waits minutes of silence,
 * and a test that waits them is a test nobody runs; lowering its threshold
 * through an env var measures a different configuration. The frames injected
 * here are the exact shape the server broadcasts (`stopCause` has been on
 * `stream:end` since long before this banner) - the contract is copied, not
 * imagined.
 *
 * @covers CHAT-INT-01, CHAT-INT-02
 */

const DOMANDA = "Riassumi il documento che ti ho mandato";
const PROSA = "Il documento parla di tre cose. La prima";
const MSG_ID = "live-interrupted-0001";
/** The bubble the boot's resend opens: a NEW row, as on the real path. */
const RESUME_MSG_ID = "live-resumed-0001";
/** The first word of the resumed answer, which is what closes the banner. */
const RESUMED_OPENING = "Riprendo da dove ero rimasto:";

const banner = (page: Page) => page.locator('[data-testid="turn-interrupted-banner"]');
const assistantBubble = (page: Page) =>
  page.locator('[data-testid="chat-message"][data-role="assistant"]').last();

/**
 * The prose arrives in pieces, and each piece is WAITED FOR before the next.
 *
 * NO FIXED WAIT ANYWHERE, and not out of obedience to the gate: a sleep would
 * be a bet that the frame landed, while these awaits are the frame landing.
 * The clip gets its rhythm from work that really happened - a turn typing -
 * instead of from a clock, and it is legible for the same reason it is honest.
 */
const PEZZI = [
  "Il documento parla di tre cose. ",
  "La prima riguarda i termini di consegna, ",
  "che il fornitore ha spostato di due settimane ",
  "senza darne comunicazione scritta. ",
  "La seconda",
];

test.describe.serial("Turno interrotto dal vivo: il banner compare da solo", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `turno-vivo-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)!.sessionKey;
    expect(sessionKey, "the topic must carry a sessionKey").toBeTruthy();
    // Retry resends the user's last message: without one on the row there is
    // nothing to offer, and the button would be correctly absent.
    await seedMessage(request, { sessionKey, role: "user", content: DOMANDA });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /** Opens the topic holding the WS, so frames can be injected "from the server". */
  async function apri(page: Page): Promise<(frame: Record<string, unknown>) => void> {
    let inject: ((data: string) => void) | null = null;
    // Armed BEFORE goto, or the initial connection goes around it.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await page.getByRole("textbox", { name: /Message input/ }).waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);
    return (frame: Record<string, unknown>) => inject!(JSON.stringify({ sessionKey, topicId, ...frame }));
  }

  /** A turn that starts and writes, like the real one. */
  async function detta(page: Page, send: (f: Record<string, unknown>) => void): Promise<void> {
    send({ type: "stream:start", messageId: MSG_ID });
    let scritto = "";
    for (const pezzo of PEZZI) {
      send({ type: "stream:content_chunk", messageId: MSG_ID, content: pezzo });
      scritto += pezzo;
      // The wait IS the assertion: the next chunk leaves only once this one is
      // on screen, so the pacing comes from the page, not from a clock.
      await expect(assistantBubble(page)).toContainText(scritto.trim(), { timeout: 10_000 });
    }
    // While it is answering there is nothing to explain.
    await expect(banner(page)).toHaveCount(0);
  }

  test("il watchdog chiude il turno sotto gli occhi: il banner compare senza ricaricare", async ({ page }) => {
    const send = await apri(page);
    await detta(page, send);

    // The end the watchdog broadcasts, in the shape the server sends it.
    send({
      type: "stream:end",
      messageId: MSG_ID,
      stopReason: "cancelled",
      stopCause: "watchdog",
      reason: "error",
      error: "⚠️ Response timed out. The AI service took too long to respond. Please try again.",
    });

    const box = banner(page);
    // NO RELOAD ANYWHERE ABOVE: this is the whole point of the file.
    await expect(box).toBeVisible({ timeout: 10_000 });
    await expect(box).toHaveAttribute("data-cause", "watchdog");
    await expect(box).toContainText("Risposta interrotta"); // allow-italian: the banner's exact wording, which this asserts on
    // The cause as a SENTENCE: the code name must never reach the reader.
    await expect(box).toContainText(/il modello ha smesso di rispondere/);
    await expect(box).not.toContainText(/watchdog/i);
    // And the way out is there, on the message that has to be resent.
    await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toBeVisible();
    // The prose the turn had written is untouched: the banner adds, never replaces.
    await expect(assistantBubble(page)).toContainText(PROSA);
  });

  test("una fine PULITA non accende niente: è quello che succede mille volte al giorno", async ({ page }) => {
    const send = await apri(page);
    await detta(page, send);

    send({ type: "stream:end", messageId: MSG_ID, completed: true, latencyMs: 1200 });

    // Settled on the finished turn, and still no banner: waiting for the
    // spinner to stop is what makes the absence meaningful instead of early.
    await expect(assistantBubble(page)).toContainText(PROSA);
    await expect(banner(page)).toHaveCount(0);
  });

  /**
   * THE BANNER WHILE THE SERVER IS RESUMING BY ITSELF (card 1929291c).
   *
   * THE REPORT: "if this resumes on its own, with that banner and no sort of
   * progress, you cannot tell whether it really is resuming".
   * allow-italian: the report is quoted in the card, translated here
   *
   * The boot resends the message (`server/lib/ripresa-boot.ts`) and the turn
   * can take a minute to say its first word. For that whole minute the screen
   * used to show the SAME amber banner as before, whose only advice is to
   * press Retry - which resends the very message the server is resending, so
   * the reward for reading the screen was a second turn on a chat that has one
   * open.
   *
   * The frames here are the shape the server broadcasts: `resumedBy: "server"`
   * on `stream:start`, set from the `ripresa` field the boot puts on the chat
   * route's body.
   */
  test("il server riprende da solo: il banner lo dice e toglie Riprova", async ({ page }) => {
    const send = await apri(page);
    await detta(page, send);

    // The restart kills the turn: this is the row the boot will resume.
    send({
      type: "stream:end",
      messageId: MSG_ID,
      stopReason: "cancelled",
      stopCause: "server-shutdown",
      reason: "error",
      error: "⚠️ Il server si è riavviato a turno aperto.",
    });
    await expect(banner(page)).toHaveAttribute("data-state", "interrupted");
    await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toBeVisible();

    // The boot resends, and the turn starts again on the same chat.
    send({ type: "stream:start", messageId: RESUME_MSG_ID, resumedBy: "server" });

    const box = banner(page);
    await expect(box).toHaveAttribute("data-state", "resuming", { timeout: 10_000 });
    await expect(box).toContainText("Ripresa in corso"); // allow-italian: the banner's exact wording, which this asserts on
    await expect(box).toContainText(/sta rimandando il tuo messaggio/);
    // NO RETRY: pressing it would buy a second turn while the first resumes.
    await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toHaveCount(0);
    // The activity indicator, same ring the app spins on any wait.
    await expect(box.locator(".animate-spin")).toBeVisible();

    // First token: from here the answer is its own proof, and the banner goes.
    send({ type: "stream:content_chunk", messageId: RESUME_MSG_ID, content: RESUMED_OPENING });
    await expect(assistantBubble(page)).toContainText(RESUMED_OPENING);
    await expect(banner(page)).toHaveCount(0);
  });

  test("la ripresa fallisce: si torna al banner con la causa e Riprova", async ({ page }) => {
    const send = await apri(page);
    await detta(page, send);
    send({
      type: "stream:end", messageId: MSG_ID, stopReason: "cancelled", stopCause: "server-shutdown",
      reason: "error", error: "⚠️ Il server si è riavviato a turno aperto.",
    });
    await expect(banner(page)).toHaveAttribute("data-state", "interrupted");

    send({ type: "stream:start", messageId: RESUME_MSG_ID, resumedBy: "server" });
    await expect(banner(page)).toHaveAttribute("data-state", "resuming", { timeout: 10_000 });

    // The resume dies the same way the first turn did.
    send({
      type: "stream:end", messageId: RESUME_MSG_ID, stopReason: "cancelled", stopCause: "server-shutdown",
      reason: "error", error: "⚠️ Il server si è riavviato a turno aperto.",
    });

    const box = banner(page);
    await expect(box).toHaveAttribute("data-state", "interrupted", { timeout: 10_000 });
    await expect(box).toHaveAttribute("data-cause", "server-shutdown");
    await expect(box).toContainText(/il server si è riavviato a turno aperto/);
    await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toBeVisible();
  });

  test("la clip: interrotto, ripreso dal server, e la risposta riparte", async () => {
    await clipDiConsegna({
      nome: "turn-resuming-banner",
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      scena: async (page) => {
        const send = await apri(page);
        // FIRST STATE: the turn answers, then the restart cuts it.
        await detta(page, send);
        send({
          type: "stream:end", messageId: MSG_ID, stopReason: "cancelled",
          stopCause: "server-shutdown", reason: "error",
          error: "⚠️ Il server si è riavviato a turno aperto.",
        });
        await expect(banner(page)).toHaveAttribute("data-state", "interrupted", { timeout: 10_000 });
        await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toBeVisible();
        await beat(page, 2200);

        // SECOND STATE: the server resumes by itself and the banner says so.
        send({ type: "stream:start", messageId: RESUME_MSG_ID, resumedBy: "server" });
        await expect(banner(page)).toHaveAttribute("data-state", "resuming", { timeout: 10_000 });
        await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toHaveCount(0);
        await beat(page, 3000);

        // THIRD STATE: the first token arrives and the banner closes itself.
        send({ type: "stream:content_chunk", messageId: RESUME_MSG_ID, content: RESUMED_OPENING });
        await expect(assistantBubble(page)).toContainText(RESUMED_OPENING);
        await expect(banner(page)).toHaveCount(0);
        await beat(page, 2000);
      },
    });
  });

  test("la clip: il turno risponde, poi si interrompe da solo", async () => {
    await clipDiConsegna({
      nome: "turn-interrupted-live",
      // Our own context: nothing from `use` reaches it. Italian because the
      // assertions read the Italian sentence.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      scena: async (page) => {
        const send = await apri(page);

        // FIRST STATE: the turn is answering. No banner.
        await detta(page, send);

        // The watchdog closes it under the reader's eyes.
        send({
          type: "stream:end",
          messageId: MSG_ID,
          stopReason: "cancelled",
          stopCause: "watchdog",
          reason: "error",
          error: "⚠️ Response timed out.",
        });

        // SECOND STATE: the banner appeared by itself, saying why.
        await expect(banner(page)).toBeVisible({ timeout: 10_000 });
        await expect(banner(page)).toContainText(/il modello ha smesso di rispondere/);
        // Retry is part of the second state: the way out, on screen.
        await expect(page.locator('[data-testid="turn-interrupted-retry"]')).toBeVisible();
      },
    });
  });
});
