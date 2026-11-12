/**
 * `useStorageSync` used to put the parse AND the consumer under one `catch
 * {}`: a throwing `onUpdate` vanished as silently as a malformed value, card
 * `703e3b31-4d4a-4052-b26e-9fd3a7a5d0f4`. Now the parse failure is warned
 * about and stops there, and a consumer's own exception is no longer caught
 * by this hook at all.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useStorageSync } from './useStorageSync';

const g = globalThis as unknown as Record<string, unknown>;
const listeners = new Map<string, Set<(e: unknown) => void>>();
const saved: Record<string, unknown> = {};

beforeEach(() => {
  listeners.clear();
  saved.window = g.window;
  const w = (g.window as Record<string, unknown> | undefined) ?? {};
  w.addEventListener = (name: string, fn: (e: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
  };
  w.removeEventListener = (name: string, fn: (e: unknown) => void) => { listeners.get(name)?.delete(fn); };
  g.window = w;
});

afterEach(() => {
  if (saved.window === undefined) delete g.window; else g.window = saved.window;
});

function fireStorage(key: string, newValue: string | null): void {
  for (const fn of [...(listeners.get('storage') ?? [])]) fn({ key, newValue });
}

describe('useStorageSync', () => {
  test('a malformed value is warned about and onUpdate is not called', () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    let called = false;
    function Probe(): null {
      useStorageSync('k', () => { called = true; });
      return null;
    }
    const h = mount(React.createElement(Probe));
    try {
      expect(() => fireStorage('k', 'not json')).not.toThrow();
      expect(called).toBe(false);
      expect(warnCalls.some((args) => String(args[0]).includes('[storage-sync]'))).toBe(true);
    } finally {
      console.warn = realWarn;
      h.unmount();
    }
  });

  test('onUpdate runs with the parsed value, and its own exception is not swallowed here', () => {
    const seen: unknown[] = [];
    function Probe(): null {
      useStorageSync<{ n: number }>('k', (v) => { seen.push(v); });
      return null;
    }
    const h = mount(React.createElement(Probe));
    try {
      fireStorage('k', JSON.stringify({ n: 1 }));
      expect(seen).toEqual([{ n: 1 }]);
    } finally {
      h.unmount();
    }

    function Throwing(): null {
      useStorageSync('k2', () => { throw new Error('boom'); });
      return null;
    }
    const h2 = mount(React.createElement(Throwing));
    try {
      expect(() => fireStorage('k2', JSON.stringify({ n: 2 }))).toThrow('boom');
    } finally {
      h2.unmount();
    }
  });
});
