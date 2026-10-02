import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { seedMessage, type SeedToolCall } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE TRANSCRIPT NEVER LANDS WITH A JUMP.
 *
 * The owner's ask (30/09): "every single UI handled at the top, fluidity and
 * animation too ... no strange useless jerks ... handle loading and skeletons
 * well". The UI audit of 29/09 measured five places where the chat transcript
 * moved in one frame, or moved and came back:
 *
 *   F03  each wrapped line of a streamed reply: the list re-pinned one or two
 *        frames late, so the bottom bounced by a line (20-36 px);
 *   F02  a running tool auto-opened its live body (+35/+34 px) and collapsed it
 *        at completion (-69 px), each in one frame, and a pinned list turned
 *        every step into a lurch of the whole conversation;
 *   F09  a click on a finished tool row near the bottom: +266 px at once, then
 *        the whole column -266 px 33-43 ms later when the bottom re-pinned;
 *   F07  a cold open painted a bottom-anchored skeleton for a short chat that
 *        lands at the top (about 350 px apart), and remounted the skeleton;
 *   F3   the phone chat switch: skeleton on a chat already loaded, history
 *        replaying the entrance of a new message, a jump on return.
 *
 * Measured, not eyeballed: an init script samples, at the last moment before
 * every paint (see `sample` below for why that moment), the chat scroller's
 * geometry and the boxes the test names, transforms and opacity included. Each test below states its contract on those
 * samples, and writes them next to the video.
 *
 * @covers CHAT-01
 */
test.use({ video: "on", contextOptions: { reducedMotion: "no-preference" } });

type Box = { y: number; h: number; o: number; id: number } | null;
type Frame = {
  t: number;
  /** The visible chat scroller: scrollTop, scrollHeight, clientHeight. */
  st: number;
  sh: number;
  ch: number;
  boxes: Record<string, Box>;
  /** The skeleton's node and its first bubble, when one is on screen. */
  skel: { id: number; y: number } | null;
  /** The first message row on screen. */
  first: Box;
  /** Running `messageSlideIn` animations inside the visible pane. */
  entrances: number;
};
type Probe = { frames: Frame[]; running: boolean; track: Record<string, string> };

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const nodeId = (el: Element) => {
      let id = ids.get(el);
      if (id === undefined) { id = next++; ids.set(el, id); }
      return id;
    };
    const p: Probe = { frames: [], running: false, track: {} };
    (window as unknown as { __tm: Probe }).__tm = p;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return Math.round(o * 1000) / 1000;
    };
    const box = (el: Element | null | undefined): Box => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { y: r1(r.y), h: r1(r.height), o: opacityOf(el), id: nodeId(el) };
    };
    /** The chat pane on screen: the one whose composer has a box. */
    const visiblePane = (): Element | null => {
      for (const area of document.querySelectorAll('[data-testid="chat-input-area"]')) {
        const r = area.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && area.checkVisibility() && area.parentElement) return area.parentElement;
      }
      return null;
    };
    const sample = () => {
      {
        const root = visiblePane();
        const sc = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? null;
        const boxes: Record<string, Box> = {};
        // `msg:<text>` names the message row that contains <text>.
        const pick = (sel: string) => sel.startsWith("msg:")
          ? [...(root?.querySelectorAll('[data-testid="chat-message"]') ?? [])].find((m) => (m.textContent ?? "").includes(sel.slice(4)))
          : root?.querySelector(sel);
        for (const [name, sel] of Object.entries(p.track)) boxes[name] = box(pick(sel));
        const skelEl = root?.querySelector('[data-testid="chat-skeleton"]');
        const skelBubble = skelEl?.querySelector(".animate-pulse > div") ?? null;
        const skelShown = !!skelEl && skelEl.getBoundingClientRect().height > 0 && skelEl.checkVisibility();
        const rows = root ? [...root.querySelectorAll('[data-testid="chat-message"]')] : [];
        const scBox = sc?.getBoundingClientRect();
        const onScreen = rows.filter((m) => {
          const r = m.getBoundingClientRect();
          return scBox && r.height > 0 && r.bottom > scBox.top && r.top < scBox.bottom && m.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
        });
        let entrances = 0;
        for (const a of document.getAnimations()) {
          const target = (a.effect as KeyframeEffect | null)?.target;
          if (a.playState === "running" && (a as CSSAnimation).animationName === "messageSlideIn" && target && root?.contains(target)) entrances += 1;
        }
        p.frames.push({
          t: performance.now(),
          st: sc ? r1(sc.scrollTop) : -1,
          sh: sc ? sc.scrollHeight : -1,
          ch: sc ? sc.clientHeight : -1,
          boxes,
          skel: skelShown && skelBubble ? { id: nodeId(skelEl!), y: r1(skelBubble.getBoundingClientRect().y) } : null,
          first: box(onScreen[0]),
          entrances,
        });
      }
    };
    /**
     * WHEN a frame is sampled decides what the samples mean. A task posted
     * from the animation frame runs after the paint, but a task the app queued
     * earlier (a React render scheduled from a socket message) runs BEFORE it,
     * and the sample then reads a DOM that was never painted. So the sample is
     * taken in a ResizeObserver callback instead: every frame the probe
     * resizes a 1px marker in its animation frame, and its observer, created
     * after the app's own (callbacks run in creation order), is the last code
     * that runs after layout and before the paint. What it reads is what the
     * reader sees, transforms of running animations included.
     */
    let marker: HTMLElement | null = null;
    let wide = false;
    const tick = () => {
      if (p.running && marker) {
        wide = !wide;
        marker.style.width = wide ? "2px" : "1px";
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __tmArm: () => void }).__tmArm = () => {
      if (marker) return;
      marker = document.createElement("div");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(marker);
      new ResizeObserver(() => { if (p.running) sample(); }).observe(marker);
    };
  });
}

async function startProbe(page: Page, track: Record<string, string>) {
  await page.evaluate((tr) => {
    const p = (window as unknown as { __tm: Probe }).__tm;
    p.frames = []; p.track = tr; p.running = true;
    (window as unknown as { __tmArm: () => void }).__tmArm();
  }, track);
}

/** Lets `n` more frames be sampled: the tail where a late jump would show. */
async function moreFrames(page: Page, n: number) {
  const have = await page.evaluate(() => (window as unknown as { __tm: Probe }).__tm.frames.length);
  await page.waitForFunction((k) => (window as unknown as { __tm: Probe }).__tm.frames.length >= k, have + n);
}

async function stopProbe(page: Page, testInfo: TestInfo, name: string): Promise<Frame[]> {
  const frames = await page.evaluate(() => {
    const p = (window as unknown as { __tm: Probe }).__tm;
    p.running = false;
    return JSON.parse(JSON.stringify(p.frames)) as Frame[];
  });
  const path = testInfo.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(frames));
  await testInfo.attach(`${name}.json`, { path });
  return frames;
}

const residual = (f: Frame) => f.sh - f.st - f.ch;

/**
 * The largest share of a travel one painted frame may carry, given how long
 * that frame took. An animation cannot outrun its curve: `EASE.standard` over
 * `MOTION.base` (240 ms) covers at most ~4x its average speed, so a 16 ms frame
 * may carry ~27% of the way. The floor of 60% keeps a short, busy frame from
 * failing the test; a frame that took far longer (the main thread busy for
 * 130 ms, measured on this Mac under load) may carry more, because the curve
 * did. A jump is a frame of normal length that carries all of it: 100% in 16 ms
 * was the audit's number.
 */
function stepShare(dtMs: number): number {
  return Math.min(1, Math.max(0.6, (4.5 * dtMs) / 240));
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((x) => x.id === topicId)!.sessionKey;
}

/** A chat long enough to scroll, ending on `endMarker`. */
async function seedChat(
  request: APIRequestContext,
  name: string,
  count: number,
  endMarker: string,
  lastTools?: SeedToolCall[],
) {
  const t = await createTopic(request, name);
  const sessionKey = await sessionKeyOf(request, t.id);
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    await seedMessage(request, {
      sessionKey,
      role: i % 2 === 1 ? "assistant" : "user",
      content: last ? `${endMarker} final line` : `Row ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(i % 5 === 0 ? 6 : 2)}`,
      toolCalls: last ? lastTools : undefined,
    });
  }
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, sessionKey, name };
}

/** Opens `topicId` alone and waits until its bottom has been still for 20 frames. */
async function openAtRest(page: Page, request: APIRequestContext, topicId: string, needle: string) {
  await resetPaneStore(request, [topicId]);
  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), topicId);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="chat-message"]').filter({ hasText: needle }).first()).toBeVisible({ timeout: 20_000 });
  await startProbe(page, {});
  await page.waitForFunction(() => {
    const f = (window as unknown as { __tm: Probe }).__tm.frames.slice(-20);
    return f.length === 20 && f.every((x) => x.st === f[0]!.st && x.sh === f[0]!.sh && x.sh - x.st - x.ch <= 1);
  }, null, { timeout: 20_000 });
}

const composer = (page: Page) => page.locator('[data-testid="chat-input-area"]:visible [data-testid="chat-message-input"]').first();

test.describe("transcript motion", () => {
  test.describe.configure({ timeout: 120_000 });
  let removeCli: (() => void) | null = null;
  const created: string[] = [];

  test.beforeAll(() => {
    removeCli = installSlowTurnCli();
  });
  test.afterAll(async ({ request }) => {
    removeCli?.();
    for (const id of created) await deleteTopic(request, id).catch(() => {});
  });

  test("F03: a streamed reply keeps the bottom pinned on every painted frame", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const chat = await seedChat(request, `TM stream ${Date.now()}`, 30, "STREAM-END");
    created.push(chat.topicId);
    await installProbe(page);
    await openAtRest(page, request, chat.topicId, "STREAM-END");

    await composer(page).fill("FAST:220:12:tk");
    await startProbe(page, { indicator: '[data-testid="chat-streaming-indicator"]', reply: "msg:tk-001" });
    await composer(page).press("Enter");
    await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: "tk-220" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="chat-streaming-indicator"]')).toHaveCount(0, { timeout: 15_000 });
    await moreFrames(page, 20);
    const frames = await stopProbe(page, testInfo, "stream");

    // From the first token on screen to the end of the turn: every painted
    // frame shows the true bottom. A frame off it is the bounce of F03.
    const from = frames.findIndex((f) => f.boxes.reply !== null);
    const to = frames.findLastIndex((f) => f.boxes.indicator !== null);
    expect(from, "the reply streamed on screen").toBeGreaterThanOrEqual(0);
    const window = frames.slice(from, to + 1);
    expect(window.length, "frames sampled while streaming").toBeGreaterThan(20);
    const grew = window.filter((f, i) => i > 0 && f.sh !== window[i - 1]!.sh).length;
    expect(grew, "the reply wrapped onto new lines while it streamed").toBeGreaterThan(5);
    const off = window
      .map((f, i) => ({ i: from + i, t: Math.round(f.t - window[0]!.t), r: residual(f) }))
      .filter((x) => x.r > 1)
      .map((x) => `f${x.i} +${x.t}ms ${x.r}px off the bottom`);
    expect(off, "no painted frame off the bottom while the reply streams").toEqual([]);
  });

  test("F02: a running tool opens and closes its live body without a one-frame lurch", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-03" });
    const chat = await seedChat(request, `TM toolturn ${Date.now()}`, 30, "TOOL-END");
    created.push(chat.topicId);
    await installProbe(page);
    await openAtRest(page, request, chat.topicId, "TOOL-END");

    await composer(page).fill("TOOLTURN:600 tool motion");
    await startProbe(page, {
      row: '[data-testid^="tool-call-row-toolu_slow_"]',
      ref: "msg:TOOLTURN:600",
    });
    await composer(page).press("Enter");
    await expect(page.locator('[data-testid="chat-message"]').filter({ hasText: "END of the answer." })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="chat-streaming-indicator"]')).toHaveCount(0, { timeout: 15_000 });
    // The auto-opened body closes after its dwell: wait for it, then a tail.
    await page.waitForFunction(() => {
      const f = (window as unknown as { __tm: Probe }).__tm.frames;
      const hs = f.map((x) => x.boxes.row?.h ?? 0).filter((h) => h > 0);
      return hs.length > 0 && Math.max(...hs) - hs[hs.length - 1]! >= 20;
    }, null, { timeout: 15_000 });
    await moreFrames(page, 30);
    const frames = await stopProbe(page, testInfo, "toolturn");

    // The body opening or closing is a RUN of frames in which the row's height
    // moves one way. Of every run of 20 px or more, no single painted frame may
    // carry more than its share of the time it took (`stepShare`; the audit
    // saw 100% in one frame, and a second step two frames later), and the
    // conversation above, which a pinned chat moves with it, obeys the same.
    type Run = { from: number; to: number; total: number; steps: number[] };
    const runs: Run[] = [];
    let cur: Run | null = null;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!.boxes.row, b = frames[i]!.boxes.row;
      const dh = a && b ? b.h - a.h : 0;
      const sign = Math.abs(dh) < 0.5 ? 0 : Math.sign(dh);
      if (cur && sign === Math.sign(cur.total)) { cur.to = i; cur.total += dh; cur.steps.push(dh); continue; }
      if (cur) runs.push(cur);
      cur = sign === 0 ? null : { from: i, to: i, total: dh, steps: [dh] };
    }
    if (cur) runs.push(cur);
    const moves = runs.filter((r) => Math.abs(r.total) >= 20);
    const lurches: string[] = [];
    for (const r of moves) {
      const bound = (i: number) => stepShare(frames[i]!.t - frames[i - 1]!.t) * Math.abs(r.total);
      const label = `body ${r.total > 0 ? "opening" : "closing"} ${r.total.toFixed(1)}px over f${r.from}-f${r.to}`;
      r.steps.forEach((dh, k) => { if (Math.abs(dh) > bound(r.from + k)) lurches.push(`f${r.from + k}: ${label}, the row changed ${dh.toFixed(1)}px in one frame`); });
      for (let j = r.from; j <= Math.min(frames.length - 1, r.to + 1); j++) {
        const ra = frames[j - 1]!.boxes.ref, rb = frames[j]!.boxes.ref;
        if (!ra || !rb) continue;
        const dy = rb.y - ra.y;
        if (Math.abs(dy) > bound(j)) lurches.push(`f${j}: ${label}, the conversation moved ${dy.toFixed(1)}px in one frame`);
      }
    }
    expect(moves.filter((r) => r.total > 0).length, `the live body opened: ${moves.map((r) => r.total.toFixed(1)).join(", ")}`).toBeGreaterThanOrEqual(1);
    expect(moves.filter((r) => r.total < 0).length, `and closed after its dwell: ${moves.map((r) => r.total.toFixed(1)).join(", ")}`).toBeGreaterThanOrEqual(1);
    expect(lurches, "no one-frame lurch when the body opens or closes").toEqual([]);
  });

  test("F09: opening a finished tool row at the bottom keeps the row where it was, the body unrolls under it", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-03" });
    test.info().annotations.push({ type: "spec", description: "CHAT-FOLD-01" });
    const output = Array.from({ length: 14 }, (_, i) => `line ${i + 1} of the command output`).join("\n");
    const chat = await seedChat(request, `TM expand ${Date.now()}`, 30, "EXPAND-END", [
      { id: "tm-expand-1", name: "Bash", args: { command: "ls -la /tmp/expand" }, status: "success", result: output, startedAt: Date.now() - 2000, endedAt: Date.now() - 1000 },
    ]);
    created.push(chat.topicId);
    await installProbe(page);
    await openAtRest(page, request, chat.topicId, "EXPAND-END");

    const row = page.locator('[data-testid="tool-call-row-tm-expand-1"]');
    await expect(row).toBeVisible();
    await startProbe(page, { row: '[data-testid="tool-call-row-tm-expand-1"]' });
    await moreFrames(page, 3);
    await row.locator("button").first().click();
    await expect(row.getByText("line 14 of the command output")).toBeAttached({ timeout: 10_000 });
    await moreFrames(page, 45);
    const frames = await stopProbe(page, testInfo, "expand");

    // The contract changed with CHAT-FOLD-01. The audit saw +266 px and then
    // -266 px 33-43 ms later; the cure of 30/09 made the row glide up to bring
    // its body into view. A row opened by hand now does not move at all: the
    // body unrolls below it, the list does not re-pin to the new bottom, and
    // the reader scrolls on to read it (chat-accordion-no-shift.spec.ts).
    const withRow = frames.filter((f) => f.boxes.row);
    const rows = withRow.map((f) => f.boxes.row!);
    const opened = rows.findIndex((b) => b.h - rows[0]!.h >= 100);
    expect(opened, "the body opened").toBeGreaterThan(0);
    const y0 = rows[0]!.y;
    const faults = rows
      .map((b, i) => ({ i, dy: b.y - y0 }))
      .filter((x) => Math.abs(x.dy) > 1)
      .map((x) => `f${x.i}: row moved ${x.dy.toFixed(1)}px`);
    expect(faults, "the clicked row stays where it was in every frame").toEqual([]);
    const last = frames[frames.length - 1]!;
    expect(residual(last), "the opened body went on below the fold: the list was not re-pinned").toBeGreaterThan(20);
  });

  test("F07: a cold open of a short chat shows one skeleton where the messages land", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const host = await seedChat(request, `TM host ${Date.now()}`, 6, "HOST-END");
    const short = await seedChat(request, `TM short cold ${Date.now()}`, 4, "SHORT-END");
    created.push(host.topicId, short.topicId);
    await installProbe(page);
    await openAtRest(page, request, host.topicId, "HOST-END");
    // The network of a phone on the LAN: the history takes a moment, so the
    // skeleton has frames to be judged on.
    await page.route(`**/history/${encodeURIComponent(short.sessionKey)}**`, async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });

    const palette = page.getByTestId("command-palette");
    await page.keyboard.press("Meta+k");
    await expect(palette).toBeVisible();
    await page.keyboard.type(short.name);
    await expect(palette).toContainText(short.name);
    await startProbe(page, {});
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="chat-message"]:visible').filter({ hasText: "SHORT-END" })).toBeVisible({ timeout: 20_000 });
    await moreFrames(page, 30);
    const frames = await stopProbe(page, testInfo, "cold-open");

    const skelIds = [...new Set(frames.filter((f) => f.skel).map((f) => f.skel!.id))];
    expect(skelIds.length, "the skeleton was on screen while the history loaded").toBeGreaterThanOrEqual(1);
    expect(skelIds.length, `one skeleton, not remounted: nodes ${skelIds.join(",")}`).toBe(1);
    const lastSkel = frames.findLastIndex((f) => f.skel);
    const firstContent = frames.findIndex((f, i) => i > lastSkel - 1 && !f.skel && f.first);
    expect(firstContent, "the messages replaced the skeleton").toBeGreaterThan(0);
    const skelY = frames[lastSkel]!.skel!.y;
    const contentY = frames[firstContent]!.first!.y;
    expect(Math.abs(contentY - skelY), `the first message lands where the skeleton's first bubble was (skeleton ${skelY}, message ${contentY})`).toBeLessThanOrEqual(24);
    const later = frames.slice(firstContent).map((f) => f.first?.y).filter((y): y is number => y !== undefined);
    const drift = Math.max(...later.map((y) => Math.abs(y - later[0]!)));
    expect(drift, "and it does not move once it is there").toBeLessThanOrEqual(1);
  });
});

test.describe("phone chat switch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.describe.configure({ timeout: 120_000 });

  test("panes:F3: back to a chat already loaded, no skeleton, no replayed entrance, no jump", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "TABSWITCH-01" });
    const a = await seedChat(request, `TM phone A ${Date.now()}`, 40, "PHONE-A-END");
    const b = await seedChat(request, `TM phone B ${Date.now()}`, 12, "PHONE-B-END");
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: {
        [a.topicId]: { id: a.topicId, type: "chat", title: "", topicId: a.topicId, openedAt },
        [b.topicId]: { id: b.topicId, type: "chat", title: "", topicId: b.topicId, openedAt },
      },
      groups: { "group:default": { id: "group:default", paneIds: [a.topicId, b.topicId], splitRatio: 1, splitAxis: "horizontal" } },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await installProbe(page);
    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), a.topicId);
    await page.goto("/");
    const aEnd = page.locator('[data-testid="chat-message"]:visible').filter({ hasText: "PHONE-A-END" });
    const bEnd = page.locator('[data-testid="chat-message"]:visible').filter({ hasText: "PHONE-B-END" });
    await expect(aEnd).toBeVisible({ timeout: 20_000 });

    const openRow = async (name: string) => {
      // The phone drawer may already be open (it is, on a fresh load).
      if ((await page.locator('[aria-label="Topics sidebar"][data-drawer="open"]').count()) === 0) {
        await page.getByTestId("sidebar-reopen").filter({ visible: true }).first().tap();
      }
      const row = page.locator('[aria-label="Topics sidebar"] [role="treeitem"]').filter({ hasText: name }).first();
      await expect(row).toBeVisible();
      return row;
    };
    await (await openRow(b.name)).tap();
    await expect(bEnd).toBeVisible({ timeout: 20_000 });
    const rowA = await openRow(a.name);
    await startProbe(page, { needle: "msg:PHONE-A-END" });
    await rowA.tap();
    await expect(aEnd).toBeVisible({ timeout: 20_000 });
    await moreFrames(page, 40);
    const frames = await stopProbe(page, testInfo, "phone-return");

    const firstContent = frames.findIndex((f) => f.boxes.needle);
    expect(firstContent, "chat A came back").toBeGreaterThanOrEqual(0);
    const after = frames.slice(firstContent);
    expect(after.filter((f) => f.skel).length, "no skeleton on a chat already loaded").toBe(0);
    expect(Math.max(0, ...after.map((f) => f.entrances)), "no history row replays the entrance").toBe(0);
    const ys = after.map((f) => f.boxes.needle?.y).filter((y): y is number => y !== undefined);
    const jump = Math.max(...ys.map((y) => Math.abs(y - ys[0]!)));
    expect(jump, `no jump once the chat is back (ys ${[...new Set(ys)].join(",")})`).toBeLessThanOrEqual(1);
  });
});
