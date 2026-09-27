/**
 * THE CAPPED RESUME NOTICE REACHES THE WINDOWS OPEN ON THE CHAT, WITHOUT A
 * RELOAD (card 09d3b815).
 *
 * The resume sweep resends a cut turn up to four times; past that it writes
 * "Ripresa automatica sospesa" in the chat and stops. It wrote the row and sent
 * no frame, and nothing starts after it: a window open on the chat went on
 * showing the chat without its last word until a reload. On 24/09, six of them
 * on one chat in thirty minutes, with the chat open.
 *
 * The sweep here is the real one, woken the real way: a stale stream on
 * another chat is closed by the stale-stream tick (its silence threshold cut to
 * 1 s), and the close nudges the sweep 20 s later. The chat under test holds a
 * turn cut by the watchdog on its fourth resend. Its rows are written after
 * both windows have loaded it, so a sweep that ran early cannot hand the
 * notice to them through the history: the only way in is the frame.
 *
 * @covers RESUME-02
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { openTwoDevices } from "./helpers/multi-client";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

const CAPPED = "Ripresa automatica sospesa";

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

async function sessionRow(request: APIRequestContext, topicId: string, role: "user" | "assistant", content: string, blocks?: unknown[]) {
  const res = await request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, { data: { role, content, ...(blocks ? { blocks } : {}) } });
  expect(res.ok()).toBe(true);
}

const noticeIn = (page: Page, topicId: string) =>
  page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"] [data-testid="chat-message"][data-role="assistant"]`).filter({ hasText: CAPPED });

test.describe("the capped resume notice, with the chat open in two windows", () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
  });

  test("both windows show it as it is written, once, with no reload", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "RESUME-02" });
    // A spent usage window holds every sweep, in silence.
    expect((await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { clear: true } })).ok()).toBe(true);
    const a = (await createTopic(request, "Capped live")).id;
    const b = (await createTopic(request, "Capped nudge")).id;
    const devices = await openTwoDevices(browser, { seed: (r) => resetPaneStore(r, [a]) });
    try {
      const { pageA, pageB } = devices;
      for (const p of [pageA, pageB]) {
        await expect(p.locator(`[data-testid="chat-panel"][data-chat-topic-id="${a}"]`)).toBeVisible({ timeout: 20_000 });
        await p.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      }

      // A turn the watchdog cut on its fourth resend: the chain is spent.
      await sessionRow(request, a, "user", "misura la catena");
      await sessionRow(request, a, "assistant", "", [
        { kind: "ripreso", attempt: 4 },
        { kind: "text", text: "stavo misurando" },
        { kind: "error", text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.", cause: "watchdog" },
      ]);
      // The wake-up: a stream on another chat that the stale tick closes.
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      expect((await request.post(`${E2E_BASE}/api/test/streams/partial`, { data: { sessionKey: await sessionKeyOf(request, b) } })).ok()).toBe(true);

      // The sweep ran and wrote the notice: a red below can only mean "written
      // and not shown".
      await expect
        .poll(async () => {
          const body = (await (await request.get(`${E2E_BASE}/api/topics/${a}/messages?limit=10`)).json()) as { messages: { content: string }[] };
          return body.messages.filter((m) => m.content.includes(CAPPED)).length;
        }, { timeout: 90_000, intervals: [1_000], message: "the sweep writes the capped notice" })
        .toBe(1);

      for (const [name, p] of [["A", pageA], ["B", pageB]] as const) {
        await expect(noticeIn(p, a), `window ${name} shows the notice`).toHaveCount(1, { timeout: 5_000 });
        expect(await p.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), `window ${name} was not reloaded`).toBe(true);
      }
    } finally {
      await devices.dispose();
      await deleteTopic(request, a).catch(() => {});
      await deleteTopic(request, b).catch(() => {});
    }
  });
});
