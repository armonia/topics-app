import type { Locator } from "@playwright/test";

/**
 * The tooltip text of an element, read correctly WHILE THE MOUSE IS ON IT.
 *
 * `TooltipDelegate` (client/src/components/Shared/TooltipDelegate.tsx) exists so
 * the OS tooltip never fires next to the app's own. The way it does that is to
 * move `title` onto `data-tip` on `mouseover` and put it back on `mouseout`, and
 * `tooltip-app.spec.ts` asserts exactly that contract. Playwright leaves the
 * pointer where it is after `hover()`, so any test that hovers and then reads
 * `getAttribute("title")` reads an attribute the app has deliberately removed:
 * it polls an empty string until it times out, and the failure looks like the
 * feature is broken rather than like the test is reading the wrong place.
 *
 * `data-tip` and not the visible `[data-testid="app-tooltip"]`, on purpose: the
 * delegate freezes the RENDERED text at open time (a tooltip that rewrites
 * itself under a reader is worse than one that is half a second stale), while it
 * keeps `data-tip` in sync through a MutationObserver. So a test waiting for a
 * value that arrives late - a fleet sample, a measurement - has to look at
 * `data-tip`. Use the visible node instead when what you are testing is what the
 * person sees on screen.
 */
export async function tooltipText(el: Locator): Promise<string> {
  return await el.evaluate(
    (n) => (n as HTMLElement).getAttribute("data-tip") ?? (n as HTMLElement).getAttribute("title") ?? "",
  );
}
