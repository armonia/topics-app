/**
 * The Mac's pane laid out at the size of the device using its page.
 *
 * @covers NATIVE-HOST-04
 */
import { describe, expect, test } from 'bun:test';
import { INSTALL_USE_HOOK, MIN_PAGE_ZOOM, paneView, usedSince } from './paneViewport';

const slot = { x: 100, y: 50, width: 1600, height: 1000 };
const ipad = { width: 1180, height: 820 };

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
    expect(rect.width / pageZoom).toBeCloseTo(1180, 6);
    expect(Math.abs(rect.height / pageZoom - 820)).toBeLessThanOrEqual(1);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo((700 - rect.height) / 2, 6);
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
    expect(paneView({ x: 0, y: 0, width: 100, height: 100 }, { remote: ipad, canZoom: true }).pageZoom).toBe(MIN_PAGE_ZOOM);
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
