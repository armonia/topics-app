/**
 * @covers CHAT-TOOL-05
 */
import { describe, expect, test } from 'bun:test';
import { clampBody, formatBytes, CLAMP_CHARS } from './clampBody';

describe('clampBody', () => {
  test('small bodies pass through untouched', () => {
    const r = clampBody('hello');
    expect(r.oversized).toBe(false);
    expect(r.shown).toBe('hello');
    expect(r.length).toBe(5);
  });

  test('at the budget is not oversized', () => {
    const text = 'x'.repeat(CLAMP_CHARS);
    const r = clampBody(text);
    expect(r.oversized).toBe(false);
    expect(r.shown.length).toBe(CLAMP_CHARS);
  });

  test('over the budget clamps and flags', () => {
    const text = 'y'.repeat(CLAMP_CHARS + 500);
    const r = clampBody(text);
    expect(r.oversized).toBe(true);
    expect(r.shown.length).toBe(CLAMP_CHARS);
    expect(r.length).toBe(CLAMP_CHARS + 500);
  });

  test('respects a custom max', () => {
    const r = clampBody('abcdef', 3);
    expect(r.oversized).toBe(true);
    expect(r.shown).toBe('abc');
  });
});

describe('formatBytes', () => {
  test('B / KB / MB thresholds', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
