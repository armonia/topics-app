/**
 * RIGHT-CLICK, THE TWO HALVES EVERY MENU WAS MISSING: where the focus goes back
 * when the menu closes, and how the keyboard opens it.
 *
 * Every cursor menu in the app (`ContextMenuPortal`, the topic menu, the tab
 * menu, the space menu) declared `restoreFocus: false` or restored to
 * `refs[0]`, i.e. to the menu itself: the comment said "a cursor menu has no
 * persistent trigger". It has one, it is the element under the pointer, and
 * nobody wrote it down. WebKit does not focus a row or a button on a right
 * click, so after Esc the focus fell on `<body>` and a keyboard user had to
 * start again from the top of the window.
 *
 * And no menu opened from the keyboard: macOS has no context-menu key, and
 * WebKit does not turn Shift+F10 into a `contextmenu` event.
 *
 * Both are solved here, ONCE, without touching any call site:
 *
 *  - the ORIGIN: a `contextmenu` leaves behind the focusable element it hit,
 *    noted in the CAPTURE phase, before any handler runs: React commits a
 *    discrete update, effects included, inside its own root listener, so the
 *    popover asks for its origin before the event has finished bubbling.
 *    `useDismissable` takes it when its popover opens and returns the focus
 *    there on close. If the event reaches `window` with nobody having
 *    answered it (the system menu's case), or a new gesture starts
 *    (pointerdown, keydown), the origin is forgotten, so a popover opened
 *    later by something else cannot inherit it.
 *  - the KEYS: Shift+F10 and the ContextMenu key synthesize the same bubbling
 *    `contextmenu` on the focused element that a long press already
 *    synthesizes (`openContextMenuAt`), placed under the element. If nobody
 *    answers, nothing happens and the key goes on its way; a text field is
 *    left alone, because there the menu is the system's.
 */

/** What counts as "the element the focus goes back to". */
const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]';

/** The minimum of an element this module needs, so it is testable without a DOM. */
export interface OriginElement {
  closest(selector: string): OriginElement | null;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  dispatchEvent(e: Event): boolean;
  getAttribute(name: string): string | null;
  isContentEditable?: boolean;
  tagName: string;
}

let origin: OriginElement | null = null;

/**
 * The element the last answered right-click (or long press, or key) came
 * from, consumed: the first popover that asks gets it, the second gets null.
 */
export function takeContextMenuOrigin(): HTMLElement | null {
  const o = origin;
  origin = null;
  return o as HTMLElement | null;
}

/** Shift+F10 or the ContextMenu key, the two keys every platform reads as "open the menu". */
export function isContextMenuKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/** A field where the menu belongs to the system (cut, copy, paste, spelling). */
export function isTextField(el: OriginElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/** Where a keyboard-opened menu appears: under the element's leading edge, like a dropdown. */
export function keyboardMenuPoint(rect: { left: number; bottom: number }): { x: number; y: number } {
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}

/** The focusable element a `contextmenu` hit: the target itself or its nearest focusable ancestor. */
export function originOf(target: unknown): OriginElement | null {
  const el = target as OriginElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(FOCUSABLE);
}

/** The minimum of `window` this module needs. */
export interface ContextMenuHost {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  /** The focused element (`document.activeElement`). */
  activeElement(): OriginElement | null;
  /** Looks up an element by id (`aria-activedescendant`). */
  byId(id: string): OriginElement | null;
  /** Builds the synthetic event (a `MouseEvent` in the browser). */
  makeEvent(x: number, y: number): Event;
}

/**
 * Where a key-opened menu is aimed: the focused element, or the row a
 * composite widget (a tree, a listbox) points at with `aria-activedescendant`
 * while it keeps the focus on itself.
 */
function keyboardTarget(host: ContextMenuHost): OriginElement | null {
  const active = host.activeElement();
  if (!active || active.tagName.toLowerCase() === 'body' || isTextField(active)) return null;
  const pointed = active.getAttribute('aria-activedescendant');
  return (pointed && host.byId(pointed)) || active;
}

export function browserContextMenuHost(win: Window): ContextMenuHost {
  return {
    addEventListener: (type, fn, capture) => win.addEventListener(type, fn, capture),
    removeEventListener: (type, fn, capture) => win.removeEventListener(type, fn, capture),
    activeElement: () => win.document.activeElement as unknown as OriginElement | null,
    byId: (id) => win.document.getElementById(id) as unknown as OriginElement | null,
    makeEvent: (x, y) => new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  };
}

/** Installs both halves on `window`. Returns the uninstall. Called once, from `main.tsx`. */
export function installContextMenuSupport(host: ContextMenuHost): () => void {
  // What held the focus when the press began. A right-click on something that
  // cannot hold the focus (a tab of the bar, a file tab) takes it away from
  // the composer anyway: WebKit blurs on the right button's mousedown. That is
  // where the focus goes back when the menu closes.
  let heldFocus: OriginElement | null = null;
  const forget = () => {
    origin = null;
    const active = host.activeElement();
    heldFocus = active && active.tagName.toLowerCase() !== 'body' ? active : null;
  };
  const onKey = (e: Event) => {
    origin = null;
    heldFocus = null;
    const k = e as KeyboardEvent;
    if (k.defaultPrevented || !isContextMenuKey(k)) return;
    const target = keyboardTarget(host);
    if (!target) return;
    const { x, y } = keyboardMenuPoint(target.getBoundingClientRect());
    // `dispatchEvent` returns false when a listener called preventDefault, that
    // is when a menu opened: only then is the key ours.
    const answered = !target.dispatchEvent(host.makeEvent(x, y));
    if (answered) k.preventDefault();
  };
  const noteOrigin = (e: Event) => { origin = originOf(e.target) ?? heldFocus; };
  // Bubble phase on window, after React's root listener: nobody answered, the
  // system menu opens, and there is no menu of ours to give the focus back from.
  const dropUnanswered = (e: Event) => { if (!e.defaultPrevented) origin = null; };
  host.addEventListener('pointerdown', forget, true);
  host.addEventListener('keydown', onKey, true);
  host.addEventListener('contextmenu', noteOrigin, true);
  host.addEventListener('contextmenu', dropUnanswered, false);
  return () => {
    host.removeEventListener('pointerdown', forget, true);
    host.removeEventListener('keydown', onKey, true);
    host.removeEventListener('contextmenu', noteOrigin, true);
    host.removeEventListener('contextmenu', dropUnanswered, false);
    origin = null;
  };
}

/** What, inside a menu panel, is one of its commands. */
const COMMAND = 'button, a[href], summary, [role^="menuitem"], [role="option"]';

/** The minimum of a `Selection` this module needs. */
export interface SelectionLike {
  isCollapsed: boolean;
  containsNode(node: never, allowPartialContainment: boolean): boolean;
}

function currentSelection(): SelectionLike | null {
  return typeof document === 'undefined' ? null : document.getSelection();
}

/**
 * The `onContextMenu` of an open menu panel: a right-click ON a menu of ours is
 * not a request for the system menu on top of it, nor for a second menu from
 * the row behind (a portal bubbles through the React tree to whoever opened
 * it). Two places inside a panel keep the system menu: a text field (cut,
 * copy, paste), and SELECTED TEXT that is not a command's label. Some panels
 * are reading surfaces (the task's diff, the browser console): turning the
 * system menu down there took Copy away with it, and the panel has no Copy of
 * its own. A command's label stays the panel's even when selected, because
 * WebKit on macOS selects the word under a right-click before the event fires.
 */
export function keepSystemMenuOffPanel(
  e: { target: EventTarget | null; preventDefault(): void; stopPropagation(): void },
  selection: SelectionLike | null = currentSelection(),
): void {
  e.stopPropagation();
  const target = e.target as unknown as OriginElement | null;
  if (isTextField(target)) return;
  const onSelectedText = !!target && typeof target.closest === 'function' && !!selection && !selection.isCollapsed
    && target.closest(COMMAND) === null && selection.containsNode(target as never, true);
  if (!onSelectedText) e.preventDefault();
}
