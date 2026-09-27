/**
 * A RESEND THE CHAT ROUTE REFUSED, WITH THE CHAT OPEN IN TWO WINDOWS (card
 * edf3c4db).
 *
 * The chat's last row is the restart notice the boot writes, which asks for
 * Retry, already on screen in both windows as in production. The resume sweep
 * traces that notice and resends the message; the route refuses (503
 * `provider_unavailable`: the topic is pinned to a provider this server does
 * not have) and nothing starts. On main:
 *
 * - no frame told the windows the row had changed, so neither read it again;
 * - a window that did read it (any reload) lost Retry, because the trace counted
 *   as work, on the one notice that asks for it and with nothing resent;
 * - and it drew "this is the redone answer" on a row nothing redid.
 *
 * Here both windows read the traced row again within 1 s of the write, window B
 * while hidden, and both keep Retry with no redone-answer banner; a reload
 * shows the same.
 *
 * WHAT TELLS BASE FROM THIS BRANCH IN A LIVE WINDOW is the read, not the DOM,
 * and that is by design: the trace is not drawn (it is the sweep's, not a
 * redone answer) and does not take Retry, so a window that read it and one
 * that did not look the same. The frame keeps each window's copy of the row
 * equal to what a reload reads. The read is counted on the network, with the
 * time it landed; what the person sees differs after the reload, where base
 * took Retry away and drew the banner. The checks from the reads on are soft,
 * so a red on base names every one of those differences, not only the first.
 *
 * Window B is hidden the way the repo hides one (`idle-frame-budget.spec.ts`):
 * under Playwright a page in front stays `visible`, and the client reads
 * `document.hidden`, so that is what is overridden. WKWebView's own throttling
 * of a window behind another is not reproduced.
 *
 * The sweep is woken as in `ripresa-capped-live.spec.ts`: a stale stream on
 * another chat, closed by the stale tick with its silence threshold cut to 1 s.
 *
 * Both windows are filmed (`recordVideo`: the `video` of `test.use` films only
 * the fixture's own page), and the two clips are attached to the result.
 *
 * The other half of the card, the end of a boot reattach leg, has no spec: that
 * `.finally` runs only when a broker child survived a restart, which the test
 * server never has. It is covered by `server/lib/turno-troncato.test.ts` (the
 * helper, and the server.ts wiring read from the source),
 * `client/src/hooks/usePanelLifecycle.threadChanged.test.ts` (the app's pane
 * lifecycle turns the frame into a fresh read) and
 * `client/src/hooks/useChatThreadChanged.test.ts` (that read past the dedup).
 *
 * @covers RESUME-02
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { openTwoDevices } from "./helpers/multi-client";

hermetic(test);
test.describe.configure({ timeout: 180_000 });

/** The boot's own restart notice (`RESTART_INTERRUPTED_MARKER`), which the resume recognises. */
const NOTICE = "⚠️ Turno interrotto da un riavvio del server. Il messaggio che hai inviato e' ancora qui: premi Riprova per inviarlo di nuovo.";

type Row = { id: string; role: string; blocks?: Array<{ kind: string }> };

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

const traced = (row: Row | undefined) => row?.blocks?.some((b) => b.kind === "ripreso") ?? false;

/** The page believes it is hidden, as a window behind another one is. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** When this window first read the chat back with the trace on its last row (0: never). */
function watchTracedReads(page: Page, sessionKey: string): { at: number } {
  const seen = { at: 0 };
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  page.on("response", async (res) => {
    const landed = Date.now();
    if (new URL(res.url()).pathname !== path || !res.ok()) return;
    const body = (await res.json().catch(() => null)) as { messages?: Row[] } | null;
    if (traced(body?.messages?.at(-1)) && !seen.at) seen.at = landed;
  });
  return seen;
}

/** How often the database is read for the trace: the write is at most this much before it is seen. */
const POLL_MS = 100;

const panelOf = (page: Page, topicId: string) =>
  page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`);
const noticeOf = (page: Page, topicId: string, id: string) =>
  panelOf(page, topicId).locator(`[data-testid="chat-message"][data-message-id="${id}"]`);

test.describe("a resend the chat route refused, with the chat open in two windows", () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
  });

  test("both windows read the traced notice, the hidden one too, and keep its Retry", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "RESUME-02" });
    // A spent usage window holds every sweep, in silence.
    expect((await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { clear: true } })).ok()).toBe(true);
    // Pinned to a provider nobody registered: the route refuses the resend.
    const a = (await createTopic(request, "Refused resume", { provider: "absent-provider" })).id;
    const b = (await createTopic(request, "Refused nudge")).id;
    const sk = await sessionKeyOf(request, a);
    // The rows come first, as in production: the notice is on screen before the sweep.
    await sessionRow(request, a, "user", "misura la ripresa");
    await sessionRow(request, a, "assistant", NOTICE, [{ kind: "error", text: NOTICE }]);
    const noticeId = (await rowsOf(request, a)).at(-1)!.id;

    const devices = await openTwoDevices(browser, {
      seed: (r) => resetPaneStore(r, [a]),
      contextOptions: { recordVideo: { dir: test.info().outputPath("videos") } },
    });
    try {
      const { pageA, pageB } = devices;
      const pages = [["A", pageA], ["B", pageB]] as const;
      for (const [name, p] of pages) {
        await expect(noticeOf(p, a, noticeId).locator('[data-testid="message-retry"]'), `window ${name} offers Retry on the notice`).toBeVisible({ timeout: 20_000 });
        await p.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      }
      const reads = { A: watchTracedReads(pageA, sk), B: watchTracedReads(pageB, sk) };
      await setHidden(pageB, true);

      // The wake-up: a stream on another chat that the stale tick closes.
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      expect((await request.post(`${E2E_BASE}/api/test/streams/partial`, { data: { sessionKey: await sessionKeyOf(request, b) } })).ok()).toBe(true);

      // The sweep traced the notice and the route refused the resend: the
      // notice is still the chat's last row. `seenAt` is when the trace was
      // first seen, at most POLL_MS after it was written.
      let seenAt = 0;
      await expect
        .poll(async () => {
          const last = (await rowsOf(request, a)).at(-1);
          const state = { lastIsNotice: last?.id === noticeId, traced: traced(last) };
          if (state.lastIsNotice && state.traced && !seenAt) seenAt = Date.now();
          return state;
        }, { timeout: 90_000, intervals: [POLL_MS], message: "the sweep traces the notice and its resend is refused" })
        .toEqual({ lastIsNotice: true, traced: true });

      // Each window read the row again with its trace, B while hidden, within
      // 1 s of the write. Waited for longer, so a red says "never" or "late".
      const soft = expect.configure({ soft: true });
      for (const [name] of pages) {
        await soft.poll(() => reads[name].at, { timeout: 5_000, message: `window ${name} reads the traced row` }).toBeGreaterThan(0);
        soft(reads[name].at - seenAt, `window ${name} reads it within 1 s of the write`).toBeLessThanOrEqual(1_000 - POLL_MS);
      }
      await setHidden(pageB, false);
      for (const [name, p] of pages) {
        // Guards, not the proof (see the header): nothing was resent, so the
        // notice keeps the Retry it asks for, and it is not "the redone answer".
        await soft(noticeOf(p, a, noticeId).locator('[data-testid="message-retry"]'), `window ${name} keeps Retry`).toBeVisible({ timeout: 1_000 });
        await soft(panelOf(p, a).locator('[data-testid="ripreso-banner"]'), `window ${name} claims no redone answer`).toHaveCount(0);
        soft(await p.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), `window ${name} was not reloaded`).toBe(true);
      }

      // A reload reads the same row: the same Retry, the same missing banner.
      // On base this is where the DOM differs: the trace took Retry away and
      // drew the banner.
      await pageA.reload();
      await expect(noticeOf(pageA, a, noticeId), "after a reload, the notice is there").toBeVisible({ timeout: 20_000 });
      await soft(noticeOf(pageA, a, noticeId).locator('[data-testid="message-retry"]'), "after a reload, Retry is there").toBeVisible({ timeout: 5_000 });
      await soft(panelOf(pageA, a).locator('[data-testid="ripreso-banner"]'), "after a reload, no redone answer").toHaveCount(0);
    } finally {
      await devices.dispose();
      // Final once the contexts are closed.
      for (const [name, p] of [["A", devices.pageA], ["B", devices.pageB]] as const) {
        const clip = await p.video()?.path().catch(() => null);
        if (clip) await test.info().attach(`window ${name}`, { path: clip, contentType: "video/webm" });
      }
      await deleteTopic(request, a).catch(() => {});
      await deleteTopic(request, b).catch(() => {});
    }
  });
});
