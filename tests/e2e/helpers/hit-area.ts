import type { Page } from "@playwright/test";

/**
 * THE AREA A THUMB ACTUALLY FINDS, which is not the one `boundingBox()` reports.
 *
 * The repo grows small targets with `.tap-expand` / `.tap-expand-y`: an `::after`
 * that enlarges the SENSITIVE area without touching the layout box. A
 * pseudo-element does not appear in `getBoundingClientRect()`, so a spec that
 * measures the box reads 16x16 on a target the finger finds at 44, and — worse —
 * would stay GREEN if somebody deleted the class, because the box would not
 * move by a pixel.
 *
 * So the measure here is the only one the thumb agrees with: grow a band out of
 * the centre while `document.elementFromPoint` still answers "that is me (or a
 * child of mine)". Same method as `tab-close-ring-touch.spec.ts`, which proved
 * it on the tab's close ring; it lives here so the next surface does not
 * reinvent it.
 */
export interface TargetMeasure {
  /** `aria-label`, `title`, or a slice of the class: enough to name it in a failure. */
  label: string;
  /** The LAYOUT box, for comparison with the sensitive area. */
  box: { w: number; h: number };
  /** The sensitive band around the centre, the number that matters. */
  tap: { w: number; h: number };
  /** False = the centre belongs to somebody else (a neighbour covers it). */
  ownsItsCentre: boolean;
  /** True = zero-sized, i.e. NOT a small target but an absent one. */
  absent: boolean;
}

/**
 * Measures every element matching the selectors, in one page evaluation.
 *
 * `cap` bounds the walk: without it a full-screen target would loop forever if
 * `elementFromPoint` always answered. 60 is past the 44 threshold, so it can
 * never hide a target that is too small — only cut short the story of a huge one.
 */
export async function measureTargets(page: Page, selectors: string[], cap = 60): Promise<TargetMeasure[]> {
  return page.evaluate(({ sels, cap }) => {
    const els = sels.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]);
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.className.slice(0, 30);
      const box = { w: Math.round(r.width), h: Math.round(r.height) };
      // A hover-revealed command on a device with no pointer is not a small
      // target, it is an absent one: demanding 44px of it would be measuring
      // nothing at all.
      if (box.w === 0 || box.h === 0) {
        return { label, box, tap: { w: 0, h: 0 }, ownsItsCentre: false, absent: true };
      }
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const mine = (x: number, y: number) => {
        const h = document.elementFromPoint(x, y);
        return !!h && (el === h || el.contains(h));
      };
      if (!mine(cx, cy)) {
        return { label, box, tap: { w: 0, h: 0 }, ownsItsCentre: false, absent: false };
      }
      let left = cx, right = cx, top = cy, bottom = cy;
      while (cx - left < cap && mine(left - 1, cy)) left--;
      while (right - cx < cap && mine(right + 1, cy)) right++;
      while (cy - top < cap && mine(cx, top - 1)) top--;
      while (bottom - cy < cap && mine(cx, bottom + 1)) bottom++;
      return {
        label,
        box,
        tap: { w: right - left + 1, h: bottom - top + 1 },
        ownsItsCentre: true,
        absent: false,
      };
    });
  }, { sels: selectors, cap });
}

/**
 * A touch drag that a `TouchSensor` accepts: HELD first, then moved.
 *
 * Playwright has no touch-drag primitive, and `mouse.move` is not one either:
 * the board arms dnd-kit's `PoliteTouchSensor` on `onTouchStart` with a 200ms
 * delay, so a synthetic mouse gesture proves the sensor that was never broken.
 * The events are built INSIDE the page because React reads
 * `e.touches[0].clientX` and a plain object literal has no `Touch` in it.
 *
 * The shape matters and is the one a thumb makes: press, hold past the delay,
 * then several small moves (one jump would look like a teleport and the
 * intermediate `dragOver` would never fire, so the board would never know which
 * column it is over), then lift.
 */
export async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { holdMs?: number; steps?: number } = {},
): Promise<void> {
  const { holdMs = 250, steps = 6 } = opts;
  await page.evaluate(({ from }) => {
    const el = document.elementFromPoint(from.x, from.y);
    if (!el) throw new Error(`no element at ${from.x},${from.y}`);
    const touch = new Touch({ identifier: 1, target: el, clientX: from.x, clientY: from.y });
    (window as unknown as { __drag?: { el: Element } }).__drag = { el };
    el.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch],
    }));
  }, { from });

  // The sensor's activation delay is 200ms and it runs on the SAME main thread
  // as the board's render: this waits it out rather than racing it.
  await page.waitForTimeout(holdMs);

  await page.evaluate(({ from, to, steps }) => {
    const held = (window as unknown as { __drag?: { el: Element } }).__drag;
    if (!held) throw new Error("no touch in flight");
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
      const t = new Touch({ identifier: 1, target: held.el, clientX: x, clientY: y });
      held.el.dispatchEvent(new TouchEvent("touchmove", {
        bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t],
      }));
    }
  }, { from, to, steps });

  // dnd-kit measures collisions on a rAF loop: the drop must land after the
  // board has seen where the finger got to.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

  await page.evaluate(({ to }) => {
    const held = (window as unknown as { __drag?: { el: Element } }).__drag;
    if (!held) return;
    const t = new Touch({ identifier: 1, target: held.el, clientX: to.x, clientY: to.y });
    held.el.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t],
    }));
    delete (window as unknown as { __drag?: unknown }).__drag;
  }, { to });
}

/**
 * A point INSIDE the card that the drag sensor will accept.
 *
 * `PoliteTouchSensor` is deliberately deaf to fields and commands
 * (`dndSensors.ts`), so aiming at the geometric centre is a coin flip: a chip, a
 * button or the reply box may be sitting there, and the gesture would be
 * correctly ignored — the test would then report "the drag is broken" about the
 * one case where it is behaving. This scans the card for a point that belongs
 * to no control.
 */
export async function grabPoint(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const NOT_A_HANDLE = 'input, textarea, select, button, a, [contenteditable="true"], [data-no-dnd]';
    // Down the card's left edge, where the title and the paddings live: the
    // commands cluster on the right and at the bottom.
    for (const fy of [0.18, 0.3, 0.12, 0.45, 0.6]) {
      for (const fx of [0.25, 0.4, 0.12, 0.55]) {
        const x = Math.round(r.x + r.width * fx);
        const y = Math.round(r.y + r.height * fy);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !el.contains(hit)) continue;
        if (hit.closest(NOT_A_HANDLE)) continue;
        return { x, y };
      }
    }
    return null;
  }, selector);
  if (!pt) throw new Error(`no draggable point inside ${selector}`);
  return pt;
}
