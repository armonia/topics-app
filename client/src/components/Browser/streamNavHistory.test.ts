/**
 * The streaming pane's arrows follow the server's history flags, and an
 * absent flag is "unknown", which keeps what the pane had.
 *
 * @covers BROWSER-STREAM-HISTORY-01
 */
import { describe, expect, test } from 'bun:test';
import { applyHistoryUpdate, arrowEnabled, historyFlagsOf } from './streamNavHistory';

describe('historyFlagsOf', () => {
  test('takes the booleans the message carries', () => {
    expect(historyFlagsOf({ canGoBack: false, canGoForward: true })).toEqual({ canGoBack: false, canGoForward: true });
  });

  test('an older server sends none, and none are taken', () => {
    expect(historyFlagsOf({})).toEqual({});
    expect(historyFlagsOf(null)).toEqual({});
    expect(historyFlagsOf({ canGoBack: 'yes', canGoForward: 1 })).toEqual({});
  });

  test('spreading it never erases a flag the pane already holds', () => {
    const held = { url: 'https://a.test/', canGoBack: true, canGoForward: false };
    expect({ ...held, ...historyFlagsOf({}) }).toEqual(held);
  });
});

describe('applyHistoryUpdate', () => {
  const base = { url: 'https://a.test/', loading: true, canGoBack: false, canGoForward: false };

  test('moves the url and the flags, and leaves loading alone', () => {
    const next = applyHistoryUpdate(base, { url: 'https://a.test/#b', canGoBack: true, canGoForward: false });
    expect(next).toEqual({ url: 'https://a.test/#b', loading: true, canGoBack: true, canGoForward: false });
  });

  test('the same state returns the same object (no render)', () => {
    expect(applyHistoryUpdate(base, { url: 'https://a.test/', canGoBack: false, canGoForward: false })).toBe(base);
  });

  test('an empty url (an error page on the server) moves only the arrows', () => {
    const next = applyHistoryUpdate(base, { url: '', canGoBack: true, canGoForward: false });
    expect(next).toEqual({ url: 'https://a.test/', loading: true, canGoBack: true, canGoForward: false });
  });

  test('an update without flags keeps the held ones', () => {
    const next = applyHistoryUpdate(base, { url: 'https://a.test/#c' });
    expect(next.canGoBack).toBe(false);
    expect(next.url).toBe('https://a.test/#c');
  });
});

describe('arrowEnabled', () => {
  test('the server answer wins', () => {
    expect(arrowEnabled(false)).toBe(false);
    expect(arrowEnabled(true)).toBe(true);
  });

  test('no answer keeps the arrow enabled, as before the flags existed', () => {
    expect(arrowEnabled(undefined)).toBe(true);
  });
});
