/**
 * Measuring a generative view on the DOM (GENUI): boxes, what sticks out
 * sideways, and an axe-core pass on a subtree. Shared by the view specs so a
 * rule about "what counts as overflow" is written once.
 */
import { resolve } from "node:path";
import type { Frame, Page } from "@playwright/test";

const AXE_PATH = resolve(__dirname, "../../../node_modules/axe-core/axe.min.js");

export interface Box { x: number; y: number; width: number; height: number; right: number; bottom: number }

export const boxes = (page: Page | Frame, sel: string): Promise<Box[]> =>
  page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }));

/**
 * Elements under `root` that stick out of the viewport sideways without a
 * horizontal scroller of their own between them and the page: what a person
 * would have to pan to see. A card cut by the edge of a snap strip is not one.
 */
export const sidewaysOverflow = (page: Page, root = '[data-testid="view-page"]'): Promise<string[]> =>
  page.evaluate((rootSel) => {
    const w = window.innerWidth;
    const clippedSideways = (el: Element): boolean => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if ((ox === "auto" || ox === "scroll" || ox === "hidden") && a.getBoundingClientRect().right <= w + 1) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${rootSel} *`)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= w + 1 || clippedSideways(el)) continue;
      out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.className.toString().slice(0, 40)}] right=${Math.round(r.right)}`);
    }
    return out.slice(0, 5);
  }, root);

export interface AxeViolation { id: string; impact: string | null; help: string; nodes: unknown[] }

/** axe-core violations inside `sel`, as "id: help" lines (empty = clean). */
export async function axe(page: Page | Frame, sel: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const v = await page.evaluate(async (s) => {
    const w = window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } };
    const res = await w.axe.run({ include: [[s]] }, { resultTypes: ["violations"] });
    return res.violations.map((x) => ({ id: x.id, help: x.help, nodes: x.nodes.slice(0, 3).map((n) => (n as { target: unknown }).target) }));
  }, sel);
  return v.map((x) => `${x.id}: ${x.help} ${JSON.stringify(x.nodes)}`);
}
