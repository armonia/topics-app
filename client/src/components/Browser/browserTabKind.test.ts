/**
 * The one glyph a browser tab shows, when several kinds are true at once. The
 * agent stays first; the heavy kinds slot after the connection kinds and before
 * the facts nobody can act on. On the corner the console errors beat any kind
 * but a link that is not live.
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
  test('the console errors beat the agent, the heavy page and the facts', () => {
    for (const kind of ['agent', 'heavy-paused', 'heavy', 'chromium', 'shared', undefined] as const) {
      expect(browserCornerMark(kind, 3)).toBe('errors');
    }
  });

  test('a link that is not live beats the errors: without it the tally is frozen', () => {
    for (const kind of ['disconnected', 'connecting', 'degraded'] as const) {
      expect(browserCornerMark(kind, 3)).toBe('kind');
    }
  });

  test('without errors the kind shows, and nothing shows nothing', () => {
    expect(browserCornerMark('agent', 0)).toBe('kind');
    expect(browserCornerMark('shared', 0)).toBe('kind');
    expect(browserCornerMark(undefined, 0)).toBeUndefined();
  });
});
