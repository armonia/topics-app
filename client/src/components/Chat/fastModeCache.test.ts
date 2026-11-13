/**
 * @covers CHAT-DEF-04
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cacheFastMode } from './fastModeCache';

const g = globalThis as unknown as { localStorage?: unknown };

afterEach(() => { delete g.localStorage; });

describe('cacheFastMode', () => {
  test('writes the bit under the topic key', () => {
    const m = new Map<string, string>();
    g.localStorage = { setItem: (k: string, v: string) => void m.set(k, v) };
    cacheFastMode('draft:a', true);
    expect(m.get('fastMode:draft:a')).toBe('true');
  });

  test('a failing setItem is reported with a warning, not swallowed', () => {
    g.localStorage = { setItem: () => { throw new Error('quota'); } };
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a); };
    try {
      expect(() => cacheFastMode('draft:a', true)).not.toThrow();
    } finally {
      console.warn = realWarn;
    }
    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain('fastMode could not be cached');
  });
});
