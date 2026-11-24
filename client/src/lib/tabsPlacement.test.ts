/**
 * @covers TABPOS-01
 */
import { describe, expect, test } from 'bun:test';
import { tabsPlacement } from './tabsPlacement';

describe('tabsPlacement: every tab in one place', () => {
  test('side, column open: the column holds the tabs, no strip', () => {
    expect(tabsPlacement('side', { phone: false, sidebarCollapsed: false }))
      .toEqual({ strip: false, columnSkipsStrip: false });
  });

  test('side, column closed: the tabs come back on top', () => {
    expect(tabsPlacement('side', { phone: false, sidebarCollapsed: true }))
      .toEqual({ strip: true, columnSkipsStrip: false });
  });

  test('top: the strip holds the tabs and the column leaves them out', () => {
    for (const sidebarCollapsed of [false, true]) {
      expect(tabsPlacement('top', { phone: false, sidebarCollapsed }))
        .toEqual({ strip: true, columnSkipsStrip: true });
    }
  });

  test('both (the layout of before, not offered in the View level): strip and full column', () => {
    expect(tabsPlacement('both', { phone: false, sidebarCollapsed: false }))
      .toEqual({ strip: true, columnSkipsStrip: false });
  });

  test('phone: the desktop choice does not reach it', () => {
    for (const position of ['side', 'top'] as const) {
      expect(tabsPlacement(position, { phone: true, sidebarCollapsed: true }))
        .toEqual({ strip: false, columnSkipsStrip: false });
    }
  });

  test('never zero places: with the column closed the strip is always there', () => {
    for (const position of ['side', 'top'] as const) {
      expect(tabsPlacement(position, { phone: false, sidebarCollapsed: true }).strip).toBe(true);
    }
  });
});
