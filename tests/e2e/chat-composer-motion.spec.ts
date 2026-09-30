import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE COMPOSER IS WHERE IT BELONGS ON EVERY PAINTED FRAME.
 *
 * The owner's ask (30/09): "every single UI handled at the top, fluidity and
 * animation too ... no strange useless jerks". The UI audit of 29/09 measured
 * the composer moving when nothing asked it to:
 *
 *   core:F06  a saved chat with no messages painted the composer docked at the
 *             bottom, then glided it up to the centre over 420 ms once the
 *             history answered (350-620 px of travel, right when you type);
 *   panes:F2  a new chat from the + menu painted its composer off its final
 *             place and drifted it (29 px on the desktop, the whole screen on
 *             the phone);
 *   core:F13  two attachments grew the composer card 46 -> 125 px in one frame
 *             and pushed the conversation with it; each removal was another
 *             one-frame snap, and the chip left behind changed shape;
 *   panes:F15 on the phone a new line in the composer covered the last message
 *             for two or three frames before the list followed (28-49 ms).
 *
 * The composer goes DOWN with a slide (the first message of a chat, see
 * `chat-first-send-smooth.spec.ts`). It never climbs by animation: a chat
 * whose emptiness is only known after its history answers takes its centred
 * place in one step, and enters there.
 *
 * Measured, not eyeballed: an init script samples, at the last moment before
 * every paint, the composer card, the attachment chips, the last message and
 * the chat scroller of the chat pane on screen. Each test states its contract
 * on those samples and writes them next to the video.
 *
 * @covers CHAT-01
 */
test.use({ video: "on", contextOptions: { reducedMotion: "no-preference" } });

type Box = { x: number; y: number; w: number; h: number; o: number; id: number } | null;
type Frame = {
  t: number;
  card: Box;
  centered: boolean;
  skel: boolean;
  /** The last message row on screen. */
  last: Box;
  chips: NonNullable<Box>[];
};
type Probe = { frames: Frame[]; running: boolean };

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const nodeId = (el: Element) => {
      let id = ids.get(el);
      if (id === undefined) { id = next++; ids.set(el, id); }
      return id;
    };
    const p: Probe = { frames: [], running: false };
    (window as unknown as { __cm: Probe }).__cm = p;
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
      return { x: r1(r.x), y: r1(r.y), w: r1(r.width), h: r1(r.height), o: opacityOf(el), id: nodeId(el) };
    };
    /** The composer block of the chat pane on screen. */
    const visibleArea = (): Element | null => {
      for (const area of document.querySelectorAll('[data-testid="chat-input-area"]')) {
        const r = area.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && area.checkVisibility()) return area;
      }
      return null;
    };
    const sample = () => {
      const area = visibleArea();
      const root = area?.parentElement ?? null;
      const sc = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? null;
      const scBox = sc?.getBoundingClientRect();
      const rows = root ? [...root.querySelectorAll('[data-testid="chat-message"]')] : [];
      const onScreen = rows.filter((m) => {
        const r = m.getBoundingClientRect();
        return scBox && r.height > 0 && r.bottom > scBox.top && r.top < scBox.bottom;
      });
      const skelEl = root?.querySelector('[data-testid="chat-skeleton"]');
      p.frames.push({
        t: performance.now(),
        card: box(area?.querySelector('[data-testid="composer-card"]')),
        centered: area?.getAttribute("data-composer-centered") === "true",
        skel: !!skelEl && skelEl.getBoundingClientRect().height > 0 && skelEl.checkVisibility(),
        last: box(onScreen[onScreen.length - 1]),
        chips: [...(area?.querySelectorAll('[data-testid="composer-attachment"]') ?? [])].map((c) => box(c)).filter((b): b is NonNullable<Box> => b !== null),
      });
    };
    /**
     * Sampled in a ResizeObserver callback, the last code that runs after
     * layout and before the paint (see `chat-transcript-motion.spec.ts`): what
     * it reads is what the reader sees, running animations included.
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
    (window as unknown as { __cmArm: () => void }).__cmArm = () => {
      if (marker) return;
      marker = document.createElement("div");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(marker);
      new ResizeObserver(() => { if (p.running) sample(); }).observe(marker);
    };
  });
}

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const p = (window as unknown as { __cm: Probe }).__cm;
    p.frames = []; p.running = true;
    (window as unknown as { __cmArm: () => void }).__cmArm();
  });
}

async function moreFrames(page: Page, n: number) {
  const have = await page.evaluate(() => (window as unknown as { __cm: Probe }).__cm.frames.length);
  await page.waitForFunction((k) => (window as unknown as { __cm: Probe }).__cm.frames.length >= k, have + n);
}

/** Waits until the composer card has not moved or resized for `n` frames. */
async function cardAtRest(page: Page, n = 20) {
  await page.waitForFunction((k) => {
    const f = (window as unknown as { __cm: Probe }).__cm.frames.slice(-k);
    return f.length === k && f.every((x) => x.card && f[0]!.card && Math.abs(x.card.y - f[0]!.card.y) <= 0.5 && Math.abs(x.card.h - f[0]!.card.h) <= 0.5);
  }, n, { timeout: 20_000 });
}

async function stopProbe(page: Page, testInfo: TestInfo, name: string): Promise<Frame[]> {
  const frames = await page.evaluate(() => {
    const p = (window as unknown as { __cm: Probe }).__cm;
    p.running = false;
    return JSON.parse(JSON.stringify(p.frames)) as Frame[];
  });
  const path = testInfo.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(frames));
  await testInfo.attach(`${name}.json`, { path });
  return frames;
}

/**
 * The largest share of a change one painted frame may carry, given how long
 * that frame took (the same rule as `chat-transcript-motion.spec.ts`, scaled
 * to the duration of the animation under test). A jump is a frame of normal
 * length that carries all of it.
 */
function stepShare(dtMs: number, durationMs: number): number {
  return Math.min(1, Math.max(0.6, (4.5 * dtMs) / durationMs));
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((x) => x.id === topicId)!.sessionKey;
}

/** A chat with `count` messages ending on `endMarker` (none: an empty chat). */
async function seedChat(request: APIRequestContext, name: string, count: number, endMarker: string) {
  const t = await createTopic(request, name);
  const sessionKey = await sessionKeyOf(request, t.id);
  for (let i = 0; i < count; i++) {
    await seedMessage(request, {
      sessionKey,
      role: i % 2 === 1 ? "assistant" : "user",
      content: i === count - 1 ? `${endMarker} final line` : `Row ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(i % 5 === 0 ? 6 : 2)}`,
    });
  }
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, sessionKey, name };
}

/** Opens `topicId` alone and waits until its composer is still. */
async function openAtRest(page: Page, request: APIRequestContext, chat: { topicId: string; name: string }, needle: string) {
  const topicId = chat.topicId;
  await resetPaneStore(request, [topicId]);
  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), topicId);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="chat-message"]:visible').filter({ hasText: needle }).first()).toBeVisible({ timeout: 20_000 });
  // The phone opens with its drawer over the chat: the chat's row closes it.
  const drawer = page.locator('[aria-label="Topics sidebar"][data-drawer="open"]');
  if ((await drawer.count()) > 0) {
    await drawer.locator('[role="treeitem"]').filter({ hasText: chat.name }).first().tap().catch(() => {});
    await expect(drawer).toHaveCount(0);
  }
  await startProbe(page);
  await cardAtRest(page);
}

/** The frames of the composer card that is on screen at the end: the new pane's. */
function ownCard(frames: Frame[]) {
  const id = [...frames].reverse().find((f) => f.card)?.card?.id;
  return frames.map((f, i) => ({ f, i })).filter(({ f }) => f.card && f.card.id === id);
}

/** The card must not move from where it was first painted. */
function placedFromFirstFrame(frames: Frame[]): string[] {
  const own = ownCard(frames);
  if (own.length === 0) return ["the new composer was never sampled"];
  const first = own[0]!.f.card!;
  const out: string[] = [];
  const drift = Math.max(...own.map(({ f }) => Math.abs(f.card!.y - first.y)));
  console.log(`[composer-motion] first painted y=${first.y}, largest drift ${drift.toFixed(1)}px over ${own.length} frames, skeleton frames ${own.filter(({ f }) => f.skel).length}`);
  for (const { f, i } of own) {
    const dy = f.card!.y - first.y;
    if (Math.abs(dy) > 0.5) { out.push(`f${i}: composer ${dy.toFixed(1)}px from where it was first painted (y ${first.y} -> ${f.card!.y})`); break; }
  }
  for (const { f, i } of own) if (f.skel) { out.push(`f${i}: skeleton on a chat with no history`); break; }
  return out;
}

const composer = (page: Page) => page.locator('[data-testid="chat-input-area"]:visible [data-testid="chat-message-input"]').first();

test.describe("composer motion, desktop", () => {
  test.describe.configure({ timeout: 120_000 });
  const created: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
  });

  test("core:F06: a saved chat with no messages never glides its composer up", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const host = await seedChat(request, `CM host ${Date.now()}`, 6, "HOST-END");
    const empty = await seedChat(request, `CM empty ${Date.now()}`, 0, "");
    created.push(host.topicId, empty.topicId);
    await installProbe(page);
    await openAtRest(page, request, host, "HOST-END");
    // The history of a LAN phone: long enough for the unknown to be painted.
    await page.route(`**/history/${encodeURIComponent(empty.sessionKey)}**`, async (route) => {
      await new Promise((r) => setTimeout(r, 250));
      await route.continue();
    });

    const palette = page.getByTestId("command-palette");
    await page.keyboard.press("Meta+k");
    await expect(palette).toBeVisible();
    await page.keyboard.type(empty.name);
    await expect(palette).toContainText(empty.name);
    await startProbe(page);
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="chat-input-area"]:visible')).toHaveAttribute("data-composer-centered", "true", { timeout: 20_000 });
    await moreFrames(page, 40);
    const frames = await stopProbe(page, testInfo, "empty-open");

    // Two places at most: where it was first painted, and the centre. Any
    // frame in between is the climb the audit saw (dy -48, -17, -46, -57 ...).
    const own = ownCard(frames);
    expect(own.length, "the new chat's composer was sampled").toBeGreaterThan(20);
    const firstY = own[0]!.f.card!.y;
    const finalY = own[own.length - 1]!.f.card!.y;
    const between = own
      .filter(({ f }) => Math.abs(f.card!.y - firstY) > 0.5 && Math.abs(f.card!.y - finalY) > 0.5)
      .map(({ f, i }) => `f${i} y=${f.card!.y}`);
    expect(between, `the composer climbs by animation (first ${firstY}, final ${finalY})`).toEqual([]);
    // Placed at the centre in one step, it ENTERS there: its first frame at the
    // centre is not already at full opacity.
    if (Math.abs(finalY - firstY) > 0.5) {
      const arrived = own.find(({ f }) => Math.abs(f.card!.y - finalY) <= 0.5)!;
      expect(arrived.f.card!.o, "placed at the centre in one step, it fades in there").toBeLessThan(0.99);
    }
  });

  test("panes:F2: a new chat from the + menu paints its composer at its place from the first frame", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const host = await seedChat(request, `CM newchat host ${Date.now()}`, 6, "NEWCHAT-HOST-END");
    created.push(host.topicId);
    await installProbe(page);
    await openAtRest(page, request, host, "NEWCHAT-HOST-END");

    await page.getByTestId("pane-add-menu-trigger").filter({ visible: true }).last().click();
    const item = page.getByTestId("pane-add-menu-new-chat");
    await expect(item).toBeVisible();
    await startProbe(page);
    await item.click();
    await expect(page.locator('[data-testid="chat-input-area"]:visible')).toHaveAttribute("data-composer-centered", "true", { timeout: 20_000 });
    await moreFrames(page, 40);
    const frames = await stopProbe(page, testInfo, "newchat-desktop");
    expect(placedFromFirstFrame(frames)).toEqual([]);
  });

  test("core:F13: attachments grow and shrink the composer over frames, chips enter and keep their shape", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    const host = await seedChat(request, `CM attach ${Date.now()}`, 30, "ATTACH-END");
    created.push(host.topicId);
    await installProbe(page);
    await openAtRest(page, request, host, "ATTACH-END");

    const input = page.locator('[data-testid="chat-input-area"]:visible input[type="file"]').first();
    await startProbe(page);
    await moreFrames(page, 3);
    await input.setInputFiles(["tests/e2e/fixtures/test-upload.txt", "tests/e2e/fixtures/pixel.png"]);
    await expect(page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-attachment"]')).toHaveCount(2);
    await cardAtRest(page);
    const added = await stopProbe(page, testInfo, "attach-add");

    await startProbe(page);
    await moreFrames(page, 3);
    await page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-file-remove"]').first().click();
    await expect(page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-attachment"]')).toHaveCount(1);
    await cardAtRest(page);
    await moreFrames(page, 10);
    const removed1 = await stopProbe(page, testInfo, "attach-remove1");

    await startProbe(page);
    await moreFrames(page, 3);
    const last = page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-attachment"]').first();
    await last.hover();
    await last.getByRole("button").last().click();
    await expect(page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-attachment"]')).toHaveCount(0);
    await cardAtRest(page);
    await moreFrames(page, 10);
    const removed2 = await stopProbe(page, testInfo, "attach-remove2");

    const faults: string[] = [];
    for (const [name, frames] of [["add", added], ["remove 1", removed1], ["remove 2", removed2]] as const) {
      const hs = frames.filter((f) => f.card);
      const total = hs[hs.length - 1]!.card!.h - hs[0]!.card!.h;
      // Removing a pill next to a taller thumbnail leaves the row as tall as it was.
      if (Math.abs(total) < 10) { if (name !== "remove 1") faults.push(`${name}: the card did not change height (${total.toFixed(1)}px)`); continue; }
      for (let i = 1; i < hs.length; i++) {
        const dh = hs[i]!.card!.h - hs[i - 1]!.card!.h;
        if (Math.abs(dh) > stepShare(hs[i]!.t - hs[i - 1]!.t, 150) * Math.abs(total)) faults.push(`${name} f${i}: card ${dh.toFixed(1)}px of ${total.toFixed(1)} in one frame`);
        if (Math.abs(dh) > 0.5 && Math.sign(dh) !== Math.sign(total)) faults.push(`${name} f${i}: card went back ${dh.toFixed(1)}px`);
      }
      // The conversation follows the card in the same frame: the gap between
      // the last message and the card's top does not change.
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!, b = frames[i]!;
        if (!a.card || !b.card || !a.last || !b.last || a.last.id !== b.last.id) continue;
        const d = (b.card.y - (b.last.y + b.last.h)) - (a.card.y - (a.last.y + a.last.h));
        if (Math.abs(d) > 1) faults.push(`${name} f${i}: the last message and the card drifted ${d.toFixed(1)}px apart`);
      }
    }
    // Each chip enters: its first painted frame is not already fully drawn.
    const seen = new Set<number>();
    for (const f of added) for (const c of f.chips) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.o >= 0.99) faults.push(`chip #${c.id}: painted at full opacity on its first frame`);
    }
    // The chip left behind keeps its shape when its sibling goes.
    const before = removed1[0]!.chips;
    const after = removed1[removed1.length - 1]!.chips;
    for (const c of after) {
      const was = before.find((b) => b.id === c.id);
      if (!was) faults.push(`chip #${c.id}: a new node after its sibling was removed`);
      else if (Math.abs(was.w - c.w) > 1 || Math.abs(was.h - c.h) > 1) faults.push(`chip #${c.id}: ${was.w}x${was.h} -> ${c.w}x${c.h} when its sibling was removed`);
    }
    expect(faults).toEqual([]);
  });
});

test.describe("composer motion, reduced", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });
  test.describe.configure({ timeout: 120_000 });
  const created: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
  });

  test("core:F13 under reduced motion: the attachment row is simply there, nothing animates", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    const host = await seedChat(request, `CM attach reduced ${Date.now()}`, 6, "REDUCED-END");
    created.push(host.topicId);
    await installProbe(page);
    await openAtRest(page, request, host, "REDUCED-END");
    await startProbe(page);
    await moreFrames(page, 3);
    await page.locator('[data-testid="chat-input-area"]:visible input[type="file"]').first().setInputFiles(["tests/e2e/fixtures/test-upload.txt"]);
    await expect(page.locator('[data-testid="chat-input-area"]:visible [data-testid="composer-attachment"]')).toHaveCount(1);
    await cardAtRest(page);
    const frames = await stopProbe(page, testInfo, "attach-reduced");
    const hs = frames.filter((f) => f.card).map((f) => f.card!.h);
    const steps = hs.filter((h, i) => i > 0 && Math.abs(h - hs[i - 1]!) > 0.5).length;
    expect(steps, `the card reaches its height in one step (${[...new Set(hs)].join(" -> ")})`).toBe(1);
    const firstChip = frames.find((f) => f.chips.length > 0)!.chips[0]!;
    expect(firstChip.o, "and the chip is drawn at once").toBeGreaterThanOrEqual(0.99);
  });
});

test.describe("composer motion, phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.describe.configure({ timeout: 120_000 });
  const created: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
  });

  test("panes:F15: a new line in the composer and the last message move in the same frame", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const chat = await seedChat(request, `CM phone grow ${Date.now()}`, 30, "GROW-END");
    created.push(chat.topicId);
    await installProbe(page);
    await openAtRest(page, request, chat, "GROW-END");
    const box = composer(page);
    await box.tap();
    await startProbe(page);
    const h0 = (await box.boundingBox())!.height;
    // Typed a word at a time until the field has grown by two lines.
    for (let i = 0; i < 60; i++) {
      await box.pressSequentially("lorem ipsum ");
      if ((await box.boundingBox())!.height >= h0 + 30) break;
    }
    await cardAtRest(page);
    const frames = await stopProbe(page, testInfo, "phone-grow");

    const grew = frames.filter((f, i) => i > 0 && f.card && frames[i - 1]!.card && f.card.h - frames[i - 1]!.card!.h > 1).length;
    expect(grew, "the composer grew by a line at least once").toBeGreaterThanOrEqual(1);
    const lag: string[] = [];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      if (!a.card || !b.card || !a.last || !b.last || a.last.id !== b.last.id) continue;
      const d = (b.card.y - (b.last.y + b.last.h)) - (a.card.y - (a.last.y + a.last.h));
      if (Math.abs(d) > 1) lag.push(`f${i} +${Math.round(b.t - frames[0]!.t)}ms: gap between the last message and the composer changed ${d.toFixed(1)}px`);
    }
    expect(lag, "the last message follows the composer in the frame it grows").toEqual([]);
  });

  test("panes:F2: a new chat on the phone paints its composer at its place from the first frame", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    const host = await seedChat(request, `CM phone newchat ${Date.now()}`, 6, "PHONE-NEW-END");
    created.push(host.topicId);
    await installProbe(page);
    await openAtRest(page, request, host, "PHONE-NEW-END");
    await page.getByTestId("pane-add-menu-trigger").filter({ visible: true }).first().tap();
    const item = page.getByTestId("pane-add-menu-new-chat");
    await expect(item).toBeVisible();
    await startProbe(page);
    await item.tap();
    await expect(page.locator('[data-testid="chat-input-area"]:visible')).toHaveAttribute("data-composer-centered", "true", { timeout: 20_000 });
    await moreFrames(page, 40);
    const frames = await stopProbe(page, testInfo, "newchat-phone");
    expect(placedFromFirstFrame(frames)).toEqual([]);
  });
});
