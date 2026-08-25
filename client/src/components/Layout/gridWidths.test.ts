/**
 * Column widths across split, append, normalize, equalize and leaf-weighted
 * resize: the columns a gesture does not touch keep their proportions.
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from 'bun:test';
import { splitColumnWidths, appendColumnWidths, normalizeWidths, keepColumnWidths, equalizeWidths, weightedWidths, chooseSplitOrientation } from './gridWidths';

const approx = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

describe('splitColumnWidths — preserves unaffected columns', () => {
  test('single column splits in half', () => {
    approx(splitColumnWidths([1], 0, 1), [0.5, 0.5]);
  });

  test('splitting the right column leaves the left untouched', () => {
    // [0.3, 0.7], split the 0.7 col to its RIGHT (donor idx 1, insert at 2)
    approx(splitColumnWidths([0.3, 0.7], 1, 2), [0.3, 0.35, 0.35]);
  });

  test('splitting the right column to its LEFT also preserves the sibling', () => {
    // donor idx 1, insert at 1 → new col sits before the (now-halved) target
    approx(splitColumnWidths([0.3, 0.7], 1, 1), [0.3, 0.35, 0.35]);
  });

  test('splitting the left column leaves the right untouched', () => {
    approx(splitColumnWidths([0.3, 0.7], 0, 0), [0.15, 0.15, 0.7]);
  });

  test('result still sums to 1 (relative weights preserved)', () => {
    const out = splitColumnWidths([0.2, 0.5, 0.3], 1, 2);
    expect(out.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
    // the 0.2 and 0.3 siblings are untouched; only the 0.5 is halved
    approx(out, [0.2, 0.25, 0.25, 0.3]);
  });

  test('degenerate donor (zero / missing / NaN) falls back to equal split', () => {
    approx(splitColumnWidths([0], 0, 1), [0.5, 0.5]);
    approx(splitColumnWidths([], 0, 0), [1]); // n+1 = 1 → single equal col
    approx(splitColumnWidths([0.5, 0.5], 5, 1), [1 / 3, 1 / 3, 1 / 3]); // out-of-range donor
  });
});

describe('appendColumnWidths — preserves existing proportions', () => {
  test('appending to an empty row → equal split', () => {
    approx(appendColumnWidths([], 2), [0.5, 0.5]);
  });
  test('appending one column keeps the existing ratio intact', () => {
    // [0.3, 0.7] + 1 col. The new col gets 1/3 share; the existing two stay
    // in 3:7 ratio between themselves and the result sums to 1.
    const out = appendColumnWidths([0.3, 0.7], 1);
    expect(out.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
    expect(out[0] / out[1]).toBeCloseTo(0.3 / 0.7, 6); // ratio preserved
    expect(out[2]).toBeGreaterThan(0);
  });
  test('newCount <= 0 is a no-op copy', () => {
    approx(appendColumnWidths([0.4, 0.6], 0), [0.4, 0.6]);
  });
});

describe('normalizeWidths', () => {
  test('scales to sum 1, proportions intact', () => {
    approx(normalizeWidths([2, 6]), [0.25, 0.75]);
  });
  test('[] → []', () => {
    expect(normalizeWidths([])).toEqual([]);
  });
  test('all-zero → equal', () => {
    approx(normalizeWidths([0, 0, 0]), [1 / 3, 1 / 3, 1 / 3]);
  });
});

describe('equalizeWidths — even split for double-click reset', () => {
  test('n columns → 1/n each, sums to 1', () => {
    approx(equalizeWidths(3), [1 / 3, 1 / 3, 1 / 3]);
    expect(equalizeWidths(4).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
  });
  test('single column → [1]', () => approx(equalizeWidths(1), [1]));
  test('count <= 0 → []', () => {
    expect(equalizeWidths(0)).toEqual([]);
    expect(equalizeWidths(-2)).toEqual([]);
  });
});

describe('weightedWidths — leaf-count-weighted equalize', () => {
  test('[chat, project-with-3-cols] → 1:3, so every leaf is 1/4', () => {
    approx(weightedWidths([1, 3]), [0.25, 0.75]);
  });
  test('uniform weights collapse to an even split', () => {
    approx(weightedWidths([1, 1, 1]), [1 / 3, 1 / 3, 1 / 3]);
  });
  test('result always sums to 1', () => {
    expect(weightedWidths([2, 3, 5]).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
  });
  test('degenerate weights (all ≤ 0 / non-finite) fall back to even split', () => {
    approx(weightedWidths([0, 0]), [0.5, 0.5]);
    approx(weightedWidths([NaN, Infinity]), [0.5, 0.5]);
  });
  test('empty → []', () => expect(weightedWidths([])).toEqual([]));
});

describe('keepColumnWidths — multi-column survivor renormalise', () => {
  test('keeps selected columns in proportion (drop the middle)', () => {
    // a row [0.2, 0.5, 0.3]; group at idx 1 removed → keep [0,2] in 2:3 ratio
    approx(keepColumnWidths([0.2, 0.5, 0.3], [0, 2]), [0.4, 0.6]);
  });
  test('keeping all is identity-after-normalise', () => {
    approx(keepColumnWidths([0.3, 0.7], [0, 1]), [0.3, 0.7]);
  });
});

describe('chooseSplitOrientation — split by available space', () => {
  test('landscape cell splits side-by-side', () => {
    expect(chooseSplitOrientation({ width: 1200, height: 800 })).toBe('side');
    expect(chooseSplitOrientation({ width: 1000, height: 600 })).toBe('side');
  });
  test('portrait / tall-narrow cell stacks', () => {
    expect(chooseSplitOrientation({ width: 500, height: 900 })).toBe('stack');
    expect(chooseSplitOrientation({ width: 700, height: 700 })).toBe('stack'); // square → stack
  });
  test('just past the 1.2 threshold flips to side', () => {
    expect(chooseSplitOrientation({ width: 721, height: 600 })).toBe('side'); // 1.202×
    expect(chooseSplitOrientation({ width: 719, height: 600 })).toBe('stack'); // 1.198×
  });
  test('null / degenerate rect → side (historical default)', () => {
    expect(chooseSplitOrientation(null)).toBe('side');
    expect(chooseSplitOrientation(undefined)).toBe('side');
    expect(chooseSplitOrientation({ width: 800, height: 0 })).toBe('side');
    expect(chooseSplitOrientation({ width: NaN, height: 600 })).toBe('side');
  });
});
