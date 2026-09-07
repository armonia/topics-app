import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { HISTORY_FIRST_PAGE } from "../../shared/history-paging";
import { VISIBLE_CHAT_SCROLLER as SCROLLER, wheelUpUntilVisible } from "./helpers/wheel-scroll";

hermetic(test);

/**
 * The first page of a FAT chat is bounded by BYTES, and the reader never sees
 * the difference.
 *
 * THE DEFECT, measured in read-only on this machine's own state on 2026-09-07:
 * `HISTORY_FIRST_PAGE = 40` bounds the COUNT of the first page, and a count is
 * not a size. Forty messages of an agentic topic weigh 0.66 to 1.33 MB of lean
 * rows, 30x to 60x the "few tens of KB" the paging assumed, and that page is
 * what the curtain waits for. The server now walks the lean rows from the tail
 * and stops at `HISTORY_PAGE_MAX_BYTES`.
 *
 * WHAT THIS SPEC PINS is the half the server cannot prove on its own: a chat
 * SHORTER than a page - so one that count-based paging would have served whole
 * - now arrives partial, and the client says so and completes it with the code
 * it already has. The tail is on screen from the first frame, the row at the
 * top names the messages it is still missing, and the click brings them.
 * @covers CHAT-HIST-01
 */

/** Shorter than a page on purpose: only the BYTES can make this one partial. */
const SEEDED = 24;
/** About 60 KB of prose per reply, the weight an agentic turn really has. */
const REPLY_PROSE = "The agent explains what it did, quotes a path, and moves on to the next step. ".repeat(800);
const LIST = '[data-testid="virtuoso-item-list"]';

function seededText(n: number): string {
  return `Seeded message #${String(n).padStart(3, "0")}`;
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  return key;
}

/** Sequential: the seed endpoint links each row to the session's last message. */
async function seedFatThread(request: APIRequestContext, sessionKey: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const user = i % 2 === 1;
    await seedMessage(request, {
      sessionKey,
      role: user ? "user" : "assistant",
      content: user ? `${seededText(i)}\n\nA short question.` : `${seededText(i)}\n\n${REPLY_PROSE}`,
    });
  }
}

function rowOf(page: Page, n: number) {
  return page.locator(LIST).getByText(seededText(n));
}

test.describe("La prima pagina di una chat grassa sta nel budget", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  let fatTopic: { id: string; name: string };

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    fatTopic = await createTopic(request, `page-budget-${Date.now()}`);
    await seedFatThread(request, await sessionKeyOf(request, fatTopic.id), SEEDED);
  });

  test.afterAll(async ({ request }) => {
    if (fatTopic) await deleteTopic(request, fatTopic.id).catch(() => {});
  });

  test("il sipario si alza sull'ultimo messaggio e lo scroll in alto completa la storia", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    test.setTimeout(120_000);
    await resetPaneStore(request, [fatTopic.id]);
    const TAB = `pane-tab-${fatTopic.id}`;

    // The premise of the whole spec: fewer messages than a page, so anything
    // partial here is the byte budget and nothing else.
    expect(SEEDED, "the fixture must be shorter than a page").toBeLessThan(HISTORY_FIRST_PAGE);

    await clipDiConsegna({
      nome: "history-page-budget",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 720 },
        reducedMotion: "reduce",
      },
      prologo: async (p) => {
        await p.goto("/");
        await p.getByTestId(TAB).click();
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 20000 });
      },
      scena: async (p) => {
        await p.goto("/");
        // The curtain lifts on the TAIL: the last seeded message is the first
        // thing on screen, on a topic whose whole history is over a megabyte.
        await expect(rowOf(p, SEEDED)).toBeVisible({ timeout: 20000 });
        await didascalia(p, "La chat si apre sull'ultimo messaggio, non sul megabyte");
        await beat(p, 1500);

        // Partial, and honest about it, although the thread is shorter than a
        // page: the byte budget cut it, and the client read `total`.
        await expect(p.locator(SCROLLER)).toHaveAttribute("data-history", "partial", { timeout: 15000 });

        // Up top, the row that names what is missing and offers to bring it.
        const divider = p.getByTestId("chat-load-older");
        await wheelUpUntilVisible(p, divider);
        await didascalia(p, "In cima alla finestra caricata: i messaggi che mancano, contati");
        await beat(p, 1500);

        await p.getByTestId("chat-load-older-button").click();
        await expect(p.locator(SCROLLER)).toHaveAttribute("data-history", "complete", { timeout: 20000 });
        await expect(divider).toHaveCount(0);
        await didascalia(p, "Il click completa la storia con `before`");
        await beat(p, 1200);

        // And the head is reachable: the story is whole.
        await wheelUpUntilVisible(p, rowOf(p, 1), 120);
        await didascalia(p, "Scorrendo ancora, il primo messaggio della chat");
        await beat(p, 1500);
      },
    });
  });
});
