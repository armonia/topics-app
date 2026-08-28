/**
 * WHERE THE TEXT OF A TAB IS BORN, measured on the rendered element.
 *
 * The report this file answers: "some test tabs have the label not aligned
 * vertically" (28/08). A screenshot does not settle it and neither does a
 * vision model: the whole defect is under one pixel. So the DOM is measured,
 * and the tabs are compared WITH EACH OTHER, which finds the odd one out
 * without anybody having to know which value is the right one.
 *
 * WHAT IS MEASURED, and why it is not the ink. The centre of the ACTUAL glyphs
 * moves with the string: "New Chat" has no descender, "test geometry" has a y,
 * and with identical CSS their ink centres differ by 1.6px. That number says
 * nothing about alignment. What has to be equal is where the LINE BOX is born:
 * the em box of the text (a Range rect, whose height is the font's box, not the
 * string's) measured from the top of the card that holds it. Same CSS, same
 * number, whatever is written inside.
 *
 * THE INVARIANT, in two halves:
 *  1. every label is born on a WHOLE pixel of its card. A line of text born on
 *     a half pixel is rasterised across two rows of sub-pixels and reads higher
 *     and softer than its neighbour. CHROME-04 already states this for the
 *     strip; this file extends it to the other faces of a tab (CHROME-05: the
 *     tile, the row, the tab are the same surface).
 *  2. cards of the same shape give the SAME number.
 *
 * THE CAUSE IT CAUGHT, so that nobody puts it back. `truncate-tight` used to
 * derive its line box from the font (`line-height: 1`), and the margin box of
 * that utility IS its line height: 13px inside a row 34px tall cannot be
 * centred on a whole pixel. Measured before the fix: a chat name born at 1.5px
 * from the top of its row, a terminal name at 8.5px against 9px for the browser
 * row next to it in the SAME list. The strip was already right, because there
 * the line height is DECLARED and even (`leading-5`, in `TAB_LABEL_TYPE`).
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTerminalSession, createTopic, deleteTerminalSession, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const TS = Date.now();
/** Names picked to move the font fallback around: descenders, accents, a
 *  non-Latin script. If any of them shifted the line box, the comparison
 *  between rows would see it. */
const NAMES = [
  `LabelGeo plain ${TS}`,
  `LabelGeo gpq jolly ${TS}`,
  `LabelGeo Caffe\u0300 pero\u0300 ${TS}`,
  `LabelGeo \u30c6\u30b9\u30c8 ${TS}`,
];
let topics: { id: string; name: string }[] = [];
let sessionKey = "";
/** A REAL terminal session, because a pane pointing at a session that does not
 *  exist is tombstoned by the client a moment after hydration: the tab would
 *  vanish mid-measurement, which is how this file was flaky on its first run. */
let terminalId = "";

test.beforeAll(async ({ request }) => {
  for (const name of NAMES) topics.push(await createTopic(request, name));
  // The server assigns the sessionKey: reading it beats rebuilding it, so a
  // change of convention breaks this loudly instead of injecting a frame that
  // nothing picks up (green-empty).
  const res = await request.get(`/api/topics`, { ignoreHTTPSErrors: true });
  const body = (await res.json()) as { topics?: Record<string, { sessionKey?: string }> };
  sessionKey = body.topics?.[topics[0]!.id]?.sessionKey ?? "";
  if (!sessionKey) throw new Error("the topic carries no sessionKey: without it the live subline never lights up");
  terminalId = (await createTerminalSession(request, { cwd: "/tmp", name: `LabelGeo term ${TS}` })).id;
});

test.afterAll(async ({ request }) => {
  for (const t of topics) await deleteTopic(request, t.id).catch(() => {});
  if (terminalId) await deleteTerminalSession(request, terminalId).catch(() => {});
  topics = [];
});

interface Label {
  /** Which surface the label belongs to: the strip, or a row of the column. */
  surface: string;
  text: string;
  cardH: number;
  /** Top of the text's em box, from the top of its card. THE number. */
  birth: number;
  lineHeight: string;
  /** Does the row carry a second line under the name, and does it SAY anything?
   *  A block whose height is derived from its content puts the name at two
   *  different heights in the two cases, which is the reported defect. */
  second: "none" | "empty" | "full";
}

/**
 * Every label on screen, with the card that holds it.
 *
 * `[data-pane-id]`, `[data-testid="pane-tab-label"]` and `.row-card` are
 * anchors the app declares on purpose. A locator hooked on a Tailwind utility
 * would go green-empty the day the utility is renamed, which this repo has
 * already paid for once.
 */
async function labels(page: Page): Promise<Label[]> {
  return page.evaluate(() => {
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const measure = (text: Element, card: Element, surface: string): Label | null => {
      const range = document.createRange();
      range.selectNodeContents(text);
      const rr = range.getBoundingClientRect();
      if (!rr.height || !text.textContent?.trim()) return null;
      const cr = card.getBoundingClientRect();
      if (!cr.height) return null;
      const stack = text.parentElement;
      const sibling = stack && stack.children.length === 2 && stack.firstElementChild === text
        ? stack.lastElementChild
        : null;
      return {
        surface,
        text: text.textContent.trim().slice(0, 24),
        cardH: r3(cr.height),
        birth: r3(rr.top - cr.top),
        lineHeight: getComputedStyle(text as HTMLElement).lineHeight,
        second: !sibling ? "none" : (sibling.textContent ?? "").trim() ? "full" : "empty",
      };
    };
    const out: Label[] = [];
    for (const tab of document.querySelectorAll("[data-pane-id]")) {
      const l = tab.querySelector('[data-testid="pane-tab-label"]');
      const m = l && measure(l, tab, "strip");
      if (m) out.push(m);
    }
    for (const name of document.querySelectorAll("[data-row-name]")) {
      const card = name.closest(".row-card");
      const m = card && measure(name, card, `row:${name.getAttribute("data-row-name")}`);
      if (m) out.push(m);
    }
    return out;
  });
}

/** Group by shape. A row with a subline under the name is not comparable with a
 *  single-line row, and a 28px tab is not comparable with a 34px row: what the
 *  comparison is after is the odd one out INSIDE one shape. */
function byShape(all: Label[]): Map<string, Label[]> {
  const m = new Map<string, Label[]>();
  for (const l of all) {
    const key = `${l.surface}@${l.cardH}`;
    m.set(key, [...(m.get(key) ?? []), l]);
  }
  return m;
}

async function openApp(page: Page): Promise<void> {
  await goToApp(page);
  // The command palette can own the first keystroke of a fresh profile.
  await page.keyboard.press("Escape");
}

test.describe("The label of a tab", () => {
  test("LABEL-1: in the strip every tab writes its name on the same pixel", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-04" });
    await resetPaneStore(request, [
      ...topics.map((t) => t.id),
      "browser:label-geo",
      `terminal:${terminalId}`,
    ]);
    await openApp(page);
    await expect
      .poll(async () => page.locator('[data-pane-id] [data-testid="pane-tab-label"]').count(), { timeout: 30000 })
      .toBeGreaterThanOrEqual(5);

    const strip = (await labels(page)).filter((l) => l.surface === "strip");
    // Guard against a green-empty run: with one tab there is nothing to compare.
    expect(strip.length, "tabs measured").toBeGreaterThanOrEqual(5);

    const births = [...new Set(strip.map((l) => l.birth))];
    expect(
      births,
      `the tabs do not write on the same pixel: ${strip.map((l) => `${l.text}=${l.birth}`).join(", ")}`,
    ).toHaveLength(1);
    expect(
      Number.isInteger(births[0]),
      `the line of text is born ${births[0]}px from the top of the tab, i.e. on a fraction of a pixel`,
    ).toBe(true);
  });

  test("LABEL-2: in the column the name is born on a whole pixel, and not where the line below decides", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-04" });
    await resetPaneStore(request, topics.map((t) => t.id));
    const ws = await interceptWebSocket(page);
    await openApp(page);
    // At least ours. The count is not exact on purpose: the hermetic baseline
    // carries its own topics, they are rows like the others, and the invariant
    // has to hold for them too.
    await expect
      .poll(async () => page.locator('[data-row-name="chat"]').count(), { timeout: 15000 })
      .toBeGreaterThanOrEqual(4);

    // ONE of the rows gets a subline that SAYS something; the other three
    // keep the empty placeholder. If the height of the name+subline block were
    // derived from its content instead of declared, the two cases would put the
    // name at two different heights, and that is the reported defect.
    ws.send({ type: "stream:start", sessionKey, topicId: topics[0]!.id, messageId: "label_geo" });
    await expect
      .poll(async () => (await labels(page)).filter((l) => l.second === "full").length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);

    const all = await labels(page);
    const rows = all.filter((l) => l.surface === "row:chat");
    expect(new Set(rows.map((l) => l.second)).size, "both cases on screen: a full subline and an empty one").toBe(2);

    for (const [shape, group] of byShape(all)) {
      const births = [...new Set(group.map((l) => l.birth))];
      expect(
        births,
        `${shape}: names at different heights - ${group.map((l) => `${l.text}(${l.second})=${l.birth}`).join(", ")}`,
      ).toHaveLength(1);
      expect(
        Number.isInteger(births[0]),
        `${shape}: the line of text is born ${births[0]}px from the top of the card (line height ${group[0]!.lineHeight})`,
      ).toBe(true);
    }
  });

  test("LABEL-3: the tight clip DECLARES an even line box instead of deriving it from the font", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-04" });
    await resetPaneStore(request, topics.map((t) => t.id));
    await openApp(page);
    await expect(page.locator('[data-row-name="chat"]').first()).toBeVisible({ timeout: 15000 });

    // The mechanism, measured where it lives. The margin box of `truncate-tight`
    // IS its line height, and every card that holds one is an even number of
    // pixels tall (a row is 34 or 44, a tab 28 or 36). An odd line height can
    // therefore never land on a whole pixel, whatever the content: this is the
    // cause, the two tests above are the symptom.
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll(".truncate-tight")]
        .map((el) => ({
          px: parseFloat(getComputedStyle(el as HTMLElement).lineHeight),
          text: (el.textContent ?? "").trim().slice(0, 20),
        }))
        .filter((x) => Number.isFinite(x.px)));

    expect(heights.length, "tightly clipped elements measured").toBeGreaterThan(0);
    for (const { px, text } of heights) {
      expect(Number.isInteger(px) && px % 2 === 0, `line height ${px}px on "${text}"`).toBe(true);
    }
  });
});
