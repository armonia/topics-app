/**
 * The Mac's pane laid out at the size of the device using its page.
 *
 * @covers NATIVE-HOST-04
 */
import { describe, expect, test } from 'bun:test';
import { INSTALL_USE_HOOK, MIN_PAGE_ZOOM, paneView, parkedView, usedSince, zoomFloor32 } from './paneViewport';

const slot = { x: 100, y: 50, width: 1600, height: 1000 };
const ipad = { width: 1180, height: 820 };

/**
 * The page WKWebView lays out for a frame and a zoom, as measured on it: the
 * frame in whole points, the zoom as a float32, the quotient floored. A float32
 * zoom above the quotient is what turned 246/820 into a page 819 wide.
 */
const webkitLayout = (rect: { width: number; height: number }, zoom: number) => ({
  width: Math.floor(Math.floor(rect.width) / Math.fround(zoom)),
  height: Math.floor(Math.floor(rect.height) / Math.fround(zoom)),
});

describe('paneView', () => {
  test('a device that fits gets its size, whole, in the middle of the slot', () => {
    expect(paneView(slot, { remote: ipad, canZoom: true })).toEqual({
      rect: { x: 100 + 210, y: 50 + 90, width: 1180, height: 820 },
      pageZoom: 1,
    });
  });

  test('a device larger than the slot is scaled down, and laid out exactly as wide as it is', () => {
    const { rect, pageZoom } = paneView({ x: 0, y: 0, width: 900, height: 700 }, { remote: ipad, canZoom: true });
    expect(rect.width).toBe(900);
    expect(webkitLayout(rect, pageZoom)).toEqual({ width: 1180, height: 820 });
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo((700 - rect.height) / 2, 6);
  });

  test('in any slot down to a tenth of a window: exactly the device width, the height never above its own', () => {
    const devices = [ipad, { width: 820, height: 1180 }, { width: 1366, height: 1024 }, { width: 390, height: 844 }];
    let exactHeights = 0;
    let cases = 0;
    for (const device of devices) {
      for (let w = 100; w <= 1700; w += 7) {
        for (let h = 80; h <= 1300; h += 41) {
          const slotRect = { x: 0, y: 0, width: w, height: h };
          const { rect, pageZoom } = paneView(slotRect, { remote: device, canZoom: true });
          const page = webkitLayout(rect, pageZoom);
          expect(page.width).toBe(device.width);
          expect(page.height).toBeLessThanOrEqual(device.height);
          // Short by less than one frame point, the most a whole frame can miss by.
          expect(page.height).toBeGreaterThan(device.height - 1 / pageZoom - 1);
          expect(rect.width).toBeLessThanOrEqual(w);
          expect(rect.height).toBeLessThanOrEqual(h);
          if (page.height === device.height) exactHeights++;
          cases++;
        }
      }
    }
    // Exact whenever a whole frame height allows it, which is most of the time.
    expect(exactHeights / cases).toBeGreaterThan(0.5);
  });

  test('the zoom is the float32 WebKit keeps, never one above the quotient', () => {
    const { rect, pageZoom } = paneView({ x: 0, y: 0, width: 246, height: 600 }, { remote: { width: 820, height: 1180 }, canZoom: true });
    expect(rect.width).toBe(246);
    expect(Math.fround(pageZoom)).toBe(pageZoom);
    expect(pageZoom).toBeLessThanOrEqual(246 / 820);
    expect(webkitLayout(rect, pageZoom).width).toBe(820);
    expect(zoomFloor32(0.3)).toBeLessThan(0.3);
    expect(zoomFloor32(0.5)).toBe(0.5);
  });

  test('never scaled up', () => {
    expect(paneView(slot, { remote: { width: 390, height: 700 }, canZoom: true }).pageZoom).toBe(1);
  });

  test('without page zoom the size is only clamped to the slot', () => {
    expect(paneView({ x: 0, y: 0, width: 900, height: 700 }, { remote: ipad, canZoom: false })).toEqual({
      rect: { x: 0, y: 0, width: 900, height: 700 },
      pageZoom: 1,
    });
  });

  test('the device using the page wins over the emulated one, which comes back after', () => {
    const phone = { width: 390, height: 844 };
    expect(paneView(slot, { remote: ipad, device: phone, canZoom: true }).rect.width).toBe(1180);
    expect(paneView(slot, { device: phone, canZoom: true })).toEqual({
      rect: { x: 100 + 605, y: 50 + 78, width: 390, height: 844 },
      pageZoom: 1,
    });
    expect(paneView(slot, { canZoom: true })).toEqual({ rect: slot, pageZoom: 1 });
  });

  test('the zoom stops where the shell stops it', () => {
    expect(paneView({ x: 0, y: 0, width: 40, height: 40 }, { remote: ipad, canZoom: true }).pageZoom).toBe(MIN_PAGE_ZOOM);
  });
});

describe('parkedView', () => {
  // The iPad turning while the Mac's pane is parked: each new size is laid
  // out from the same footing, never from the frame the last one left behind.
  const turns = [ipad, { width: 820, height: 1180 }, ipad, { width: 820, height: 1180 }, ipad];
  const park = (slotRect: { x: number; y: number; width: number; height: number } | null) => {
    let last = { width: 800, height: 600 };
    return turns.map((remote) => {
      const { rect, pageZoom } = parkedView(slotRect, { remote, canZoom: true, last });
      last = { width: Math.round(rect.width), height: Math.round(rect.height) };
      return webkitLayout(rect, pageZoom);
    });
  };

  test('a pane born hidden, with no slot measured: every turn is laid out at its own size', () => {
    expect(park(null)).toEqual(turns);
  });

  test('a parked pane with its slot: every turn is laid out at its own size', () => {
    for (const page of park({ x: 0, y: 0, width: 900, height: 700 })) {
      expect(turns.some((t) => t.width === page.width && t.height >= page.height)).toBe(true);
    }
    expect(park({ x: 0, y: 0, width: 900, height: 700 }).map((p) => p.width)).toEqual(turns.map((t) => t.width));
  });

  test('the Mac taking the page back while parked keeps the last size, at zoom 1', () => {
    expect(parkedView(null, { remote: null, canZoom: true, last: { width: 640, height: 480 } })).toEqual({
      rect: { x: 0, y: 0, width: 640, height: 480 },
      pageZoom: 1,
    });
  });
});

describe('usedSince', () => {
  test('the first read is a baseline', () => {
    expect(usedSince(-1, 3)).toBe(false);
  });
  test('a count that grew is a use', () => {
    expect(usedSince(3, 4)).toBe(true);
    expect(usedSince(3, 3)).toBe(false);
  });
  test('a new document counts from zero: above zero is news, zero is not', () => {
    expect(usedSince(5, 1)).toBe(true);
    expect(usedSince(5, 0)).toBe(false);
  });
});

describe('INSTALL_USE_HOOK', () => {
  test('only gestures of the person at the Mac count: not relayed input, not a modifier, not a Cmd shortcut', () => {
    const on: Record<string, (e: { isTrusted: boolean; key?: string; metaKey?: boolean }) => void> = {};
    const win: { __topicsLocalUse?: number } = {};
    new Function('window', 'addEventListener', INSTALL_USE_HOOK)(win, (type: string, fn: (typeof on)[string]) => { on[type] = fn; });
    for (const key of ['a', 'ArrowDown']) on.keydown({ isTrusted: true, key });
    for (const key of ['Shift', 'Meta', 'Alt']) on.keydown({ isTrusted: true, key });
    on.keydown({ isTrusted: true, key: 'Tab', metaKey: true });
    on.keydown({ isTrusted: false, key: 'b' });
    on.pointerdown({ isTrusted: true });
    on.pointerdown({ isTrusted: false });
    on.wheel({ isTrusted: true });
    expect(win.__topicsLocalUse).toBe(4);
  });
});
