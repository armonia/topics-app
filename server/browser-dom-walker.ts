/**
 * Page-portable DOM walker + annotated-screenshot helpers.
 *
 * These two operations used to live inline in BrowserService (Phase 30,
 * Playwright server-launched Chromium). They are plain `page.evaluate`
 * scripts and work on ANY Playwright `Page` — including a page resolved via
 * `chromium.connectOverCDP` against the Electron host (the real, user-visible
 * WebContentsView).
 *
 * Extracting them here lets both render paths share ONE implementation:
 *   - BrowserService (web mode) walks its server-side page.
 *   - cdpOps (Electron native) walks the SAME WebContentsView that the user
 *     sees and that browser_act clicks via CDP — so observe coordinates and
 *     act coordinates finally refer to the same DOM. Before this, observe ran
 *     on a separate headless Chromium and act clicked the native view, a
 *     silent coordinate/DOM mismatch that made native agent control unreliable.
 *
 * Both functions are behaviour-preserving copies of the original inline logic
 * (same selectors, same bbox rounding, same overlay colors, same cleanup).
 */
import type { Page } from "playwright-core";
import type { IndexedElement } from "./browser-tools";

/**
 * Walk the page for interactive elements and return them indexed (1..N).
 * Side effect: writes `data-topics-idx="N"` on each element (cleaned up by
 * captureAnnotatedScreenshotOnPage's finally block, mirroring the original).
 */
export async function extractIndexedElementsOnPage(
  page: Page,
  maxElementsRaw?: number,
): Promise<IndexedElement[]> {
  const maxElements = Math.min(Math.max(maxElementsRaw ?? 50, 1), 100);
  const elements = await page.evaluate((max: number) => {
    const selectors = [
      'button',
      '[role="button"]',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
    ].join(',');

    const seen = new Set<Element>();
    const out: Array<{
      id: number;
      role: string;
      name: string;
      bbox: { x: number; y: number; width: number; height: number };
      text?: string;
      tagName: string;
    }> = [];
    let counter = 0;

    const nodes = document.querySelectorAll(selectors);
    for (const node of Array.from(nodes)) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (out.length >= max) break;

      const rect = node.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      counter += 1;
      const id = counter;
      const el = node as HTMLElement;
      el.setAttribute('data-topics-idx', String(id));

      const tagName = (node.tagName || '').toLowerCase();
      const ariaRole = node.getAttribute('role');
      const role = ariaRole && ariaRole.trim() ? ariaRole : tagName;

      const ariaLabel = node.getAttribute('aria-label');
      const titleAttr = node.getAttribute('title');
      const innerText = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const name =
        (ariaLabel && ariaLabel.trim()) ||
        (titleAttr && titleAttr.trim()) ||
        innerText.slice(0, 80) ||
        '';

      out.push({
        id,
        role,
        name,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        text: innerText.slice(0, 200),
        tagName,
      });
    }
    return out;
  }, maxElements);

  return elements as IndexedElement[];
}

/**
 * Inject a numbered overlay box per indexed element, screenshot the page as
 * JPEG, then strip the overlay + data-topics-idx attributes. Returns the
 * screenshot base64-encoded. Cleanup is in finally (best effort), identical
 * to the original BrowserService implementation.
 */
export async function captureAnnotatedScreenshotOnPage(
  page: Page,
  elements: IndexedElement[],
  quality = 70,
): Promise<string> {
  try {
    await page.evaluate((els: IndexedElement[]) => {
      // Remove any leftover overlay first (idempotent).
      const old = document.getElementById('__topics_observe_overlay');
      if (old) old.remove();

      const colors = ['#16a34a', '#eab308', '#dc2626'];
      const container = document.createElement('div');
      container.id = '__topics_observe_overlay';
      container.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'width:100%',
        'height:100%',
        'pointer-events:none',
        'z-index:2147483647',
      ].join(';');

      for (const el of els) {
        const color = colors[(el.id - 1) % colors.length];
        const box = document.createElement('div');
        box.style.cssText = [
          'position:absolute',
          `left:${el.bbox.x}px`,
          `top:${el.bbox.y}px`,
          `width:${el.bbox.width}px`,
          `height:${el.bbox.height}px`,
          `border:2px solid ${color}`,
          'box-sizing:border-box',
          'pointer-events:none',
        ].join(';');

        const label = document.createElement('span');
        label.textContent = String(el.id);
        label.style.cssText = [
          'position:absolute',
          'top:-20px',
          'left:0',
          'padding:1px 6px',
          `background:${color}`,
          'color:#ffffff',
          'font-family:system-ui,sans-serif',
          'font-size:12px',
          'font-weight:600',
          'border-radius:2px',
          'white-space:nowrap',
        ].join(';');
        box.appendChild(label);
        container.appendChild(box);
      }
      document.body.appendChild(container);
    }, elements);

    let buf: Buffer;
    try {
      buf = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
    } finally {
      // Cleanup overlay + data-topics-idx attrs. Wrapped so a broken page
      // doesn't propagate cleanup errors.
      try {
        await page.evaluate(() => {
          const c = document.getElementById('__topics_observe_overlay');
          if (c) c.remove();
          const indexed = document.querySelectorAll('[data-topics-idx]');
          for (const node of Array.from(indexed)) {
            (node as HTMLElement).removeAttribute('data-topics-idx');
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[browser-dom-walker] captureAnnotatedScreenshot cleanup failed:`, msg);
      }
    }
    return buf.toString('base64');
  } catch (err) {
    // Outer catch: if overlay inject itself failed, attempt cleanup once
    // before rethrowing.
    try {
      await page.evaluate(() => {
        const c = document.getElementById('__topics_observe_overlay');
        if (c) c.remove();
      });
    } catch {}
    throw err;
  }
}
