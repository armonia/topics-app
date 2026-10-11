import { describe, expect, it } from 'bun:test';
import { tabDensity, type TabDensityTab } from './tabDensity';

const mixedTabs: TabDensityTab[] = [
  { naturalPx: 150, active: true },
  { naturalPx: 150, active: false },
  { naturalPx: 200, active: false },
  { naturalPx: 150, active: false },
  { naturalPx: 150, active: false },
  { naturalPx: 150, active: false },
];

const gapPx = 6;
const tabHeightPx = 28;

describe('tabDensity', () => {
  it('keeps today’s widths while every tab and gap fits', () => {
    expect(tabDensity(1_000, gapPx, tabHeightPx, mixedTabs)).toEqual({
      mode: 'full',
      widths: [150, 150, 200, 150, 150, 150],
    });
  });

  it('shrinks tabs evenly in compact mode without crossing their floors', () => {
    const result = tabDensity(600, gapPx, tabHeightPx, mixedTabs);
    expect(result.mode).toBe('compact');
    expect(result.widths[0]).toBeGreaterThanOrEqual(120);
    for (const [index, width] of result.widths.entries()) {
      if (index !== 0) expect(width).toBeGreaterThanOrEqual(76);
    }
  });

  it('turns inactive tabs into squares and keeps the active tab readable', () => {
    const result = tabDensity(300, gapPx, tabHeightPx, mixedTabs);
    expect(result.mode).toBe('square');
    expect(result.widths[0]).toBeGreaterThanOrEqual(96);
    for (const [index, width] of result.widths.entries()) {
      if (index !== 0) expect(width).toBe(tabHeightPx);
    }
  });

  it('keeps a single tab inside the available width down to its square size', () => {
    const result = tabDensity(64, gapPx, tabHeightPx, [{ naturalPx: 300, active: true }]);
    expect(result.mode).toBe('square');
    expect(result.widths[0]).toBeLessThanOrEqual(64);
    expect(result.widths[0]).toBeGreaterThanOrEqual(tabHeightPx);
    expect(tabDensity(500, gapPx, tabHeightPx, [{ naturalPx: 16, active: true }]).widths[0]).toBeGreaterThanOrEqual(tabHeightPx);
  });

  it('honors degraded-mode floors when natural widths are unusually small', () => {
    const compact = tabDensity(200, 0, tabHeightPx, [
      { naturalPx: 200, active: true },
      { naturalPx: 16, active: false },
    ]);
    expect(compact.mode).toBe('compact');
    expect(compact.widths[0]).toBeGreaterThanOrEqual(120);
    expect(compact.widths[1]).toBeGreaterThanOrEqual(76);

    const square = tabDensity(124, 0, tabHeightPx, [
      { naturalPx: 80, active: true },
      { naturalPx: 60, active: false },
    ]);
    expect(square.mode).toBe('square');
    expect(square.widths[0]).toBeGreaterThanOrEqual(96);
    expect(square.widths[1]).toBe(tabHeightPx);
  });

  it('keeps the narrowest multi-tab layout monotone and scrolls only below square capacity', () => {
    const availableWidths = [1_000, 700, 600, 500, 340, 266, 240];
    const occupiedWidths = availableWidths.map((available) => {
      const result = tabDensity(available, gapPx, tabHeightPx, mixedTabs);
      return result.widths.reduce((sum, width) => sum + width, 0) + gapPx * (mixedTabs.length - 1);
    });
    for (let index = 1; index < occupiedWidths.length; index += 1) {
      expect(occupiedWidths[index]).toBeLessThanOrEqual(occupiedWidths[index - 1]!);
    }
    expect(tabDensity(240, gapPx, tabHeightPx, mixedTabs).mode).toBe('scroll');
  });

  it('returns the same result for the same input', () => {
    const first = tabDensity(300, gapPx, tabHeightPx, mixedTabs);
    expect(tabDensity(300, gapPx, tabHeightPx, mixedTabs)).toEqual(first);
  });

  it('returns an empty full layout for no tabs', () => {
    expect(tabDensity(0, gapPx, tabHeightPx, [])).toEqual({ mode: 'full', widths: [] });
  });
});
