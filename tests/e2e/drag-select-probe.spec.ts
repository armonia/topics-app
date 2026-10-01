import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * PROBE, not a contract: does a real mouse stroke select chat text on Chromium,
 * with and without a drag of the floating browser window first? Prints what the
 * page saw (events, selection before and after the button comes up, the
 * user-select chain under the stroke). Deleted with its branch.
 */

const BASE = E2E_BASE;
const LINE = "Il testo della chat che sta sotto la finestra e non va selezionato trascinando.";

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
}

async function scene(page: Page, request: APIRequestContext) {
  const topic = await createTopic(request, `E2E-DragSelectProbe-${Date.now()}`);
  const sessionKey = await sessionKeyOf(request, topic.id);
  for (let i = 0; i < 6; i++) {
    await seedMessage(request, { sessionKey, role: i % 2 ? "assistant" : "user", content: `Messaggio ${i + 1}: ${LINE} ${LINE}` });
  }
  const put = await request.put(`${BASE}/api/ui-state/topic-browser:${topic.id}`, {
    data: {
      mode: "min", minPos: { right: 40, bottom: 140 }, expandedWidth: null,
      tabs: [{ contextId: "dns-1", url: "https://example.com", title: "Example", openedBy: "user" }],
      activeContextId: "dns-1", promoted: [],
    },
    ignoreHTTPSErrors: true,
  });
  expect(put.ok()).toBeTruthy();
  await goToApp(page);
  await waitForTopicVisible(page, topic.id);
  await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
  await expect(page.getByText(`Messaggio 1: ${LINE}`)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="topic-browser-window"]')).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  return topic;
}

async function drag(page: Page) {
  const text = (await page.getByText(`Messaggio 1: ${LINE}`).boundingBox())!;
  const bar = (await page.locator('[data-testid="topic-browser-bar"]').boundingBox())!;
  const tab = (await page.locator('[data-testid="topic-browser-tab"]').first().boundingBox())!;
  const grip = { x: Math.min(tab.x + tab.width + 40, bar.x + bar.width - 60), y: bar.y + bar.height / 2 };
  const target = { x: text.x + text.width / 2, y: text.y + text.height / 2 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let leg = 1; leg <= 4; leg++) {
    await page.mouse.move(grip.x + ((target.x - grip.x) * leg) / 4, grip.y + ((target.y - grip.y) * leg) / 4, { steps: 2 });
  }
  await page.mouse.up();
}

/** Arms an event log on the window, returns nothing; read it with `readLog`. */
async function armLog(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __probe: string[] };
    w.__probe = [];
    const tag = (t: EventTarget | null) => {
      const el = t as Element | null;
      if (!el || !(el as Element).tagName) return String(t === document ? "document" : t === window ? "window" : t);
      return `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}`;
    };
    for (const type of ["pointerdown", "mousedown", "selectstart", "pointerup", "mouseup", "click", "focusin", "dragstart"]) {
      window.addEventListener(type, (e) => {
        // Read after every other listener ran: did anyone cancel it?
        setTimeout(() => w.__probe.push(`${type}@${tag(e.target)}${e.defaultPrevented ? "(prevented)" : ""} sel=${window.getSelection()?.toString().length ?? -1}`), 0);
      }, true);
    }
    let changes = 0;
    document.addEventListener("selectionchange", () => {
      changes++;
      const sel = window.getSelection();
      const nm = (n: Node | null | undefined) => (n ? `${n.nodeName}${n.nodeType === 3 ? `"${(n.textContent ?? "").slice(0, 12)}"` : ""}` : "null");
      w.__probe.push(`selectionchange#${changes} len=${sel?.toString().length ?? -1} type=${sel?.type} a=${nm(sel?.anchorNode)}:${sel?.anchorOffset} f=${nm(sel?.focusNode)}:${sel?.focusOffset}`);
    });
  });
}

async function stroke(page: Page, label: string, steps: number) {
  const s = await page.evaluate((w) => {
    const lines = [...document.querySelectorAll("[data-message-id] *")].filter(
      (el) => el.childElementCount === 0 && /^Messaggio \d+:/.test(el.textContent ?? ""),
    );
    for (const el of lines) {
      const r = el.getBoundingClientRect();
      if (r.width < w + 8 || r.height === 0) continue;
      const y = r.top + r.height / 2;
      const x0 = r.left + 2;
      const x1 = x0 + w;
      if (el.contains(document.elementFromPoint(x0, y)) && el.contains(document.elementFromPoint(x1, y))) {
        const chain: string[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          chain.push(`${n.tagName.toLowerCase()}:${cs.userSelect || (cs as unknown as { webkitUserSelect?: string }).webkitUserSelect}`);
        }
        const caret = (x: number) => {
          const d = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
          const r1 = d.caretRangeFromPoint?.(x, y);
          if (r1) return `${r1.startContainer.nodeName}:${r1.startOffset}`;
          const p = d.caretPositionFromPoint?.(x, y);
          return p ? `${p.offsetNode.nodeName}:${p.offset}` : "none";
        };
        const cs = getComputedStyle(el);
        return { x0, x1, y, chain: chain.slice(0, 12).join(" < "), htmlClass: document.documentElement.className, caret0: caret(x0), caret1: caret(x1), rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`, lh: cs.lineHeight, transform: cs.transform, contain: `${cs.contain}/${(cs as unknown as { contentVisibility?: string }).contentVisibility}`, tabindexAncestor: el.closest("[tabindex]")?.getAttribute("data-testid") ?? null, draggableAncestor: !!el.closest("[draggable=true]") };
      }
    }
    return null;
  }, 60);
  expect(s, "an uncovered line").not.toBeNull();
  await armLog(page);
  await page.mouse.move(s!.x0, s!.y);
  await page.mouse.down();
  await page.mouse.move(s!.x1, s!.y, { steps });
  const beforeUp = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  await page.mouse.up();
  const afterUp = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  await page.waitForTimeout(100);
  const report = await page.evaluate(() => ({
    afterSettle: window.getSelection()?.toString() ?? "",
    active: `${document.activeElement?.tagName.toLowerCase()}[${document.activeElement?.getAttribute("data-testid") ?? ""}]`,
    log: (window as unknown as { __probe: string[] }).__probe,
  }));
  const out = { label, steps, beforeUp: beforeUp.length, afterUp: afterUp.length, afterSettle: report.afterSettle.length, active: report.active, ...s, log: report.log };
  console.log(`PROBE ${JSON.stringify(out)}`);
  return out;
}

async function dblclickWord(page: Page, label: string) {
  const box = (await page.getByText(`Messaggio 3: ${LINE}`).boundingBox())!;
  await page.mouse.dblclick(box.x + 30, box.y + 8);
  const len = await page.evaluate(() => window.getSelection()?.toString().length ?? -1);
  console.log(`PROBE ${JSON.stringify({ label, dblclick: len })}`);
  return len;
}

/** A stroke of 60 px over the first line of `selector`, read like the chat one. */
async function controlStroke(page: Page, label: string, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  const y = box.y + 8;
  await armLog(page);
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 62, y, { steps: 5 });
  const beforeUp = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  await page.mouse.up();
  const afterUp = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  const log = await page.evaluate(() => (window as unknown as { __probe: string[] }).__probe);
  const out = { label, beforeUp: beforeUp.length, afterUp: afterUp.length, log };
  console.log(`PROBE ${JSON.stringify(out)}`);
  return out;
}

test.afterAll(async ({ request }) => { await closeAllBrowserContexts(request); });

test.describe("probe: controls", () => {
  test.describe.configure({ retries: 0 });
  test("a plain page with no app: a stroke selects", async ({ page, browserName }) => {
    await page.setContent(`<p id="p" style="font: 16px sans-serif; margin: 40px">${LINE} ${LINE}</p>`);
    const r = await controlStroke(page, `${browserName} plain-page`, "#p");
    expect(r.afterUp, JSON.stringify(r)).toBeGreaterThan(0);
  });

  test("a plain element injected into the app: a stroke selects", async ({ page, request, browserName }) => {
    const topic = await scene(page, request);
    try {
      await page.evaluate((t) => {
        const p = document.createElement("p");
        p.id = "probe-p";
        p.textContent = t;
        p.style.cssText = "position:fixed;left:400px;top:60px;z-index:2147483647;background:#fff;color:#000;font:16px sans-serif;width:600px;margin:0";
        document.body.appendChild(p);
      }, `${LINE} ${LINE}`);
      const r = await controlStroke(page, `${browserName} injected-in-app`, "#probe-p");
      expect(r.afterUp, JSON.stringify(r)).toBeGreaterThan(0);
    } finally { await deleteTopic(request, topic.id).catch(() => {}); }
  });
});

test.describe("probe: mouse selection in the chat", () => {
  test.describe.configure({ retries: 0 });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });

  for (const steps of [5]) {
    test(`no drag first, stroke in ${steps} steps`, async ({ page, request, browserName }) => {
      const topic = await scene(page, request);
      try {
        const r = await stroke(page, `${browserName} no-drag`, steps);
        const d = await dblclickWord(page, `${browserName} no-drag`);
        expect({ stroke: r.afterUp > 0, dblclick: d > 0 }, JSON.stringify(r)).toEqual({ stroke: true, dblclick: true });
      } finally { await deleteTopic(request, topic.id).catch(() => {}); }
    });

    test(`after a drag of the floating window, stroke in ${steps} steps`, async ({ page, request, browserName }) => {
      const topic = await scene(page, request);
      try {
        await drag(page);
        await expect(page.locator("html")).not.toHaveClass(/drag-no-select/);
        const r = await stroke(page, `${browserName} after-drag`, steps);
        const d = await dblclickWord(page, `${browserName} after-drag`);
        expect({ stroke: r.afterUp > 0, dblclick: d > 0 }, JSON.stringify(r)).toEqual({ stroke: true, dblclick: true });
      } finally { await deleteTopic(request, topic.id).catch(() => {}); }
    });
  }
});
