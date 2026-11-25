/**
 * The badge's figure: the count up to three figures, then thousands. «99+»
 * hid whether 104 or 900 things waited (22/11, the bell at 224).
 *
 * @covers NOTIF-ONE-02
 */
import { describe, expect, test } from 'bun:test';
import { formatBadgeCount } from './NotificationBadge';

describe('formatBadgeCount', () => {
  test('up to 999 the count itself', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(99)).toBe('99');
    expect(formatBadgeCount(104)).toBe('104');
    expect(formatBadgeCount(999)).toBe('999');
  });

  test('thousands with one decimal under ten, in the notation of the locale, whole above', () => {
    expect(formatBadgeCount(1000, { locale: 'it-IT' })).toBe('1K');
    expect(formatBadgeCount(1250, { locale: 'it-IT' })).toBe('1,2K');
    expect(formatBadgeCount(1250, { locale: 'en-US' })).toBe('1.2K');
    // Rounded down: «1,9K» is never shown for 1,899 nor «10K» for 9,999.
    expect(formatBadgeCount(1899, { locale: 'it-IT' })).toBe('1,8K');
    expect(formatBadgeCount(9999, { locale: 'it-IT' })).toBe('9,9K');
    expect(formatBadgeCount(12_345)).toBe('12K');
  });

  test('the 20px tab slot keeps «99+»: three figures are the most it holds', () => {
    expect(formatBadgeCount(99, { compact: true })).toBe('99');
    expect(formatBadgeCount(150, { compact: true })).toBe('99+');
  });
});
