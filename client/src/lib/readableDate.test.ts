/**
 * @covers READABLE-01
 */
import { describe, expect, test } from 'bun:test';
import { readableDate } from './readableDate';

describe('readableDate', () => {
  const now = new Date(2026, 10, 21, 15, 0);
  test('same day reads as today plus the time', () => {
    expect(readableDate(new Date(2026, 10, 21, 11, 48).toISOString(), now, 'it')).toBe('oggi 11:48');
  });
  test('the day before reads as yesterday', () => {
    expect(readableDate(new Date(2026, 10, 20, 9, 5).toISOString(), now, 'it')).toBe('ieri 09:05');
  });
  test('an older date shows day and month', () => {
    expect(readableDate(new Date(2026, 9, 3, 9, 5).toISOString(), now, 'it')).toMatch(/^3 ott\.? 09:05$/);
  });
  test('garbage is returned untouched', () => {
    expect(readableDate('not a date', now, 'it')).toBe('not a date');
  });
});
