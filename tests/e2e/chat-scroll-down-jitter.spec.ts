import { test, expect, type Page, type Locator } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * SCROLLING DOWN TO THE BOTTOM DOES NOT JERK.
 *
 * Reported on 24/09: "if you keep scrolling down in a topic chat it jerks a
 * little while it settles back". This spec measures it frame by frame, on the
 * engine that ships (WebKit), with a trackpad-like wheel.
 *
 * What counts as a jerk: on every frame the content is watched through a row
 * in the middle of the viewport. Its motion on screen has exactly two honest
 * causes, the user's wheel and nothing else. So
 *
 *   unexplained = screen motion of the row + scrollTop change - app writes
 *
 * is zero when the only thing that moved the view was the wheel (the app's
 * own compensations, like Virtuoso's scrollBy after a row above grew, cancel
 * out), and it is the jump the reader sees when the app wrote scrollTop on its
 * own (a pin to the bottom) or a row changed height under the viewport.
 * Anything above JERK_PX is a jerk.
 *
 * App writes are caught by wrapping the `scrollTop` setter and `scrollTo` /
 * `scrollBy` of the chat scroller before the app loads: the wheel never goes
 * through them, so they are exactly "the app moved the view".
 *
 * Measured before the fix (24/09, WebKit): from history to the bottom 14
 * jerks of 6-12px, up-and-down near the bottom 9 jerks of 6px, all DURING the
 * wheel and with ZERO app writes. So not a pin, not followOutput, not the ring
 * at rest: every jerk was a frame where a row left the top of the viewport.
 * The bubble's `mb-1.5` collapsed out of Virtuoso's item, Virtuoso measured
 * each row 6px shorter than the space it took, and swapping a row for its
 * measured height in the top padding pulled the content up by 6px per row.
 * After `flow-root` on the item: 0 jerks in all three, true bottom reached.
 *
 * @covers CHAT-01
 */
const JERK_PX = 3;

type Frame = { t: number; top: number; h: number; ch: number; idx: number; disp: number | null; pad: number; first: number; last: number; rows: Record<string, number> };
type Write = { t: number; kind: string; before: number; after: number; h: number; ch: number };
type Wheel = { t: number; dy: number };
type Probe = { frames: Frame[]; writes: Write[]; wheels: Wheel[]; running: boolean };

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const p = { frames: [], writes: [], wheels: [], running: false } as unknown as Probe;
    (window as unknown as { __probe: Probe }).__probe = p;
    const isChat = (el: Element) => el.matches?.('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]');
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const read = (el: Element) => desc.get!.call(el) as number;
    const log = (el: Element, kind: string, before: number) => {
      if (!p.running) return;
      p.writes.push({ t: performance.now(), kind, before, after: read(el), h: el.scrollHeight, ch: el.clientHeight });
    };
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get() { return desc.get!.call(this); },
      set(v: number) {
        if (!isChat(this)) return desc.set!.call(this, v);
        const before = read(this);
        desc.set!.call(this, v);
        log(this, "scrollTop", before);
      },
    });
    for (const name of ["scrollTo", "scrollBy"] as const) {
      const orig = Element.prototype[name] as (...a: unknown[]) => void;
      Element.prototype[name] = function (this: Element, ...args: unknown[]) {
        if (!isChat(this)) return orig.apply(this, args);
        const before = read(this);
        orig.apply(this, args);
        log(this, name, before);
      } as never;
    }
    window.addEventListener("wheel", (e) => { if (p.running) p.wheels.push({ t: performance.now(), dy: e.deltaY }); }, { capture: true, passive: true });
  });
}

async function startRecording(scroller: Locator) {
  await scroller.evaluate((el) => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    p.frames = []; p.writes = []; p.wheels = []; p.running = true;
    let prevIdx = -1;
    let prevTop = 0;
    const rowAtMiddle = () => {
      const box = el.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      for (const row of el.querySelectorAll<HTMLElement>("[data-index]")) {
        const r = row.getBoundingClientRect();
        if (r.top <= mid && r.bottom >= mid) return row;
      }
      return null;
    };
    const tick = () => {
      if (!p.running) return;
      let disp: number | null = null;
      if (prevIdx >= 0) {
        const same = el.querySelector<HTMLElement>(`[data-index="${prevIdx}"]`);
        if (same) disp = same.getBoundingClientRect().top - prevTop;
      }
      const row = rowAtMiddle();
      prevIdx = row ? Number(row.dataset.index) : -1;
      prevTop = row ? row.getBoundingClientRect().top : 0;
      const list = el.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
      const mounted = [...el.querySelectorAll<HTMLElement>("[data-index]")];
      const rows: Record<string, number> = {};
      for (const m of mounted) rows[m.dataset.index!] = Math.round(m.getBoundingClientRect().height * 10) / 10;
      p.frames.push({
        t: performance.now(), top: el.scrollTop, h: el.scrollHeight, ch: el.clientHeight, idx: prevIdx, disp,
        pad: list ? parseFloat(getComputedStyle(list).paddingTop) : 0,
        first: mounted.length ? Number(mounted[0]!.dataset.index) : -1,
        last: mounted.length ? Number(mounted[mounted.length - 1]!.dataset.index) : -1,
        rows,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopRecording(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    p.running = false;
    return JSON.parse(JSON.stringify(p)) as Probe;
  });
}

type Jerk = { t: number; px: number; phase: string; appPx: number; kinds: string; dist: number; dh: number; dpad: number; range: string; grew: string };

/** Every frame whose screen motion the wheel does not explain. */
function analyse(p: Probe): { jerks: Jerk[]; lastWheel: number } {
  const jerks: Jerk[] = [];
  const lastWheel = p.wheels.length ? p.wheels[p.wheels.length - 1]!.t : 0;
  for (let i = 1; i < p.frames.length; i++) {
    const a = p.frames[i - 1]!;
    const b = p.frames[i]!;
    if (b.disp == null) continue;
    const ws = p.writes.filter((w) => w.t > a.t && w.t <= b.t);
    const appPx = ws.reduce((s, w) => s + (w.after - w.before), 0);
    const unexplained = b.disp + (b.top - a.top) - appPx;
    // The app moved the view, or content moved under the viewport, by more
    // than the threshold. `-appPx` is what the reader sees of a write the
    // content did not ask for; `unexplained` catches both at once.
    const px = Math.round(unexplained);
    if (Math.abs(px) <= JERK_PX) continue;
    const wheelNear = p.wheels.some((w) => w.t > a.t - 20 && w.t <= b.t);
    const sinceWheel = Math.round(b.t - Math.max(0, ...p.wheels.filter((w) => w.t <= b.t).map((w) => w.t)));
    jerks.push({
      t: Math.round(b.t - (p.frames[0]?.t ?? 0)),
      px,
      phase: wheelNear ? "during wheel" : `${sinceWheel}ms after last wheel`,
      appPx: Math.round(appPx),
      kinds: ws.map((w) => `${w.kind}:${Math.round(w.after - w.before)}`).join(","),
      dist: Math.round(b.h - b.top - b.ch),
      dh: b.h - a.h,
      dpad: Math.round((b.pad - a.pad) * 10) / 10,
      range: `${a.first}-${a.last} -> ${b.first}-${b.last}`,
      grew: Object.keys(b.rows).filter((k) => k in a.rows && Math.abs(b.rows[k]! - a.rows[k]!) > 0.5).map((k) => `${k}:${a.rows[k]}->${b.rows[k]}`).join(","),
    });
  }
  return { jerks, lastWheel };
}

/** One trackpad fling: a burst of wheel events decaying like momentum. */
async function fling(page: Page, dir: 1 | -1, start = 70) {
  for (let d = start; d >= 1; d *= 0.88) {
    await page.mouse.wheel(0, dir * Math.round(d));
    await page.waitForTimeout(14);
  }
}

test.describe("chat scroll down: no jerk", () => {
  test.describe.configure({ timeout: 120_000 });
  let topicId = "";
  let topicName = "";

  const tool = (id: string, command: string) => ({
    kind: "tool",
    toolCall: { id, name: "Bash", args: { command }, status: "success", detail: { type: "shell", command, output: "ok\n".repeat(4) } },
  });

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    topicName = `jitter-down-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true,
      });
    // A real conversation: short asks, turns of commentary and tools that fold
    // into one row, answers with prose, lists and fenced code.
    const code = "```ts\n" + Array.from({ length: 12 }, (_, i) => `const v${i} = compute(${i}); // ${"x".repeat(i * 3)}`).join("\n") + "\n```";
    for (let i = 0; i < 24; i++) {
      await row("user", `Domanda ${i + 1}: sistema il modulo ${i} e dimmi cosa hai cambiato.`);
      const answer = i % 3 === 0
        ? `Fatto, turno ${i + 1}.\n\n${code}\n\nIl test passa.`
        : i % 3 === 1
          ? `Risposta ${i + 1}. ` + "Un paragrafo lungo che va a capo su piu' righe. ".repeat(7) + "\n\n- uno\n- due\n- tre"
          : `Breve risposta ${i + 1}.`;
      await row("assistant", answer, [
        { kind: "text", text: `Guardo il file ${i}.` }, tool(`a${i}`, `cat src/m${i}.ts`),
        { kind: "text", text: "Lancio i test." }, tool(`b${i}`, `bun test m${i}`), tool(`c${i}`, "git status"),
        { kind: "text", text: answer },
      ]);
    }
  });

  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  const openAtBottom = async (page: Page) => {
    await installProbe(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight > 2000 && el.scrollHeight - el.scrollTop - el.clientHeight <= 8), { timeout: 20_000 })
      .toBe(true);
    // The opening window (OPEN_WINDOW_MS, up to OPEN_HARD_STOP_MS) is over.
    await page.waitForTimeout(2000);
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    return scroller;
  };

  const report = (label: string, p: Probe, scroller: { dist: number }) => {
    const { jerks } = analyse(p);
    const max = jerks.reduce((m, j) => Math.max(m, Math.abs(j.px)), 0);
    console.log(`[jitter] ${label}: ${p.frames.length} frames, ${p.wheels.length} wheels, ${p.writes.length} app writes, ${jerks.length} jerks > ${JERK_PX}px (max ${max}px), final distance ${scroller.dist}px`);
    for (const j of jerks.slice(0, 30)) console.log(`[jitter]   ${JSON.stringify(j)}`);
    const writes = p.writes.filter((w) => Math.abs(w.after - w.before) > 0.5);
    console.log(`[jitter]   moving app writes: ${writes.length}`, JSON.stringify(writes.slice(0, 20).map((w) => ({ t: Math.round(w.t - (p.frames[0]?.t ?? 0)), k: w.kind, d: Math.round(w.after - w.before), dist: Math.round(w.h - w.before - w.ch) }))));
    return jerks;
  };

  test("scrolling down from history to the bottom with a trackpad", async ({ page }) => {
    test.setTimeout(120_000);
    const scroller = await openAtBottom(page);
    // Go back into history the way a reader does, then let everything settle.
    for (let i = 0; i < 4; i++) await fling(page, -1, 90);
    await page.waitForTimeout(1200);
    const up = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(up, "the setup did not get far enough from the bottom").toBeGreaterThan(1200);
    // The cause, asserted directly: rows sit edge to edge. A gap between two
    // mounted rows is a margin that escaped its item, i.e. space Virtuoso does
    // not measure, and every row leaving the top then shifts the content by it.
    const gaps = await scroller.evaluate((el) => {
      const rows = [...el.querySelectorAll<HTMLElement>("[data-index]")];
      return rows.slice(1).map((r, i) => Math.round(r.getBoundingClientRect().top - rows[i]!.getBoundingClientRect().bottom)).filter((g) => g !== 0);
    });
    expect.soft(gaps, "margins collapsing out of the rows: space Virtuoso does not measure").toEqual([]);

    await startRecording(scroller);
    // Fling down until the bottom, then keep going a little, as a hand does.
    for (let i = 0; i < 30; i++) {
      await fling(page, 1);
      const d = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      if (d <= 1) break;
    }
    await fling(page, 1, 40);
    await page.waitForTimeout(1500);
    const p = await stopRecording(page);
    const dist = await scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    const jerks = report("history -> bottom", p, { dist });
    expect.soft(jerks, "the view jerked while scrolling down").toEqual([]);
    expect(dist, "the fling did not reach the true bottom").toBeLessThanOrEqual(8);
  });

  test("scrolling down again when already at the bottom", async ({ page }) => {
    test.setTimeout(120_000);
    const scroller = await openAtBottom(page);
    await startRecording(scroller);
    for (let i = 0; i < 3; i++) {
      await fling(page, 1);
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(1200);
    const p = await stopRecording(page);
    const dist = await scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    const jerks = report("at bottom, keep scrolling down", p, { dist });
    expect(dist).toBeLessThanOrEqual(8);
    expect.soft(jerks, "the view jerked while scrolling down at the bottom").toEqual([]);
  });

  test("a short scroll up and back down near the bottom", async ({ page }) => {
    test.setTimeout(120_000);
    const scroller = await openAtBottom(page);
    await startRecording(scroller);
    for (let i = 0; i < 3; i++) {
      await fling(page, -1, 25);
      await page.waitForTimeout(300);
      await fling(page, 1, 30);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1200);
    const p = await stopRecording(page);
    const dist = await scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    const jerks = report("near bottom, up and down", p, { dist });
    expect(dist).toBeLessThanOrEqual(8);
    expect.soft(jerks, "the view jerked near the bottom").toEqual([]);
  });
});
