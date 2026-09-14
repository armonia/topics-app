/**
 * THE NEGATIVE THAT CAN STILL FAIL: "no address row above the page".
 *
 * It used to be written as `browser-url-input → count 0`, and since
 * `BrowserToolbar` was deleted that testid exists nowhere: the assertion passes
 * over any app, including one that grows a new strip tomorrow under another
 * name. HERO-R-003, in one line, and it was still in thirteen places across
 * three specs after the file that first named it had moved on.
 *
 * So it is measured as GEOMETRY, which is what the requirement is actually
 * about (the "no address row, ever" scenario of `TOPIC-BROWSER-02`): the page area
 * of a browser pane starts at the pane's own top edge. A chrome strip of any
 * name, any testid, pushes it down and this goes red. The find bar is the one
 * admitted exception and it is a MODE - it exists only while you are
 * searching - so a scene that is not searching must not see it.
 *
 * The page area is the frame slot (iframe path) or the native slot (desktop
 * shell); on the streaming path it is the pane's last flex child, the
 * screenshot viewer.
 */
import { expect, type Page } from "@playwright/test";

/** How far below its pane's top edge the first browser pane's page area
 *  starts, once that distance has stopped changing for `quietMs`. */
export async function settledGapAboveThePage(page: Page, quietMs: number): Promise<number> {
  const handle = await page.waitForFunction(
    (quiet) => {
      const w = window as unknown as { __pageGapSeen?: number; __pageGapSince?: number };
      const pane = document.querySelector("[data-browser-pane]");
      const area = pane?.querySelector("[data-browser-frame-slot], [data-native-browser-slot]")
        ?? pane?.lastElementChild;
      // No pane mounted (yet) is not a distance: keep waiting instead of
      // settling on a sentinel that would read as "no row".
      if (!pane || !area) {
        w.__pageGapSeen = undefined;
        return null;
      }
      const gap = Math.round(area.getBoundingClientRect().top - pane.getBoundingClientRect().top);
      const now = performance.now();
      if (w.__pageGapSeen !== gap) {
        w.__pageGapSeen = gap;
        w.__pageGapSince = now;
        return null;
      }
      // An OBJECT, not the number: `waitForFunction` reads the return value as
      // "am I done?", and a settled gap of zero - the good case - is falsy.
      return now - (w.__pageGapSince ?? now) >= quiet ? { gap } : null;
    },
    quietMs,
    { timeout: 30_000, polling: "raf" },
  );
  // `waitForFunction` only resolves on a truthy value; the fallback names the
  // impossible case with a gap no pane can have, so it fails loudly.
  const settled = (await handle.jsonValue()) ?? { gap: Number.POSITIVE_INFINITY };
  await page.evaluate(() => {
    const w = window as unknown as { __pageGapSeen?: number; __pageGapSince?: number };
    delete w.__pageGapSeen;
    delete w.__pageGapSince;
  });
  return settled.gap;
}

/** The page area starts at the pane's top edge right now (one stable frame). */
export async function expectNoRowAboveThePage(page: Page, why: string): Promise<void> {
  expect(await settledGapAboveThePage(page, 0), why).toBeLessThanOrEqual(1);
}

/**
 * No row comes back ON ITS OWN: the gap is measured once it has been still for
 * `quietMs`. A row that reappears restarts the quiet period and is then read as
 * present, which is the failure this exists to catch; a clean run stops as soon
 * as it is quiet, instead of sleeping a fixed window.
 */
export async function expectNoRowComesBack(page: Page, why: string, quietMs = 2_000): Promise<void> {
  expect(await settledGapAboveThePage(page, quietMs), why).toBeLessThanOrEqual(1);
}

/** One element found layered over the page, described well enough to fix it. */
export interface OverlayOffender {
  /** `data-testid` when it has one, else `tag.class.class` — so an element that
   *  never had a testid is still nameable. */
  what: string;
  /** Why it was a candidate at all: its computed `position`. */
  position: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * EVERY ELEMENT LAYERED OVER A BROWSER PANE'S PAGE — the negative of
 * `TOPIC-BROWSER-03`, measured as geometry.
 *
 * WHY NOT THREE `toHaveCount(0)`. The pills this requirement killed were
 * `browser-connection-indicator`, `browser-engine-toggle` and
 * `browser-render-toggle`, and counting those three names to zero is green over
 * any app on earth — including one that replants a pill tomorrow under a fourth
 * name. Same defect as `browser-url-input → count 0` at the top of this file:
 * HERO-R-003, an assertion that cannot fail for the reason it was written.
 *
 * So the question asked here is the one the requirement actually asks: IS
 * ANYTHING SITTING ON TOP OF THE PAGE? The page rect is resolved the way the
 * pane draws it, the candidates are the elements that can be layered at all
 * (computed `position` absolute / fixed / sticky — a static wrapper cannot
 * cover anything), and what comes back is a NAMED list, so a failure says which
 * element broke through instead of "expected 0, got 1".
 *
 * WHAT IS ADMITTED, AND WHY EACH ONE:
 *  - the page surface itself (the hosted-frame layer, the <video>, the rrweb
 *    mirror): it is not over the page, it IS the page;
 *  - `browser-nav-error`: a failed navigation reported where the page would be,
 *    cleared by the next navigation — the alternative was reporting it nowhere;
 *  - `browser-tab-sheet`: portalled to the body and covering on purpose, only
 *    while it is open, and the pane parks its page behind a still for exactly
 *    that reason;
 *  - `browser-dom-select-mode`: the temporary, user-armed element-select mode,
 *    which the requirement admits in so many words:
 *    «uno stato temporaneo attivato dall'utente ... resta ammesso finché la modalità è attiva» (allow-italian: the requirement is quoted verbatim).
 *
 * Nothing else is listed, deliberately: an overlay this list does not know
 * arrives NAMED in the failure message, and whoever reads it decides whether it
 * is a bug or a fifth admitted state. A pre-emptive allowlist would have
 * decided that in advance, for scenes nobody has run yet.
 */
export async function elementsOverThePage(page: Page): Promise<OverlayOffender[]> {
  return page.evaluate(() => {
    const pane = document.querySelector("[data-browser-pane]");
    if (!pane) return [{ what: "(no browser pane mounted)", position: "-", rect: { x: 0, y: 0, width: 0, height: 0 } }];

    // THE RECT WHERE THE PAGE'S PIXELS ARE, per render path. Not the pane's
    // container: on the streaming path that container is the very box the three
    // pills lived INSIDE, so measuring against it would have excluded them as
    // "descendants" and answered "nothing over the page" while they floated
    // there.
    const area =
      pane.querySelector("[data-browser-frame-slot], [data-native-browser-slot]")
      ?? pane.querySelector('[data-testid="browser-dom-cobrowse"]')
      ?? pane.querySelector('[data-testid="browser-webrtc-video"]')
      ?? pane.lastElementChild;
    if (!area) return [{ what: "(no page area in the pane)", position: "-", rect: { x: 0, y: 0, width: 0, height: 0 } }];

    const ADMITTED = [
      "[data-browser-frame-layer]",           // the hosted frame: it IS the page
      '[data-testid="browser-dom-cobrowse"]', // the rrweb mirror: it IS the page
      '[data-testid="browser-webrtc-video"]', // the pixel stream: it IS the page
      '[data-testid="browser-nav-error"]',    // a failed goto, reported in place
      '[data-testid="browser-tab-sheet"]',    // portalled, covers on purpose
      '[data-testid="browser-dom-select-mode"]', // temporary, user-armed mode
    ].join(",");

    const page_ = area.getBoundingClientRect();
    if (page_.width < 1 || page_.height < 1) {
      return [{ what: "(page area has no size)", position: "-", rect: { x: 0, y: 0, width: 0, height: 0 } }];
    }

    const out: OverlayOffender[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      // DOM relatives are not overlays: everything containing the page area
      // (body, the layout, the pane) geometrically covers it by definition, and
      // everything inside it is the page's own content.
      if (el.contains(area) || area.contains(el)) continue;
      if (el.closest(ADMITTED)) continue;

      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.visibility === "hidden" || Number(cs.opacity) < 0.02) continue;

      const r = el.getBoundingClientRect();
      // A 1px seam between two boxes is not something sitting on the page.
      const overlapW = Math.min(r.right, page_.right) - Math.max(r.left, page_.left);
      const overlapH = Math.min(r.bottom, page_.bottom) - Math.max(r.top, page_.top);
      if (overlapW < 2 || overlapH < 2) continue;

      const testId = el.getAttribute("data-testid");
      const classes = el.className && typeof el.className === "string"
        ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : "";
      out.push({
        what: testId ?? `${el.tagName.toLowerCase()}${classes}`,
        position: cs.position,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      });
    }
    return out;
  });
}

/** Nothing is layered over the page right now, and a failure names what is. */
export async function expectNothingOverThePage(page: Page, why: string): Promise<void> {
  const found = await elementsOverThePage(page);
  expect(
    found,
    `${why} — sopra la pagina: ${found.map((f) => `${f.what} (${f.position}, ${f.rect.width}x${f.rect.height} @ ${f.rect.x},${f.rect.y})`).join("; ")}`,
  ).toEqual([]);
}
