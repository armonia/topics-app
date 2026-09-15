/**
 * The one glyph a browser tab shows, when several kinds are true at once. The
 * agent stays first (it is the take-control button); the heavy kinds slot after
 * the connection kinds and before the facts nobody can act on.
 *
 * @covers BROWSER-HEAVY-04
 */
import { describe, expect, test } from 'bun:test';
import { browserTabKind } from './browserTabKind';

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
