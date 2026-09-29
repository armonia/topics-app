/**
 * The one glyph a browser tab shows, when several kinds are true at once. The
 * agent stays first (it is the take-control button); the heavy kinds slot after
 * the connection kinds and before the facts nobody can act on.
 *
 * @covers BROWSER-HEAVY-04
 * @covers TABSLOT-03
 */
import { describe, expect, test } from 'bun:test';
import { browserCornerMark, browserTabKind } from './browserTabKind';

const HEAVY = { paused: false, cpu: 17 };
const PAUSED = { paused: true, cpu: 17 };

describe('browserTabKind order', () => {
  test('agent > disconnected > heavy-paused > heavy > chromium > shared', () => {
    const all = { agentActive: true, connection: 'disconnected' as const, heavy: PAUSED, engine: 'chromium' as const, shared: true };
    expect(browserTabKind(all)).toBe('agent');
    expect(browserTabKind({ ...all, agentActive: false })).toBe('disconnected');
    expect(browserTabKind({ ...all, agentActive: false, connection: undefined })).toBe('heavy-paused');
    expect(browserTabKind({ ...all, agentActive: false, connection: undefined, heavy: HEAVY })).toBe('heavy');
    expect(browserTabKind({ ...all, agentActive: false, connection: undefined, heavy: undefined })).toBe('chromium');
    expect(browserTabKind({ shared: true })).toBe('shared');
  });

  test('the default native tab shows nothing', () => {
    expect(browserTabKind({ shared: false })).toBeUndefined();
  });
});

describe('browserCornerMark: one mark on the favicon corner', () => {
  test('a state of the pane beats the console errors', () => {
    for (const kind of ['agent', 'disconnected', 'connecting', 'degraded', 'heavy-paused', 'heavy'] as const) {
      expect(browserCornerMark(kind, 3)).toBe('kind');
    }
  });

  test('the console errors beat the facts', () => {
    expect(browserCornerMark('chromium', 3)).toBe('errors');
    expect(browserCornerMark('shared', 3)).toBe('errors');
    expect(browserCornerMark(undefined, 3)).toBe('errors');
  });

  test('a fact alone still shows, and nothing shows nothing', () => {
    expect(browserCornerMark('shared', 0)).toBe('kind');
    expect(browserCornerMark(undefined, 0)).toBeUndefined();
  });
});
