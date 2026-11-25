/**
 * @covers TABPOS-01
 */
import { describe, expect, test } from 'bun:test';
import { tabsPlacement } from './tabsPlacement';

describe('tabsPlacement: every tab in one place', () => {
  test('side, column open: the column holds the tabs, no strip', () => {
    expect(tabsPlacement('side', { phone: false }))
      .toEqual({ strip: false, columnSkipsStrip: false });
  });

  test('side, column closed: still no strip, the tabs are in one place or the other (25/11)', () => {
    expect(tabsPlacement('side', { phone: false }))
      .toEqual({ strip: false, columnSkipsStrip: false });
  });

  test('top: the strip holds the tabs and the column leaves them out', () => {
    expect(tabsPlacement('top', { phone: false }))
      .toEqual({ strip: true, columnSkipsStrip: true });
  });

  test('both (the layout of before, not offered in the View level): strip and full column', () => {
    expect(tabsPlacement('both', { phone: false }))
      .toEqual({ strip: true, columnSkipsStrip: false });
  });

  test('phone: the desktop choice does not reach it', () => {
    for (const position of ['side', 'top'] as const) {
      expect(tabsPlacement(position, { phone: true }))
        .toEqual({ strip: false, columnSkipsStrip: false });
    }
  });

  test('one place or the other: side never draws the strip, top always does', () => {
    expect(tabsPlacement('side', { phone: false }).strip).toBe(false);
    expect(tabsPlacement('top', { phone: false }).strip).toBe(true);
  });
});
