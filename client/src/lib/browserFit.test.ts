/**
 * @covers TOPIC-BROWSER-05
 */
import { test, expect } from "bun:test";
import { boxUnderKeyboard, fitCentered, viewportFromRrwebEvent } from "./browserFit";

test("a phone watching a desktop page gets it scaled and centred vertically", () => {
  const fit = fitCentered({ width: 390, height: 700 }, { width: 1280, height: 800 });
  expect(fit.scale).toBeCloseTo(390 / 1280, 6);
  expect(fit.left).toBe(0);
  // 700 - 800 * (390/1280) = 456.25 of leftover, half above and half below.
  expect(fit.top).toBe(228);
});

test("a desktop watching a phone page gets it centred horizontally", () => {
  const fit = fitCentered({ width: 1280, height: 800 }, { width: 390, height: 700 });
  expect(fit.scale).toBeCloseTo(800 / 700, 6);
  expect(fit.top).toBe(0);
  expect(fit.left).toBeGreaterThan(200);
});

test("same size means no scale and no offset", () => {
  expect(fitCentered({ width: 1280, height: 800 }, { width: 1280, height: 800 })).toEqual({
    scale: 1,
    left: 0,
    top: 0,
  });
});

test("an unmeasured container paints at 1:1 instead of dividing by zero", () => {
  expect(fitCentered({ width: 0, height: 0 }, { width: 1280, height: 800 })).toEqual({
    scale: 1,
    left: 0,
    top: 0,
  });
  expect(fitCentered({ width: 1280, height: 800 }, { width: 0, height: 0 })).toEqual({
    scale: 1,
    left: 0,
    top: 0,
  });
});

test("Meta announces the page size at the start of the recording", () => {
  expect(viewportFromRrwebEvent({ type: 4, data: { width: 1280, height: 800 } })).toEqual({
    width: 1280,
    height: 800,
  });
});

test("a mid-session ViewportResize announces the new size too", () => {
  expect(
    viewportFromRrwebEvent({ type: 3, data: { source: 4, width: 390, height: 700 } }),
  ).toEqual({ width: 390, height: 700 });
});

test("any other incremental event announces nothing", () => {
  // source 3 is a scroll: same event type, and it carries no size at all.
  expect(viewportFromRrwebEvent({ type: 3, data: { source: 3 } })).toBeNull();
  expect(viewportFromRrwebEvent({ type: 2, data: { width: 800, height: 600 } })).toBeNull();
  expect(viewportFromRrwebEvent({ type: 4, data: {} })).toBeNull();
  expect(viewportFromRrwebEvent(null)).toBeNull();
});

test("the page laid out at this pane's own size is shown 1:1 from the top, a host rounding pixel included", () => {
  expect(fitCentered({ width: 1180, height: 820 }, { width: 1180, height: 819 }, { width: 1180, height: 820 })).toEqual({
    scale: 1,
    left: 0,
    top: 0,
  });
});

test("a small Mac pane lays this pane's page out a few pixels short: still 1:1 from the top", () => {
  for (const pane of [{ width: 1180, height: 820 }, { width: 1180, height: 480 }]) {
    expect(fitCentered(pane, { width: 1180, height: 806 }, { width: 1180, height: 820 })).toEqual({ scale: 1, left: 0, top: 0 });
  }
});

test("with the keyboard up the pane is shorter than its page, and the page stays 1:1", () => {
  expect(fitCentered({ width: 1180, height: 480 }, { width: 1180, height: 820 }, { width: 1180, height: 820 })).toEqual({
    scale: 1,
    left: 0,
    top: 0,
  });
});

test("somebody else's page that happens to be as wide is still fitted whole", () => {
  const fit = fitCentered({ width: 1180, height: 820 }, { width: 1180, height: 1400 }, { width: 1180, height: 820 });
  expect(fit.scale).toBeCloseTo(820 / 1400, 6);
});

test("a pane that just turned fits the old page until the new one comes", () => {
  const fit = fitCentered({ width: 820, height: 1180 }, { width: 1180, height: 820 }, { width: 1180, height: 820 });
  expect(fit.scale).toBeCloseTo(820 / 1180, 6);
});

test("the on-screen keyboard does not lay the shared page out again; anything else does", () => {
  const last = { w: 1180, h: 820 };
  expect(boxUnderKeyboard(last, { w: 1180, h: 480 }, true)).toEqual({ w: 1180, h: 820 });
  expect(boxUnderKeyboard(last, { w: 1180, h: 480 }, false)).toEqual({ w: 1180, h: 480 });
  // turned with the keyboard up: a new width is a new viewport
  expect(boxUnderKeyboard(last, { w: 820, h: 700 }, true)).toEqual({ w: 820, h: 700 });
  // and growing is never held back
  expect(boxUnderKeyboard(last, { w: 1180, h: 900 }, true)).toEqual({ w: 1180, h: 900 });
});
