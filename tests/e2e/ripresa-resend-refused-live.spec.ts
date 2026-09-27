/**
 * A RESEND THE CHAT ROUTE REFUSED REACHES THE WINDOWS OPEN ON THE CHAT, WITHOUT
 * A RELOAD (card edf3c4db).
 *
 * The resume sweep writes its trace on the cut row, then resends the message
 * through the chat route. When the route refuses (503 `provider_unavailable`:
 * here the topic is pinned to a provider this server does not have) nothing
 * starts, and no frame told the windows that the row had changed: they kept it
 * as it was until a reload. Now the sweep announces the thread and the windows
 * read it again.
 *
 * The rows are written after both windows have loaded the chat, so the only
 * way into a window is that announcement. Window B is hidden while the sweep
 * writes, the variant the card asks for, and shown again only afterwards. The
 * trace sits after the row's verdict: no answer was redone, so neither window
 * may draw "this is the redone answer" on it.
 *
 * The sweep is woken as in `ripresa-capped-live.spec.ts`: a stale stream on
 * another chat, closed by the stale tick with its silence threshold cut to 1 s.
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

const CUT_TEXT = "stavo misurando";

type Row = { content: string; blocks?: Array<{ kind: string; text?: string }> };

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

async function sessionRow(request: APIRequestContext, topicId: string, role: "user" | "assistant", content: string, blocks?: unknown[]) {
  const res = await request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, { data: { role, content, ...(blocks ? { blocks } : {}) } });
  expect(res.ok()).toBe(true);
}

async function rowsOf(request: APIRequestContext, topicId: string): Promise<Row[]> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics/${topicId}/messages?limit=10`)).json()) as { messages: Row[] };
  return body.messages;
}

/** The page believes it is hidden, as a window behind another one is. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

const panelOf = (page: Page, topicId: string) =>
  page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`);

test.describe("a resend the chat route refused, with the chat open in two windows", () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
  });

  test("both windows show the traced row, the hidden one too, with no reload", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "RESUME-02" });
    // A spent usage window holds every sweep, in silence.
    expect((await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { clear: true } })).ok()).toBe(true);
    // Pinned to a provider nobody registered: the resend gets a 503.
    const a = (await createTopic(request, "Refused resume", { provider: "absent-provider" })).id;
    const b = (await createTopic(request, "Refused nudge")).id;
    const devices = await openTwoDevices(browser, { seed: (r) => resetPaneStore(r, [a]) });
    try {
      const { pageA, pageB } = devices;
      for (const p of [pageA, pageB]) {
        await expect(panelOf(p, a)).toBeVisible({ timeout: 20_000 });
        await p.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      }
      await setHidden(pageB, true);

      // A turn the watchdog cut, first time: the sweep resends it.
      await sessionRow(request, a, "user", "misura la ripresa");
      await sessionRow(request, a, "assistant", "", [
        { kind: "text", text: CUT_TEXT },
        { kind: "error", text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.", cause: "watchdog" },
      ]);
      // The wake-up: a stream on another chat that the stale tick closes.
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      expect((await request.post(`${E2E_BASE}/api/test/streams/partial`, { data: { sessionKey: await sessionKeyOf(request, b) } })).ok()).toBe(true);

      // The sweep traced the row and the route refused the resend: the cut row
      // is still the chat's last. A red below can only mean "changed and not
      // shown".
      await expect
        .poll(async () => {
          const last = (await rowsOf(request, a)).at(-1);
          return {
            lastIsCut: last?.blocks?.some((bl) => bl.kind === "text" && bl.text === CUT_TEXT) ?? false,
            traced: last?.blocks?.some((bl) => bl.kind === "ripreso") ?? false,
          };
        }, { timeout: 90_000, intervals: [500], message: "the sweep traces the cut row and its resend is refused" })
        .toEqual({ lastIsCut: true, traced: true });

      const cutRow = (p: Page) => panelOf(p, a).locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: CUT_TEXT });
      await expect(cutRow(pageA), "window A shows the row").toHaveCount(1, { timeout: 5_000 });
      // Hidden when the row changed: it has it the moment it is shown again.
      await setHidden(pageB, false);
      await expect(cutRow(pageB), "window B, hidden at write time, shows the row").toHaveCount(1, { timeout: 1_000 });
      for (const [name, p] of [["A", pageA], ["B", pageB]] as const) {
        // The sweep's trace is not a redone answer.
        await expect(panelOf(p, a).locator('[data-testid="ripreso-banner"]'), `window ${name} claims no redone answer`).toHaveCount(0);
        expect(await p.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), `window ${name} was not reloaded`).toBe(true);
      }
    } finally {
      await devices.dispose();
      await deleteTopic(request, a).catch(() => {});
      await deleteTopic(request, b).catch(() => {});
    }
  });
});
