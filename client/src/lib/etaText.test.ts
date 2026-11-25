/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from 'bun:test';
import { etaText } from './etaText';
import it from './i18n-it';

const MIN = 60_000;
const tr = (key: string, vars?: Record<string, string | number>) =>
  Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), (it as Record<string, string>)[key] ?? key);

describe('etaText', () => {
  test('minutes under an hour, never zero', () => {
    expect(etaText(tr, 0)).toBe('1 min');
    expect(etaText(tr, 12 * MIN)).toBe('12 min');
    expect(etaText(tr, 59 * MIN)).toBe('59 min');
  });
  test('hours and minutes, rounded to what an estimate can claim', () => {
    expect(etaText(tr, 60 * MIN)).toBe('1 h');
    expect(etaText(tr, 83 * MIN)).toBe('1 h 25');
    expect(etaText(tr, 340 * MIN)).toBe('5 h 45');
    expect(etaText(tr, 23 * 60 * MIN + 55 * MIN)).toBe('1 g');
  });
  test('days and hours past a day', () => {
    expect(etaText(tr, 28 * 60 * MIN)).toBe('1 g 4 h');
    expect(etaText(tr, 48 * 60 * MIN)).toBe('2 g');
  });
});
