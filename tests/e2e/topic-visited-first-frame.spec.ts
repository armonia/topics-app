/**
 * TOPIC-FIRST-FRAME — a topic already visited opens on its messages without
 * waiting for the server.
 *
 * WHAT IT PINS. A chat read before keeps a local copy of its tail
 * (`messages-cache-*`, `shared/history-paging.ts`): the same rows the server's
 * first page holds. Reopening it (a reload, the app started again) must draw
 * those rows while the server's answer is still on its way: no skeleton held
 * for the length of a request, never an empty pane, no skeleton coming back
 * once the rows are there, and no row that moves.
 *
 * THE DEFECT, measured on this spec before the fix (2026-10-07, cloud VM,
 * 60 Hz headless): the curtain of `MessageList` waited for the history request
 * even with the local copy already in the store, so the pane drew 75 frames of
 * skeleton over rows that were ready - up to the curtain's hard cap (1200 ms)
 * whenever the server was slower than that. After: 15-16 frames, the steps of
 * Virtuoso mounting at the bottom behind its own hidden list plus the curtain's
 * two still frames, whatever the server does.
 *
 * WHAT THE EARLY REVEAL COSTS, measured here too: an answer that brings a
 * reply landed while the reader was away is a message arriving under their
 * eyes, and it enters at the bottom with nothing moving (CLS 0). A reply that
 * carries an image of unknown size grows when the image loads: CLS 0.034 on
 * that one case when the server is slower than the reveal (the report of the
 * track has the number and the follow-up).
 *
 * WHY THE SERVER IS HELD BACK. On a test machine the history answers in a few
 * milliseconds, so "the rows came from the device" and "the rows came from the
 * network, fast" would look the same. The tail request is held for `HOLD_MS`:
 * rows painted before it is released can only come from the local copy. Drop
 * the hydration from the cache and the pane waits for the answer behind its
 * skeleton - which is the red this spec exists to give.
 *
 * WHY FRAMES AND NOT MILLISECONDS. The suite runs on loaded machines, where a
 * frame can take 60 ms: a time budget would judge the machine. The skeleton
 * left is a count of Virtuoso's steps, which load does not add to; the one it
 * replaced was a count of milliseconds spent waiting for the network.
 *
 * THE PROBE reads each frame after its layout, through a ResizeObserver on a
 * sentinel resized in every rAF (the method of `tab-switch-instant.spec.ts`):
 * a rAF callback runs before the app's own observers, and would read the DOM of
 * the frame before.
 *
 * @covers TOPIC-FIRST-01
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { armObserver, buildReport, collectShifts, settledUntilQuiet, summarize, waitForLocalCopy } from "./helpers/cls-return";
import { beat, didascalia } from "./helpers/evidence";
import { wheelUpUntilVisible } from "./helpers/wheel-scroll";

hermetic(test);
test.use({ viewport: { width: 1280, height: 800 } });

/** A long thread, as the card asks: two hundred messages and more. */
const SEEDED = 220;
/** How long the tail request is held: longer than the curtain's hard cap (1200 ms). */
const HOLD_MS = 1500;
/**
 * Skeleton frames allowed before the rows. Measured 15-16 after the fix (two
 * runs) and 75 before it; the hard cap alone is 72 frames at 60 Hz, so a pane
 * waiting for the network again cannot fit under this.
 */
const SKELETON_CAP = 30;
/** Frames read after the rows first show, to catch a late jump or a skeleton coming back. */
const TAIL_FRAMES = 30;

function rowText(n: number): string {
  return `Visited row #${String(n).padStart(3, "0")}`;
}

/** The session key the server and the client agree on, asked rather than guessed. */
async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey`);
  return key;
}

/** Rows of uneven height, with tool rows: a list whose geometry has to be measured. */
async function seedThread(request: APIRequestContext, sessionKey: string): Promise<void> {
  for (let i = 1; i <= SEEDED; i++) {
    const assistant = i % 2 === 0;
    await seedMessage(request, {
      sessionKey,
      role: assistant ? "assistant" : "user",
      content: `${rowText(i)}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(i % 7 === 0 ? 9 : 2)}`,
      toolCalls: assistant && i % 4 === 0
        ? [{ id: `vff-${i}`, name: "Bash", args: { command: `ls /tmp/${i}` }, status: "success", result: `file-${i}.txt` }]
        : undefined,
    });
  }
}

/**
 * Rows of ~12 KB, sixty of them: a page of the server holds ~21, and the local
 * copy below is cut to 10, as a turn's end leaves it on rows this heavy. Merged
 * as is, the answer would PREPEND rows to a list already on screen, and
 * Virtuoso paints the wrong rows for one frame (measured: one empty frame in
 * the sequence, red 2 runs out of 2 without `rowsAboveLocalCopy`). Those rows
 * stay out as partial history instead.
 */
const HEAVY_SEEDED = 60;
const HEAVY_PROSE = "A reply as heavy as a real agentic turn, with paths and code quoted at length. ".repeat(150);
function heavyText(n: number): string {
  return `Heavy row #${String(n).padStart(3, "0")}`;
}
async function seedHeavyThread(request: APIRequestContext, key: string): Promise<void> {
  for (let i = 1; i <= HEAVY_SEEDED; i++) {
    await seedMessage(request, {
      sessionKey: key,
      role: i % 2 === 0 ? "assistant" : "user",
      content: `${heavyText(i)}. ${HEAVY_PROSE}`,
    });
  }
}

interface FrameReport {
  /**
   * One letter per frame from the first rAF of the document:
   *   -  the pane is not on the page yet
   *   .  the pane is there, with neither rows nor skeleton (an empty pane)
   *   S  the pane shows its skeleton or a spinner
   *   C  the pane shows the last message
   */
  seq: string;
  /** Wall clock (`Date.now()`) of the first frame with the last message. */
  firstContentWall: number | null;
  /** Movement of the last message after its first frame, in px. */
  rawJumpPx: number;
  trace: string[];
  done: boolean;
}

/** The per-frame meter, armed before any line of the app. */
async function armFirstFrameMeter(page: Page, paneKey: string, needle: string, tailFrames = TAIL_FRAMES): Promise<void> {
  await page.addInitScript(
    ({ key, text, tail }) => {
      const SPIN = '[data-testid="chat-skeleton"], .animate-spin';
      const shown = (el: Element): boolean => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          if (n.getAttribute("data-pane-visible") === "0") return false;
          const st = (n as HTMLElement).style;
          if (st && (st.display === "none" || st.visibility === "hidden")) return false;
        }
        return true;
      };
      const out: FrameReport = { seq: "", firstContentWall: null, rawJumpPx: 0, trace: [], done: false };
      (window as unknown as { __firstFrame: FrameReport }).__firstFrame = out;
      let firstTop: number | null = null;
      let firstContentAt: number | null = null;
      const sample = (frame: number): boolean => {
        const shell = document.querySelector(`[data-pane-shell="${CSS.escape(key)}"]`);
        let letter = "-";
        let top: number | null = null;
        if (shell) {
          letter = ".";
          let spin = false;
          for (const s of Array.from(shell.querySelectorAll(SPIN))) if (shown(s)) spin = true;
          const scroller = shell.querySelector('[data-testid="chat-message-list"]');
          const box = scroller?.getBoundingClientRect();
          let content: Element | null = null;
          for (const m of Array.from(shell.querySelectorAll('[data-testid="chat-message"]'))) {
            if (!(m.textContent ?? "").includes(text) || !shown(m)) continue;
            const r = m.getBoundingClientRect();
            // In the viewport of the list, not mounted in the overscan.
            if (box && r.bottom > box.top && r.top < box.bottom) content = m;
          }
          if (content && !spin) {
            letter = "C";
            top = content.getBoundingClientRect().top;
          } else if (spin) letter = "S";
        }
        out.seq += letter;
        if (top !== null) {
          if (firstTop === null) firstTop = top;
          else out.rawJumpPx = Math.max(out.rawJumpPx, Math.abs(top - firstTop));
          if (firstContentAt === null) {
            firstContentAt = frame;
            out.firstContentWall = Date.now();
          }
        }
        if (out.trace.length < 120 && letter !== "-") {
          const items = shell?.querySelector('[data-testid="virtuoso-item-list"]');
          const sc = shell?.querySelector('[data-testid="chat-message-list"]') as HTMLElement | null;
          const geometry = sc ? ` st=${Math.round(sc.scrollTop)}/${sc.scrollHeight}${items && (items as HTMLElement).style.visibility === "hidden" ? " hid" : ""}${sc.style.visibility === "hidden" ? " cur" : ""}` : "";
          out.trace.push(`${frame}${letter}:it=${items ? items.childElementCount : -1}${top !== null ? `@${top.toFixed(1)}` : ""}${geometry}`);
        }
        return firstContentAt !== null ? frame >= firstContentAt + tail : frame >= 900;
      };
      // An init script runs before the parser has built `<html>`: the sentinel
      // is attached on the first frame that has a document element to hold it.
      const sentinel = document.createElement("div");
      sentinel.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      let pending = 0;
      let finished = false;
      const readPending = () => {
        const frame = pending;
        pending = 0;
        if (frame && sample(frame)) {
          finished = true;
          observer.disconnect();
          sentinel.remove();
          out.done = true;
        }
      };
      const observer = new ResizeObserver(() => {
        if (!finished) readPending();
      });
      const tick = (frame: number) => {
        if (finished) return;
        readPending();
        if (finished) return;
        pending = frame;
        if (!sentinel.isConnected && document.documentElement) {
          document.documentElement.appendChild(sentinel);
          observer.observe(sentinel);
        }
        sentinel.style.width = `${(frame % 2) + 1}px`;
        requestAnimationFrame(() => tick(frame + 1));
      };
      requestAnimationFrame(() => tick(1));
    },
    { key: paneKey, text: needle, tail: tailFrames },
  );
}

/** Holds the TAIL request of one session (no `before`) for `ms`. */
async function holdTail(page: Page, sessionKey: string, ms: number): Promise<{ held: number; releasedAt: number | null }> {
  const probe = { held: 0, releasedAt: null as number | null };
  await page.route(`**/api/history/${encodeURIComponent(sessionKey)}*`, async (route) => {
    let body: { before?: string } = {};
    try {
      body = JSON.parse(route.request().postData() || "{}") as { before?: string };
    } catch {
      body = {};
    }
    if (!body.before) {
      probe.held += 1;
      await new Promise((r) => setTimeout(r, ms));
      probe.releasedAt ??= Date.now();
    }
    await route.continue();
  });
  return probe;
}

test.describe("Una topic gia' visitata si apre gia' pronta", () => {
  // The worker caches the shell, not the history; blocked so `page.route` sees
  // every history request (see the note in `chat-tail-first.spec.ts`).
  test.use({ serviceWorkers: "block" });

  let topic: { id: string; name: string };
  let other: { id: string; name: string };
  let heavy: { id: string; name: string };
  let sessionKey = "";
  let heavyKey = "";

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    topic = await createTopic(request, `visited-long-${stamp}`);
    other = await createTopic(request, `visited-other-${stamp}`);
    sessionKey = await sessionKeyOf(request, topic.id);
    await seedThread(request, sessionKey);
    heavy = await createTopic(request, `visited-heavy-${stamp}`);
    heavyKey = await sessionKeyOf(request, heavy.id);
    await seedHeavyThread(request, heavyKey);
    await seedMessage(request, { sessionKey: await sessionKeyOf(request, other.id), role: "user", content: "The other tab" });
  });

  test.afterAll(async ({ request }) => {
    for (const t of [topic, other, heavy]) if (t) await deleteTopic(request, t.id).catch(() => {});
  });

  test("al ricarico i messaggi arrivano dalla copia locale, senza aspettare il server", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-FIRST-01" });
    test.setTimeout(120_000);
    await resetPaneStore(request, [topic.id, other.id]);
    const last = rowText(SEEDED);
    const lastRow = page.locator(`[data-pane-shell="${topic.id}"] [data-testid="chat-message"]`).filter({ hasText: last });

    // 1) The visit: the chat is read to its last message, and its tail is
    //    written to the device.
    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), topic.id);
    await page.goto("/");
    await page.getByTestId(`pane-tab-${topic.id}`).click();
    await expect(lastRow).toBeVisible({ timeout: 20_000 });
    await waitForLocalCopy(page, "messages-cache-", last);
    await didascalia(page, `Topic da ${SEEDED} messaggi, gia' letta: ora la riapro`);
    await beat(page, 1200);

    // 2) The return, with the server slow on purpose.
    await armFirstFrameMeter(page, topic.id, last);
    const probe = await holdTail(page, sessionKey, HOLD_MS);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __firstFrame?: FrameReport }).__firstFrame?.done === true, null, { timeout: 30_000 });
    const r = (await page.evaluate(() => (window as unknown as { __firstFrame: FrameReport }).__firstFrame)) as FrameReport;
    const painted = r.seq.replace(/^-+/, "");
    const detail = `seq=${r.seq} trace=${r.trace.join(" ")} held=${probe.held}`;
    console.log(`[topic-first-frame] ${detail} jump=${r.rawJumpPx.toFixed(2)}px`);
    await didascalia(page, "Riaperta: i messaggi ci sono subito, il server non e' ancora arrivato");
    await beat(page, 1500);

    expect(probe.held, "the tail request was never made, so nothing was held").toBeGreaterThan(0);
    expect(painted[0], `the pane never paints empty: skeleton or rows from its first frame. ${detail}`).not.toBe(".");
    expect(painted, `skeleton, then the rows, and nothing else after them. ${detail}`).toMatch(/^S*C+$/);
    const skeleton = painted.match(/^S*/)![0].length;
    expect(skeleton, `the rows of the local copy do not wait for the network. ${detail}`).toBeLessThanOrEqual(SKELETON_CAP);
    expect(r.rawJumpPx, `the last message does not move once it is on screen. ${detail}`).toBeLessThan(1);

    // The held answer lands and confirms the rows on screen: they were on
    // screen before it, and they do not move when it arrives.
    const topOf = () => lastRow.evaluate((el) => el.getBoundingClientRect().top);
    const before = await topOf();
    await expect.poll(() => probe.releasedAt, { timeout: 10_000 }).not.toBeNull();
    expect(r.firstContentWall, `the rows were painted before the server answered. ${detail}`).not.toBeNull();
    expect(r.firstContentWall!, `the rows were painted before the server answered. ${detail}`).toBeLessThan(probe.releasedAt!);
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(lastRow).toBeVisible({ timeout: 10_000 });
    expect(Math.abs((await topOf()) - before), `the answer moved the rows already on screen. ${detail}`).toBeLessThan(1);
  });

  test("una copia locale piu' corta della pagina: la risposta non antepone righe sotto gli occhi", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-FIRST-01" });
    test.setTimeout(120_000);
    await resetPaneStore(request, [heavy.id, other.id]);
    const last = heavyText(HEAVY_SEEDED);
    const lastRow = page.locator(`[data-pane-shell="${heavy.id}"] [data-testid="chat-message"]`).filter({ hasText: last });

    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), heavy.id);
    await page.goto("/");
    await page.getByTestId(`pane-tab-${heavy.id}`).click();
    await expect(lastRow).toBeVisible({ timeout: 20_000 });
    await waitForLocalCopy(page, "messages-cache-", last);
    // The copy as the end of a turn leaves it: `cacheMessages` halves the
    // WHOLE list it is given until it fits, which on rows this heavy is a tail
    // shorter than the server's page. Written here so the case is not left to
    // the arithmetic of two byte budgets.
    const cached = await page.evaluate((key) => {
      const k = `messages-cache-${key}`;
      const rows = JSON.parse(localStorage.getItem(k) || "[]") as unknown[];
      const tail = rows.slice(-10);
      localStorage.setItem(k, JSON.stringify(tail));
      return tail.length;
    }, heavyKey);

    // Frames read well past the release of the held answer (90 frames at 60 Hz).
    await armFirstFrameMeter(page, heavy.id, last, 150);
    const probe = await holdTail(page, heavyKey, HOLD_MS);
    let pageRows = 0;
    page.on("response", async (res) => {
      if (!res.url().includes(`/api/history/${encodeURIComponent(heavyKey)}`)) return;
      try {
        const body = (await res.json()) as { messages?: unknown[] };
        pageRows = Math.max(pageRows, body.messages?.length ?? 0);
      } catch {
        /* not the JSON answer */
      }
    });
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __firstFrame?: FrameReport }).__firstFrame?.done === true, null, { timeout: 30_000 });
    const r = (await page.evaluate(() => (window as unknown as { __firstFrame: FrameReport }).__firstFrame)) as FrameReport;
    await expect.poll(() => probe.releasedAt, { timeout: 10_000 }).not.toBeNull();
    await expect.poll(() => pageRows, { timeout: 10_000 }).toBeGreaterThan(0);
    const painted = r.seq.replace(/^-+/, "");
    const detail = `cached=${cached} page=${pageRows} seq=${r.seq} trace=${r.trace.join(" ")}`;
    console.log(`[topic-first-frame:heavy] ${detail} jump=${r.rawJumpPx.toFixed(2)}px`);

    // The premise: the copy really is shorter than the page.
    expect(cached, `the local copy is a halved tail. ${detail}`).toBeLessThan(pageRows);
    expect(r.firstContentWall!, `the rows were painted before the server answered. ${detail}`).toBeLessThan(probe.releasedAt!);
    expect(painted, `skeleton, then the rows, and nothing else after them. ${detail}`).toMatch(/^S*C+$/);
    expect(r.rawJumpPx, `the answer did not move the view. ${detail}`).toBeLessThan(1);
    // The rows above the copy are history still to come, not rows lost.
    await expect(page.locator(`[data-pane-shell="${heavy.id}"] [data-testid="chat-message-list"]`)).toHaveAttribute("data-history", "partial");
  });

  test("una risposta arrivata mentre ero via entra in fondo senza spostare niente", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-FIRST-01" });
    test.setTimeout(120_000);
    const away = await createTopic(request, `visited-away-${Date.now()}`);
    const awayKey = await sessionKeyOf(request, away.id);
    try {
      for (let i = 1; i <= 30; i++) {
        await seedMessage(request, { sessionKey: awayKey, role: i % 2 ? "user" : "assistant", content: `Away row #${i}. ${"Lorem ipsum dolor sit amet. ".repeat(i % 5 === 0 ? 8 : 2)}` });
      }
      await resetPaneStore(request, [away.id, other.id]);
      const shell = page.locator(`[data-pane-shell="${away.id}"]`);
      await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
      await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), away.id);
      await page.goto("/");
      await page.getByTestId(`pane-tab-${away.id}`).click();
      await expect(shell.locator('[data-testid="chat-message"]').filter({ hasText: "Away row #30." })).toBeVisible({ timeout: 20_000 });
      await waitForLocalCopy(page, "messages-cache-", "Away row #30.");

      // The reply the local copy does not have. Text only: with an image of
      // unknown size the reply grows when it loads (CLS 0.034 measured, see
      // the header), which is a property of images without a box, not of the
      // reveal.
      await seedMessage(request, {
        sessionKey: awayKey,
        role: "assistant",
        content: `AWAY-REPLY: the agent finished while you were away.\n\nThe table is where you expected it, and the tests are green.`,
      });
      await armObserver(page);
      const probe = await holdTail(page, awayKey, HOLD_MS);
      await page.reload();
      const reply = shell.locator('[data-testid="chat-message"]').filter({ hasText: "AWAY-REPLY" });
      await expect(reply).toBeVisible({ timeout: 20_000 });
      await settledUntilQuiet(page, { quietMs: 1500, timeout: 30_000 });
      const report = buildReport(await collectShifts(page));
      console.log(`[topic-first-frame:away] held=${probe.held} CLS=${report.cls.toFixed(4)} shifts=${report.count}\n${summarize(report)}`);
      expect(probe.held, "the tail request was never held").toBeGreaterThan(0);
      expect(report.cls, `who moved:\n${summarize(report)}`).toBeLessThanOrEqual(0.01);
      // At the bottom, on the reply.
      const list = shell.locator('[data-testid="chat-message-list"]');
      await expect.poll(() => list.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    } finally {
      await deleteTopic(request, away.id).catch(() => {});
    }
  });

  test("una riga arrivata via WS a una chat mai letta non e' la copia locale: la pagina arriva intera", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-FIRST-01" });
    test.setTimeout(120_000);
    const fresh = await createTopic(request, `visited-fresh-${Date.now()}`);
    const freshKey = await sessionKeyOf(request, fresh.id);
    try {
      for (let i = 1; i <= 30; i++) {
        await seedMessage(request, { sessionKey: freshKey, role: i % 2 ? "user" : "assistant", content: `Fresh row #${i}.` });
      }
      const res = await request.post(`${E2E_BASE}/api/history/${encodeURIComponent(freshKey)}`, { data: { limit: 40 } });
      const rows = ((await res.json()) as { messages: Array<{ id: string; role: string; content: string }> }).messages;
      const lastRow = rows[rows.length - 1];
      // Not among the open tabs: nothing reads this chat at boot.
      await resetPaneStore(request, [other.id]);
      const ws = await interceptWebSocket(page);
      await page.goto("/");
      await expect(page.getByText("The other tab").first()).toBeVisible({ timeout: 20_000 });
      // One row of this chat reaches the store over the socket, before anyone
      // opened it: rows in the store, and none of them the local copy.
      ws.send({ type: "message:new", topicId: fresh.id, sessionKey: freshKey, role: lastRow.role, messageId: lastRow.id, content: lastRow.content });

      const palette = page.getByTestId("command-palette");
      await page.keyboard.press("Meta+k");
      await expect(palette).toBeVisible();
      await page.keyboard.type(fresh.name);
      await expect(palette).toContainText(fresh.name);
      await page.keyboard.press("Enter");
      const shell = page.locator(`[data-pane-shell="${fresh.id}"]`);
      await expect(shell.locator('[data-testid="chat-message"]').filter({ hasText: "Fresh row #30." })).toBeVisible({ timeout: 20_000 });
      // The page came whole (30 rows, under a page): nothing was cut above
      // the row the socket brought, as it would be if that row were the copy.
      await expect(shell.locator('[data-testid="chat-message-list"]')).toHaveAttribute("data-history", "complete", { timeout: 10_000 });
      await expect(shell.getByTestId("chat-load-older")).toHaveCount(0);
    } finally {
      await deleteTopic(request, fresh.id).catch(() => {});
    }
  });

  test("evidenza: riapro la topic lunga, salgo fino in cima, seguo un turno in streaming", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-FIRST-01" });
    test.setTimeout(180_000);
    await resetPaneStore(request, [topic.id, other.id]);
    const shell = page.locator(`[data-pane-shell="${topic.id}"]`);
    const rowOf = (n: number) => shell.locator('[data-testid="chat-message"]').filter({ hasText: rowText(n) });
    const ws = await interceptWebSocket(page);

    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), topic.id);
    await page.goto("/");
    await page.getByTestId(`pane-tab-${topic.id}`).click();
    await expect(rowOf(SEEDED)).toBeVisible({ timeout: 20_000 });
    await waitForLocalCopy(page, "messages-cache-", rowText(SEEDED));

    // Reopened from the device's copy.
    await page.reload();
    await expect(rowOf(SEEDED)).toBeVisible({ timeout: 20_000 });
    await didascalia(page, `Riaperta la topic da ${SEEDED} messaggi`);
    await beat(page, 1500);

    // The rest of the thread arrives behind another tab; back, and up to the top.
    await page.getByTestId(`pane-tab-${other.id}`).click();
    await expect(page.getByText("The other tab").first()).toBeVisible({ timeout: 15_000 });
    await expect(shell.locator('[data-testid="chat-message-list"]')).toHaveAttribute("data-history", "complete", { timeout: 20_000 });
    await page.getByTestId(`pane-tab-${topic.id}`).click();
    await expect(rowOf(SEEDED)).toBeVisible({ timeout: 15_000 });
    await didascalia(page, "Scorro fino al primo messaggio");
    await wheelUpUntilVisible(page, rowOf(1), 200, `[data-pane-shell="${topic.id}"] [data-testid="chat-message-list"]`);
    await beat(page, 1500);

    // Back to the bottom, and a turn streams in.
    await shell.getByTestId("scroll-to-bottom").click();
    await expect(rowOf(SEEDED)).toBeVisible({ timeout: 15_000 });
    const messageId = `vff-stream-${Date.now()}`;
    const frame = { sessionKey, topicId: topic.id };
    ws.send({ type: "stream:start", ...frame, messageId });
    await didascalia(page, "Un turno in streaming: la vista resta in fondo, niente salti");
    const list = shell.locator('[data-testid="chat-message-list"]');
    const distanceFromBottom = () => list.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    for (let i = 0; i < 24; i++) {
      ws.send({ type: "stream:content_chunk", ...frame, content: `Streamed line ${i}: ${"words that wrap across the column ".repeat(3)}\n\n` });
      // Every chunk lands, and the view follows it to the bottom.
      await expect(shell.getByText(`Streamed line ${i}:`)).toBeVisible({ timeout: 10_000 });
      await expect.poll(distanceFromBottom, { timeout: 10_000 }).toBeLessThanOrEqual(2);
    }
    ws.send({ type: "stream:content_chunk", ...frame, content: "STREAM-END" });
    const reply = shell.locator('[data-testid="chat-message"]').filter({ hasText: "STREAM-END" });
    await expect(reply).toBeVisible({ timeout: 10_000 });
    ws.send({ type: "stream:end", ...frame, messageId });
    // Pinned at the bottom while it streamed: the end of the reply is in view.
    await expect.poll(distanceFromBottom, { timeout: 10_000 }).toBeLessThanOrEqual(2);
    await beat(page, 1500);
  });
});
