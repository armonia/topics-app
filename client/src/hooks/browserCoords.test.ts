/**
 * Mapping a click on the rendered page surface back to page coordinates.
 *
 * @covers BROWSER-02
 */
import { describe, it, expect } from 'bun:test';
import { mapCoordinates } from './browserCoords';

// Pure-logic guard for the HiDPI click-mapping fix (RISK 1): the coordinate
// basis MUST be CSS px (deviceWidth/Height or naturalW÷dsf), never the frame's
// raw pixel dimensions — otherwise a DPR>1 pane sends ~dsf× the intended coords
// and every click lands off-target. page.mouse.click wants CSS-px coordinates.

type MEvt = Parameters<typeof mapCoordinates>[0];
type MImg = Parameters<typeof mapCoordinates>[1];

const img = (naturalWidth: number, naturalHeight: number, rect: { left: number; top: number; width: number; height: number }): MImg =>
  ({
    naturalWidth,
    naturalHeight,
    getBoundingClientRect: () => ({
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top,
      toJSON() {},
    }),
  }) as unknown as MImg;

const evt = (clientX: number, clientY: number): MEvt => ({ clientX, clientY }) as unknown as MEvt;

describe('mapCoordinates', () => {
  const rect = { left: 0, top: 0, width: 1280, height: 720 };

  it('DPR=1, no metadata (legacy/mock frames): center → CSS-px center', () => {
    // naturalW = CSS width, deviceWidth absent → basis = naturalW/1 = 1280.
    const c = mapCoordinates(evt(640, 360), img(1280, 720, rect), { pageScaleFactor: 1 });
    expect(c).toEqual({ x: 640, y: 360 });
  });

  it('HiDPI via deviceWidth: 2× frame maps to CSS px, NOT frame px (the bug)', () => {
    // Frame is 2560×1440 (retina backing store) but deviceWidth/Height are CSS
    // px (1280×720). A click at the visual center must map to 640/360 — mapping
    // against naturalWidth would (wrongly) give 1280/720.
    const c = mapCoordinates(evt(640, 360), img(2560, 1440, rect), {
      pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 720, deviceScaleFactor: 2,
    });
    expect(c).toEqual({ x: 640, y: 360 });
  });

  it('HiDPI fallback (no deviceWidth): divides naturalW by the client DPR', () => {
    const c = mapCoordinates(evt(640, 360), img(2560, 1440, rect), {
      pageScaleFactor: 1, deviceScaleFactor: 2,
    });
    expect(c).toEqual({ x: 640, y: 360 });
  });

  it('pinch-zoom (pageScaleFactor) still divides out', () => {
    const c = mapCoordinates(evt(640, 360), img(1280, 720, rect), {
      pageScaleFactor: 2, deviceWidth: 1280, deviceHeight: 720,
    });
    expect(c).toEqual({ x: 320, y: 180 });
  });

  it('click outside the letterboxed image returns null', () => {
    // Tall container (aspect < image): image is letterboxed vertically; a click
    // in the top letterbox band (y=10) is outside the image.
    const tall = { left: 0, top: 0, width: 1280, height: 1000 };
    const c = mapCoordinates(evt(640, 10), img(1280, 720, tall), { pageScaleFactor: 1 });
    expect(c).toBeNull();
  });
});
