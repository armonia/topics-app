/**
 * What the turn-end specs share: a real native-runtime turn on a fake model, and
 * a per-frame sampler of the last assistant bubble that judges that the end of the
 * turn moves nothing. Moved out of `chat-turn-end-still.spec.ts` so a second spec
 * (the reasoning translation, which records a video) measures with the very same
 * ruler; a spec file cannot be imported from another one.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp, openTopic } from "../helpers";
import { createTopic, patchTopic, resetPaneStore } from "./api-fixtures";
import { E2E_BASE } from "./test-server";

export async function nativeRuntime(body: { on: boolean; workspace?: string }): Promise<unknown> {
  const res = await fetch(`${E2E_BASE}/api/test/native-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** A provider-Topics chat with enough history to scroll: the turn ends pinned to the bottom. */
export async function nativeTopic(request: APIRequestContext, name: string) {
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "topics" });
  for (let i = 0; i < 12; i++) {
    await request.post(`${E2E_BASE}/api/test/topics/${topic.id}/session-row`, {
      data: { role: i % 2 ? "assistant" : "user", content: `Message ${i}. `.repeat(40) },
    });
  }
  await resetPaneStore(request, [topic.id]);
  return topic;
}

export async function openChat(page: Page, name: string) {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(name));
  await page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }).waitFor({ state: "visible", timeout: 15_000 });
}

export type Frame = { t: number; loader: boolean; row: number | null; text: number | null; meta: number | null; metaLive: boolean; above: number | null; scroll: number | null; toolOpen: boolean };

/**
 * Starts, in the page, a per-frame sampler of the LAST assistant bubble: found
 * again every frame by position, because the bubble changes id at the end of
 * the turn. It waits until the answer's text is on screen and every measured
 * top has held for 10 frames, then records until 1.5 s after the loader went.
 * `above` is the prompt's bubble, the last user row: the transcript over the
 * turn, which a bubble that shrank or grew would push. `scroll` is the
 * scroller's `scrollTop`.
 * A tool row whose body is open does not count as settled: a call that ran
 * past `AUTO_OPEN_DELAY_MS` opens its body by itself and closes it
 * `AUTO_OPEN_MIN_DWELL_MS` later (`toolRowDisclosure.ts`). On a loaded WebKit
 * runner an `echo` sometimes ran that long, the answer arrived inside the
 * dwell, 10 still frames went by with the body open, and its closing was
 * recorded as the end of the turn moving row and prompt by 62 px (twotool,
 * runs 42532993310 and 42632032036). That closing belongs to the tool, not
 * to the end of the turn: the sampler waits for it.
 * `settleOn: "row"` starts recording once the reasoning row has held, before
 * any text: for a turn whose text and end come together, the frame the text
 * is first drawn in is part of what is judged.
 */
export async function startSampler(page: Page, marker: string, settleOn: "text" | "row" = "text"): Promise<void> {
  await page.evaluate(({ marker, settleOn }) => {
    const w = window as unknown as { __still: { frames: Frame[]; done: boolean; error?: string } };
    w.__still = { frames: [], done: false };
    const topOf = (el: Element | null) => (el ? el.getBoundingClientRect().top : null);
    const textTop = (bubble: Element): number | null => {
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.includes(marker)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        return range.getBoundingClientRect().top;
      }
      return null;
    };
    const sample = () => {
      const bubbles = document.querySelectorAll('[data-message-id][data-role="assistant"]');
      const bubble = bubbles[bubbles.length - 1] ?? null;
      const meta = bubble?.querySelector('[data-testid="message-meta-row"]') ?? null;
      const prompts = document.querySelectorAll('[data-message-id][data-role="user"]');
      return {
        above: topOf(prompts[prompts.length - 1] ?? null),
        loader: !!document.querySelector('[data-testid="chat-streaming-indicator"]'),
        row: bubble ? topOf(bubble.querySelector('[data-testid="reasoning-row"]')) : null,
        text: bubble ? textTop(bubble) : null,
        meta: topOf(meta),
        metaLive: meta?.getAttribute("data-live") === "true",
        scroll: (document.querySelector('[data-testid="chat-message-list"]') as HTMLElement | null)?.scrollTop ?? null,
        toolOpen: !!bubble?.querySelector('[data-testid^="tool-call-row-"] [aria-expanded="true"]'),
      };
    };
    let steady = 0;
    let previous: ReturnType<typeof sample> | null = null;
    let recording = false;
    let t0 = 0;
    let stopAt: number | null = null;
    const tick = () => {
      const s = sample();
      if (!recording) {
        const same = !!previous && previous.row === s.row && previous.text === s.text && previous.meta === s.meta && previous.above === s.above;
        const ready = (settleOn === "row" ? s.row !== null && s.text === null : s.text !== null) && !s.toolOpen;
        steady = s.loader && ready && same ? steady + 1 : 0;
        previous = s;
        if (steady >= 10) { recording = true; t0 = performance.now(); }
        else if (!s.loader && s.text !== null) { w.__still.error = "the turn ended before it settled"; w.__still.done = true; return; }
        requestAnimationFrame(tick);
        return;
      }
      const t = performance.now() - t0;
      w.__still.frames.push({ t: Math.round(t), ...s });
      if (!s.loader && stopAt === null) stopAt = t + 1_500;
      if (stopAt !== null && t >= stopAt) { w.__still.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { marker, settleOn });
}

export async function framesOf(page: Page): Promise<Frame[]> {
  await page.waitForFunction(() => (window as unknown as { __still: { done: boolean } }).__still.done, null, { timeout: 30_000 });
  const { frames, error } = await page.evaluate(() => (window as unknown as { __still: { frames: Frame[]; error?: string } }).__still);
  expect(error, "the sampler saw a settled live turn").toBeUndefined();
  return frames;
}

export const spread = (values: Array<number | null>) => {
  const ys = values.filter((v): v is number => v !== null);
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
};

/** The end of the turn as one window lived it: the loader went, nothing moved. */
export function judge(who: string, frames: Frame[], opts: { row: boolean }) {
  const report = `${who}: ${frames.length} frames, row ${spread(frames.map((f) => f.row)).toFixed(2)} px, text ${spread(frames.map((f) => f.text)).toFixed(2)} px, meta ${spread(frames.map((f) => f.meta)).toFixed(2)} px, above ${spread(frames.map((f) => f.above)).toFixed(2)} px, scroll ${spread(frames.map((f) => f.scroll)).toFixed(2)} px`;
  console.log(`TURN-END ${report}`);
  // The window holds both sides of the end: the loader on, then gone.
  expect(frames.some((f) => f.loader), report).toBe(true);
  expect(frames.some((f) => !f.loader), report).toBe(true);
  expect(frames.some((f) => !f.metaLive), report).toBe(true);
  // On screen in every frame: the end neither removes nor re-inserts them.
  expect(frames.filter((f) => f.text === null), report).toHaveLength(0);
  expect(frames.filter((f) => f.meta === null), report).toHaveLength(0);
  expect(frames.filter((f) => f.above === null), report).toHaveLength(0);
  if (opts.row) expect(frames.filter((f) => f.row === null), report).toHaveLength(0);
  else expect(frames.filter((f) => f.row !== null), report).toHaveLength(0);
  expect(spread(frames.map((f) => f.row)), report).toBe(0);
  expect(spread(frames.map((f) => f.text)), report).toBe(0);
  expect(spread(frames.map((f) => f.meta)), report).toBe(0);
  expect(spread(frames.map((f) => f.above)), report).toBe(0);
}

/**
 * A turn whose text and end come together. The text is drawn while the loader
 * is still on: it grows the bubble and the pin follows it, as with any streamed
 * text. From the last frame of the loader on, the loader going included,
 * nothing moves.
 */
export function judgeFromText(who: string, frames: Frame[]) {
  const seen = frames.map((f) => `${f.t}:${f.loader ? "L" : "-"}${f.text === null ? "" : "T"}@${f.row?.toFixed(2)}`).join(" ");
  const lastLoader = frames.map((f) => f.loader).lastIndexOf(true);
  expect(lastLoader, `${who}: the loader was seen (${seen})`).toBeGreaterThanOrEqual(0);
  expect(frames[lastLoader]!.text, `${who}: the text is on screen before the loader goes (${seen})`).not.toBeNull();
  judge(who, frames.slice(lastLoader), { row: true });
}

