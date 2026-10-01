/**
 * The origin of a right-click and the keys that open a menu, driven through
 * fake elements: no DOM in this repo's unit tests (see test/reactHarness.ts).
 *
 * @covers GESTURE-05
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  installContextMenuSupport,
  isContextMenuKey,
  isTextField,
  keepSystemMenuOffPanel,
  keyboardMenuPoint,
  takeContextMenuOrigin,
  type ContextMenuHost,
  type OriginElement,
} from './contextMenuOrigin';

interface FakeEl extends OriginElement {
  dispatched: Array<{ x: number; y: number }>;
}

/** An element that answers its own `contextmenu` when `answers` is true. */
function el(tagName: string, opts: { answers?: boolean; focusable?: boolean; parent?: FakeEl; attrs?: Record<string, string> } = {}): FakeEl {
  const self: FakeEl = {
    tagName,
    dispatched: [],
    closest: () => (opts.focusable === false ? opts.parent ?? null : self),
    getBoundingClientRect: () => ({ left: 40.4, top: 100, right: 240, bottom: 132.6, width: 200, height: 32 }),
    getAttribute: (name) => opts.attrs?.[name] ?? null,
    dispatchEvent: (e) => {
      const ev = e as unknown as FakeEvent;
      self.dispatched.push({ x: ev.x, y: ev.y });
      if (opts.answers) ev.defaultPrevented = true;
      // The synthetic event bubbles to window, where the origin is read.
      host.fire('contextmenu', { ...ev, target: self });
      return !ev.defaultPrevented;
    },
  };
  return self;
}

interface FakeEvent {
  x: number;
  y: number;
  target?: unknown;
  defaultPrevented: boolean;
  key?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  preventDefault?: () => void;
}

/** Listeners per type and phase: capture runs before the target, bubble after. */
const listeners = new Map<string, Array<{ fn: (e: Event) => void; capture: boolean }>>();
/** What runs AT the target, between the two phases: React's root listener, here. */
let atTarget: ((e: FakeEvent) => void) | null = null;
let focused: OriginElement | null = null;
const ids = new Map<string, OriginElement>();
const host: ContextMenuHost & { fire: (type: string, e: Partial<FakeEvent>) => FakeEvent } = {
  addEventListener: (type, fn, capture) => listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture: !!capture }]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)),
  activeElement: () => focused,
  byId: (id) => ids.get(id) ?? null,
  makeEvent: (x, y) => ({ x, y, defaultPrevented: false }) as unknown as Event,
  fire: (type, e) => {
    const ev = { x: 0, y: 0, defaultPrevented: false, ...e } as FakeEvent;
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    const all = listeners.get(type) ?? [];
    for (const l of all) if (l.capture) l.fn(ev as unknown as Event);
    atTarget?.(ev);
    for (const l of all) if (!l.capture) l.fn(ev as unknown as Event);
    return ev;
  },
};

let uninstall: (() => void) | null = null;
function install() { uninstall = installContextMenuSupport(host); }
afterEach(() => { uninstall?.(); uninstall = null; focused = null; ids.clear(); atTarget = null; });

const key = (k: string, mods: Partial<FakeEvent> = {}) => host.fire('keydown', { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe('the keys that open a menu', () => {
  test('Shift+F10 and the ContextMenu key, nothing else', () => {
    const k = (key: string, m: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
      isContextMenuKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...m });
    expect(k('ContextMenu')).toBe(true);
    expect(k('F10', { shiftKey: true })).toBe(true);
    expect(k('F10')).toBe(false);
    expect(k('F10', { shiftKey: true, metaKey: true })).toBe(false);
    expect(k('Enter', { shiftKey: true })).toBe(false);
  });

  test('a text field is the system menu, not ours', () => {
    expect(isTextField(el('INPUT'))).toBe(true);
    expect(isTextField(el('TEXTAREA'))).toBe(true);
    expect(isTextField({ ...el('DIV'), isContentEditable: true })).toBe(true);
    expect(isTextField(el('BUTTON'))).toBe(false);
  });

  test('the menu lands under the element leading edge, on whole pixels', () => {
    expect(keyboardMenuPoint({ left: 40.4, bottom: 132.6 })).toEqual({ x: 40, y: 133 });
  });
});

describe('installContextMenuSupport', () => {
  test('Shift+F10 on a focused row opens its menu, swallows the key, and leaves the row as origin', () => {
    install();
    const row = el('DIV', { answers: true });
    focused = row;
    const ev = key('F10', { shiftKey: true });
    expect(row.dispatched).toEqual([{ x: 40, y: 133 }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(takeContextMenuOrigin()).toBe(row as unknown as HTMLElement);
    // Consumed: a second popover does not inherit it.
    expect(takeContextMenuOrigin()).toBeNull();
  });

  test('an element nobody answers for: the key goes on, no origin', () => {
    install();
    const plain = el('DIV', { answers: false });
    focused = plain;
    const ev = key('ContextMenu');
    expect(plain.dispatched.length).toBe(1);
    expect(ev.defaultPrevented).toBe(false);
    expect(takeContextMenuOrigin()).toBeNull();
  });

  test('a focused text field is left to the system menu', () => {
    install();
    const field = el('TEXTAREA', { answers: true });
    focused = field;
    key('F10', { shiftKey: true });
    expect(field.dispatched).toEqual([]);
  });

  test('a tree that keeps focus on itself aims the menu at its active row', () => {
    install();
    const row = el('DIV', { answers: true });
    ids.set('file-row-7', row);
    focused = el('DIV', { attrs: { 'aria-activedescendant': 'file-row-7' } });
    key('ContextMenu');
    expect(row.dispatched.length).toBe(1);
  });

  test('the origin is there for a menu that opens DURING the dispatch (React commits inside its root listener)', () => {
    install();
    const row = el('DIV', { focusable: true });
    let seenByTheMenu = null as HTMLElement | null;
    // "React" answers at the target and opens the menu, which asks right away.
    atTarget = (e) => { e.defaultPrevented = true; seenByTheMenu = takeContextMenuOrigin(); };
    host.fire('contextmenu', { target: row });
    expect(seenByTheMenu).toBe(row as unknown as HTMLElement);
  });

  test('a right-click answered by a menu leaves its focusable ancestor; a new gesture forgets it', () => {
    install();
    const row = el('DIV', { focusable: true });
    const icon = el('svg', { focusable: false, parent: row });
    host.fire('contextmenu', { target: icon, defaultPrevented: true });
    host.fire('pointerdown', {});
    expect(takeContextMenuOrigin()).toBeNull();
    host.fire('contextmenu', { target: icon, defaultPrevented: true });
    expect(takeContextMenuOrigin()).toBe(row as unknown as HTMLElement);
  });

  test('a right-click on something that cannot hold the focus gives it back to what held it before the press', () => {
    install();
    const composer = el('TEXTAREA');
    const tabLabel = el('SPAN', { focusable: false });
    focused = composer;
    host.fire('pointerdown', {});
    // WebKit blurs on the right button's mousedown.
    focused = null;
    host.fire('contextmenu', { target: tabLabel, defaultPrevented: true });
    expect(takeContextMenuOrigin()).toBe(composer as unknown as HTMLElement);
  });

  test('a right-click that fell to the native menu leaves nothing behind', () => {
    install();
    host.fire('contextmenu', { target: el('DIV'), defaultPrevented: false });
    expect(takeContextMenuOrigin()).toBeNull();
  });
});

describe('keepSystemMenuOffPanel', () => {
  /** An element whose `closest` honours the selector, as far as the commands go. */
  function node(tagName: string, opts: { command?: boolean } = {}): OriginElement {
    return {
      tagName,
      closest: (sel) => (opts.command && sel.includes('button') ? node(tagName) : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      getAttribute: () => null,
      dispatchEvent: () => true,
    };
  }
  /** A selection that holds exactly `inside`. */
  const selecting = (...inside: OriginElement[]) => ({ isCollapsed: inside.length === 0, containsNode: (n: unknown) => inside.includes(n as OriginElement) });
  function rightClick(target: OriginElement, selection: ReturnType<typeof selecting> | null) {
    const ev = { target: target as unknown as EventTarget, prevented: false, stopped: false, preventDefault() { ev.prevented = true; }, stopPropagation() { ev.stopped = true; } };
    keepSystemMenuOffPanel(ev, selection);
    return ev;
  }

  test('a right-click on a command of the panel turns the system menu down and stops at the panel', () => {
    const ev = rightClick(node('BUTTON', { command: true }), selecting());
    expect(ev.prevented).toBe(true);
    expect(ev.stopped).toBe(true);
  });

  test('a text field in the panel keeps the system menu', () => {
    expect(rightClick(node('INPUT'), selecting()).prevented).toBe(false);
  });

  test('selected text in the panel (a diff line, a console row) keeps the system menu with Copy', () => {
    const line = node('SPAN');
    const ev = rightClick(line, selecting(line));
    expect(ev.prevented).toBe(false);
    // Still ours to stop: the row behind the portal must not open a second menu.
    expect(ev.stopped).toBe(true);
  });

  test('text that is not selected, or a selection somewhere else, is still the panel', () => {
    const line = node('SPAN');
    expect(rightClick(line, selecting()).prevented).toBe(true);
    expect(rightClick(line, selecting(node('SPAN'))).prevented).toBe(true);
    expect(rightClick(line, null).prevented).toBe(true);
  });

  test('a selected label of a command is still the command: WebKit selects the word under a right-click', () => {
    const label = node('SPAN', { command: true });
    expect(rightClick(label, selecting(label)).prevented).toBe(true);
  });
});
