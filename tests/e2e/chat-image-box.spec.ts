/**
 * CHAT-MEDIA-BOX — a picture that arrives live has its box before its bytes.
 *
 * WHAT IT PINS. A chat open and resting at the bottom; a message with a picture
 * reaches it from the server, and the picture's bytes come late. Without a box
 * the `<img>` is zero pixels tall until they arrive, and then everything under
 * it moves (`max-h-80`: up to 320 px). The server now sends the size of each
 * picture with the frame (`mediaSizes`, `server/lib/media-size.ts`) and the
 * client draws its box at once (`components/Chat/mediaBox.ts`).
 *
 * THE DOOR: `message:new`, here from the real server (`POST …/system-message`,
 * the same broadcast every new row goes through, `withFrameMediaSizes` in
 * server/utils.ts).
 *
 * WHY THE PICTURE IS HELD. On a test machine its bytes arrive in a few
 * milliseconds, and "the box was there" would look the same as "the bytes were
 * fast" (`helpers/png-fixture.ts`).
 *
 * THE MEASURE is the CLS of the layout shifts recorded after the frame is sent,
 * with the observer of `helpers/cls-return.ts`. Measured before the fix (07-08/10,
 * cloud VM): see the report of track T7.
 *
 * @covers CHAT-MEDIA-BOX-01
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { armObserver, buildReport, collectShifts, settledUntilQuiet, summarize, type Shift } from "./helpers/cls-return";
import { holdPicture, uploadPng } from "./helpers/png-fixture";
import { beat, didascalia } from "./helpers/evidence";

hermetic(test);
test.use({ viewport: { width: 1280, height: 800 } });

/** How late the picture's bytes are. */
const PICTURE_HOLD_MS = 1200;
/** The CLS contract of a message arriving under the reader's eyes (PERF-01). */
const CLS_CAP = 0.01;

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey`);
  return key;
}

async function seedThread(request: APIRequestContext, key: string, tag: string): Promise<void> {
  for (let i = 1; i <= 24; i++) {
    await seedMessage(request, {
      sessionKey: key,
      role: i % 2 ? "user" : "assistant",
      content: `${tag} row #${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(i % 5 === 0 ? 6 : 2)}`,
    });
  }
}

/** Opens the topic on its last row and waits until nothing moves or loads. */
async function openAtBottom(page: Page, topicId: string, lastText: string): Promise<void> {
  // The topic is the focused pane from the first line of the app.
  await page.addInitScript((id) => localStorage.setItem("pane-store-focused-id", id), topicId);
  await page.goto("/");
  await page.getByTestId(`pane-tab-${topicId}`).click();
  const shell = page.locator(`[data-pane-shell="${topicId}"]`);
  await expect(shell.locator('[data-testid="chat-message"]').filter({ hasText: lastText })).toBeVisible({ timeout: 20_000 });
  await settledUntilQuiet(page, { quietMs: 1500, timeout: 30_000 });
}

/** The CLS of the shifts recorded since `since` (a `performance.now()` of the page). */
async function clsSince(page: Page, since: number): Promise<ReturnType<typeof buildReport>> {
  const shifts = (await collectShifts(page)).filter((s: Shift) => s.at >= since);
  return buildReport(shifts);
}

async function postSystemMessage(request: APIRequestContext, topicId: string, content: string): Promise<void> {
  const res = await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, { data: { content } });
  expect(res.ok(), `system-message: ${res.status()}`).toBe(true);
}

test.describe("Un'immagine che arriva dal vivo ha il suo spazio prima dei suoi byte", () => {
  test.use({ serviceWorkers: "block" });

  test("un messaggio con un'immagine arriva dal server: niente si sposta quando l'immagine si carica", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-MEDIA-BOX-01" });
    test.setTimeout(120_000);
    const topic = await createTopic(request, `image-live-new-${Date.now()}`);
    const key = await sessionKeyOf(request, topic.id);
    try {
      await seedThread(request, key, "Live");
      await resetPaneStore(request, [topic.id]);
      const picture = await uploadPng(request, "t7-live-new.png", 900, 500);
      const ws = await interceptWebSocket(page);
      await armObserver(page);
      const late = await holdPicture(page, "t7-live-new.png", PICTURE_HOLD_MS);
      await openAtBottom(page, topic.id, "Live row #24.");
      await didascalia(page, "Chat aperta in fondo: arriva un messaggio con un'immagine lenta");
      await beat(page, 800);

      const shell = page.locator(`[data-pane-shell="${topic.id}"]`);
      const since = await page.evaluate(() => performance.now());
      await postSystemMessage(request, topic.id, `LIVE-IMAGE: the screenshot of the page you asked for.\nMEDIA:${picture}`);
      const reply = shell.locator('[data-testid="chat-message"]').filter({ hasText: "LIVE-IMAGE" });
      await expect(reply).toBeVisible({ timeout: 20_000 });
      const img = reply.getByTestId("media-image");
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
      await settledUntilQuiet(page, { quietMs: 1500, timeout: 30_000 });
      await beat(page, 800);
      const report = await clsSince(page, since);
      console.log(`[chat-image-box:new] picture=${late.held} CLS=${report.cls.toFixed(4)} shifts=${report.count}\n${summarize(report)}`);

      expect(late.held, "the picture was never held").toBeGreaterThan(0);
      expect(report.cls, `who moved:\n${summarize(report)}`).toBeLessThanOrEqual(CLS_CAP);
      // The view followed the message down, onto the whole picture.
      const list = shell.locator('[data-testid="chat-message-list"]');
      await expect.poll(() => list.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), { timeout: 10_000 }).toBeLessThanOrEqual(2);
      await expect(img).toBeInViewport({ ratio: 1 });
      // The size came from the server, with the frame.
      const frame = ws.getByType("message:new").map((m) => JSON.parse(m.data) as { content?: string; mediaSizes?: Record<string, [number, number]> })
        .find((f) => f.content?.includes("LIVE-IMAGE"));
      expect(frame?.mediaSizes, "the server sent the size with the frame").toEqual({ [picture]: [900, 500] });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
