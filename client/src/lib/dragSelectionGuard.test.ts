/**
 * @covers TOPIC-BROWSER-01
 *
 * WHAT IS BEING DEFENDED: a page that becomes selectable again.
 *
 * The guard makes the whole document unselectable, so a guard that outlives
 * its gesture is a worse bug than the one it fixes: the transcript would stop
 * being copyable. The tests below end the gesture through every door and demand
 * the class is gone, and check that a stale release cannot end a newer drag.
 *
 * No DOM here: the guard takes its seams as an option (jsdom/happy-dom are
 * deliberately not dependencies of this project, see `Board/ThreadRuns.test.tsx`).
 */
import { describe, expect, it } from 'bun:test';
import { DRAG_NO_SELECT_CLASS, suppressTextSelection, type DragSelectionEnv } from './dragSelectionGuard';

function fakeEnv() {
  const handlers = new Map<string, Set<(e: Event) => void>>();
  const classes = new Set<string>();
  let cleared = 0;
  const env: DragSelectionEnv = {
    root: { classList: { add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); } } },
    target: {
      addEventListener(type, fn) {
        const set = handlers.get(type) ?? new Set();
        set.add(fn);
        handlers.set(type, set);
      },
      removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    },
    clearSelection: () => { cleared += 1; },
  };
  return {
    env,
    fire(type: string, event: Record<string, unknown> = {}) {
      let prevented = false;
      const e = { ...event, preventDefault: () => { prevented = true; } } as unknown as Event;
      for (const fn of [...(handlers.get(type) ?? [])]) fn(e);
      return prevented;
    },
    locked: () => classes.has(DRAG_NO_SELECT_CLASS),
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    cleared: () => cleared,
  };
}

describe('suppressTextSelection', () => {
  it('locks the page, clears the selection and cancels selectstart until released', () => {
    const f = fakeEnv();
    const release = suppressTextSelection(f.env);
    expect(f.locked()).toBe(true);
    expect(f.cleared()).toBe(1);
    expect(f.fire('selectstart')).toBe(true);
    release();
    expect(f.locked()).toBe(false);
    expect(f.listeners()).toBe(0);
    expect(f.fire('selectstart')).toBe(false);
  });

  for (const [door, event] of [
    ['pointerup', {}],
    ['mouseup', {}],
    ['pointercancel', {}],
    ['pointermove', { buttons: 0 }],
  ] as const) {
    it(`lets go by itself on ${door}`, () => {
      const f = fakeEnv();
      const release = suppressTextSelection(f.env);
      f.fire(door, event);
      expect(f.locked()).toBe(false);
      expect(f.listeners()).toBe(0);
      release(); // the owner's own release afterwards is harmless
      expect(f.locked()).toBe(false);
    });
  }

  it('holds through a move with the button down, Escape and a lost focus', () => {
    // The floating window's bar keeps dragging through Escape and a window
    // blur (it ends on the button only), so the guard must too: letting go
    // there turned the transcript blue under a window still in flight.
    const f = fakeEnv();
    const release = suppressTextSelection(f.env);
    f.fire('pointermove', { buttons: 1 });
    f.fire('keydown', { key: 'Escape' });
    f.fire('blur');
    f.fire('pointermove', { buttons: 1 });
    expect(f.locked()).toBe(true);
    expect(f.fire('selectstart')).toBe(true);
    release();
    expect(f.locked()).toBe(false);
  });

  it('a lost focus with the button released elsewhere ends on the next buttonless move', () => {
    const f = fakeEnv();
    suppressTextSelection(f.env);
    f.fire('blur');
    f.fire('pointermove', { buttons: 0 });
    expect(f.locked()).toBe(false);
    expect(f.listeners()).toBe(0);
  });

  it('a stale release does not end a newer drag', () => {
    const f = fakeEnv();
    const first = suppressTextSelection(f.env);
    f.fire('pointerup');
    const second = suppressTextSelection(f.env);
    first();
    expect(f.locked()).toBe(true);
    second();
    expect(f.locked()).toBe(false);
  });

  it('two overlapping holds keep the lock until the last one goes', () => {
    const f = fakeEnv();
    const a = suppressTextSelection(f.env);
    const b = suppressTextSelection(f.env);
    a();
    a();
    expect(f.locked()).toBe(true);
    b();
    expect(f.locked()).toBe(false);
  });
});
