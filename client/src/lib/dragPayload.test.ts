/**
 * The drag shelf and when it empties.
 *
 * Why `drop` matters as much as `dragend`: a drop handler that unmounts the
 * dragged source swallows the `dragend` that would have cleared the shelf, and
 * a stale shelf makes the NEXT drag look same-window when it isn't (PaneTabBar
 * reads it for `isCrossGroupDrag` and for the dragged group's size).
 *
 * @covers LAYOUT-01
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

type Listener = (event: unknown) => void;
const registered: { type: string; fn: Listener }[] = [];

const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, fn: Listener) => { registered.push({ type, fn }); },
  removeEventListener: () => {},
};

// Imported AFTER the stub: the module registers its listener lazily on the
// first rememberDraggedPane, and a real `window` would swallow the recording.
const { rememberDraggedPane, draggedPaneId, forgetDraggedPane } = await import('./dragPayload');

afterAll(() => {
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
});

beforeEach(() => {
  forgetDraggedPane();
});

const listenersFor = (type: string) => registered.filter(r => r.type === type);

describe('dragPayload', () => {
  test('remembers the pane in flight and forgets it on demand', () => {
    rememberDraggedPane('chat:A');
    expect(draggedPaneId()).toBe('chat:A');
    forgetDraggedPane();
    expect(draggedPaneId()).toBeNull();
  });

  test('listens for BOTH dragend and drop', () => {
    rememberDraggedPane('chat:A');
    expect(listenersFor('dragend').length).toBe(1);
    expect(listenersFor('drop').length).toBe(1);
  });

  test('the drop listener clears the shelf', () => {
    rememberDraggedPane('chat:A');
    listenersFor('drop')[0].fn(new Object());
    expect(draggedPaneId()).toBeNull();
  });

  test('registers ONE listener per event for the life of the module', () => {
    rememberDraggedPane('chat:A');
    rememberDraggedPane('chat:B');
    rememberDraggedPane('chat:C');
    expect(registered.length).toBe(2);
    expect(draggedPaneId()).toBe('chat:C');
  });
});
