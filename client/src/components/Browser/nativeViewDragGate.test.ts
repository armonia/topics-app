/**
 * @covers LAYOUT-02
 *
 * WHAT IS BEING DEFENDED: a browser pane that comes back.
 *
 * The native view is parked at zero bounds for the duration of a drag, so the
 * counter that says "a drag is running" holds the page hostage: stuck above
 * zero, the pane is BLANK. `dragend` and `drop` are not guaranteed (the shell's
 * WKWebView loses them when the release lands on a native view, or off-window),
 * so the tests below emit a start WITHOUT its end and demand the release
 * anyway, through each of the three belt doors.
 *
 * No DOM here: the gate takes its event target as an option (jsdom/happy-dom
 * are deliberately not dependencies of this project, see `Board/ThreadRuns.test.tsx`).
 */
import { describe, expect, it } from 'bun:test';
import { installNativeViewDragGate, type DragGateTarget } from './nativeViewDragGate';

/** A window stand-in that keeps the handlers and can fire them by name. */
function fakeTarget() {
  const handlers = new Map<string, Set<(e: Event) => void>>();
  const target: DragGateTarget = {
    addEventListener(type, fn) {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
  };
  return {
    target,
    fire(type: string, event: Partial<PointerEvent> = {}) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event as Event);
    },
    count(type: string) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

function armed() {
  const t = fakeTarget();
  const log: string[] = [];
  const dispose = installNativeViewDragGate({
    target: t.target,
    onOcclude: () => log.push('occlude'),
    onRelease: () => log.push('release'),
  });
  return { ...t, log, dispose };
}

describe('installNativeViewDragGate', () => {
  it('parks the view on dragstart and gives it back on drop', () => {
    const g = armed();
    g.fire('dragstart');
    expect(g.log).toEqual(['occlude']);
    g.fire('drop');
    g.fire('dragend');
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('a lost dragend does NOT leave the pane blank: a button-less pointermove releases it', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('pointermove', { buttons: 0 });
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('a lost dragend does NOT leave the pane blank: a pointerup releases it', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('pointerup');
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('a lost dragend does NOT leave the pane blank: losing the window releases it', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('blur');
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('a pointermove with the button still down is the gesture, not its end', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('pointermove', { buttons: 1 });
    expect(g.log).toEqual(['occlude']);
  });

  it('a belt release closes the WHOLE count: after a lost end the number is unknown, zero is the only sure one', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('topics:pane-resize-start');
    g.fire('pointerup');
    expect(g.log).toEqual(['occlude', 'release']);
    // The stragglers of the gesture that was already declared over must not
    // drive the count negative, nor emit a second release.
    g.fire('dragend');
    g.fire('drop');
    expect(g.log).toEqual(['occlude', 'release']);
    // And the next gesture still parks the view: the gate is reusable.
    g.fire('dragstart');
    expect(g.log).toEqual(['occlude', 'release', 'occlude']);
  });

  it('nested gestures park once and release once', () => {
    const g = armed();
    g.fire('dragstart');
    g.fire('topics:pane-resize-start');
    g.fire('dragend');
    expect(g.log).toEqual(['occlude']);
    g.fire('topics:pane-resize-end');
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('an end with nothing running is ignored (no release, no negative count)', () => {
    const g = armed();
    g.fire('drop');
    g.fire('pointerup');
    expect(g.log).toEqual([]);
    g.fire('dragstart');
    expect(g.log).toEqual(['occlude']);
    g.fire('dragend');
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('the disposer detaches every door, belt included', () => {
    const g = armed();
    g.dispose();
    for (const type of ['dragstart', 'dragend', 'drop', 'topics:pane-resize-start', 'topics:pane-resize-end', 'pointerup', 'pointermove', 'blur']) {
      expect(g.count(type)).toBe(0);
    }
  });
});

/**
 * A REFLOW IS NOT A GESTURE. `notifyPaneReflow` (after a split, entering or
 * leaving zoom) hides the views for a fixed 400 ms with no button held: the
 * first `pointermove` after the click or the drop hit the belt, which released
 * the view INSIDE the transition, on top of the new tab strip the reflow
 * exists to keep clear. Only its own end may release it.
 */
describe('a pane reflow under the gate', () => {
  it('a pointer moving with no button does not end a reflow; its own end does', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    const log: string[] = [];
    const dispose = installNativeViewDragGate({
      target: win as unknown as DragGateTarget,
      onOcclude: () => log.push('occlude'),
      onRelease: () => log.push('release'),
    });
    try {
      const { notifyPaneReflow } = await import('../Layout/paneReflow');
      notifyPaneReflow();
      expect(log).toEqual(['occlude']);
      win.dispatchEvent(Object.assign(new Event('pointermove'), { buttons: 0 }));
      win.dispatchEvent(new Event('pointerup'));
      expect(log).toEqual(['occlude']);
      await new Promise((r) => setTimeout(r, 450));
      expect(log).toEqual(['occlude', 'release']);
    } finally {
      dispose();
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });

  it('a gesture inside a reflow: the belt ends the gesture, the view waits for the reflow', () => {
    const g = armed();
    g.fire('topics:pane-resize-start', { detail: { reflow: true } } as never);
    g.fire('dragstart');
    g.fire('pointerup');
    expect(g.log).toEqual(['occlude']);
    g.fire('topics:pane-resize-end', { detail: { reflow: true } } as never);
    expect(g.log).toEqual(['occlude', 'release']);
  });

  it('a reflow inside a gesture: the reflow ending does not release a gesture still held', () => {
    const g = armed();
    g.fire('topics:pane-resize-start');
    g.fire('topics:pane-resize-start', { detail: { reflow: true } } as never);
    g.fire('topics:pane-resize-end', { detail: { reflow: true } } as never);
    expect(g.log).toEqual(['occlude']);
    g.fire('topics:pane-resize-end');
    expect(g.log).toEqual(['occlude', 'release']);
  });
});
