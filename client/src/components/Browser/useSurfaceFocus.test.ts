/**
 * THE TOPIC BROWSER WINDOW HAS A FOCUS OF ITS OWN.
 *
 * Without it the window's panes read their visibility as their focus, and a heavy
 * page beside the chat never paused while the person typed in the chat.
 *
 * @covers BROWSER-HEAVY-03
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { useSurfaceFocus, type SurfaceFocus } from './useSurfaceFocus';

const g = globalThis as unknown as Record<string, unknown>;
let saved: unknown;
let listeners: Map<string, Set<() => void>>;

beforeEach(() => {
  saved = g.document;
  listeners = new Map();
  g.document = {
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  };
});

afterEach(() => {
  if (saved === undefined) delete g.document; else g.document = saved;
});

const fire = (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };

function bench() {
  const seen: SurfaceFocus[] = [];
  const h = mount(createElement(function Probe(): null { seen.push(useSurfaceFocus()); return null; }));
  return { h, now: () => { h.rerender(); return seen[seen.length - 1]!; } };
}

describe('useSurfaceFocus', () => {
  test('a pointerdown or a focus outside takes it, a touch inside gives it back', () => {
    const b = bench();
    expect(b.now().focused).toBe(true);
    fire('pointerdown');
    expect(b.now().focused).toBe(false);
    b.now().captureProps.onPointerDownCapture();
    expect(b.now().focused).toBe(true);
    fire('focusin');
    expect(b.now().focused).toBe(false);
    b.now().claim();
    expect(b.now().focused).toBe(true);
    b.h.unmount();
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});
