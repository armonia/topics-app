/**
 * WHEN THE PERSON LAST DID SOMETHING ON THIS DEVICE.
 *
 * A page shown on two devices is laid out for the one in use
 * (TOPIC-BROWSER-05), and "in use" is a fact about the device, not about one
 * pane: the tap that opens a browser tab lands on the tab strip before the
 * pane exists, and someone who picks up the iPad and types in a chat is on the
 * iPad. This clock is that fact: the last trusted pointer, key or wheel event
 * anywhere in this document, and a way to hear the next one.
 *
 * Installed at boot (main.tsx): the panes that read it load lazily, and the
 * gesture that opened the first one happened before their module existed.
 * Capture phase and passive, so it only takes the time and never gets in the
 * way of an event. Events inside an iframe do not reach it; the browser pane
 * reports input to its page on its own.
 */

/**
 * One gesture, as its listeners receive it. `target` is where it landed.
 * `claimed` lets the panes of one page take it once between them: two panes on
 * the same page would otherwise trade the page on every tap.
 */
export interface UserGesture {
  readonly at: number;
  readonly target: EventTarget | null;
  readonly claimed: Set<string>;
}

let lastAt = 0;
let installed = false;
const listeners = new Set<(gesture: UserGesture) => void>();

function note(at: number, target: EventTarget | null): void {
  lastAt = at;
  const gesture: UserGesture = { at, target, claimed: new Set() };
  for (const listener of listeners) listener(gesture);
}

function onEvent(event: Event): void {
  if (event.isTrusted) note(Date.now(), event.target);
}

/** Start the clock. Idempotent. */
export function installUserGestureClock(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(type, onEvent, { capture: true, passive: true });
  }
}

/** Epoch ms of the last gesture on this device, 0 before the first. */
export function lastUserGestureAt(): number {
  return lastAt;
}

/** Hear every gesture from now on. Returns the unsubscribe. */
export function onUserGesture(listener: (gesture: UserGesture) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests: a gesture at `at` on `target`, delivered the way a trusted event delivers it. */
export function __noteUserGestureForTests(at: number = Date.now(), target: EventTarget | null = null): void {
  note(at, target);
}

/** Tests: back to a device nobody has touched, with the clock not yet started. */
export function __resetUserGestureForTests(): void {
  lastAt = 0;
  installed = false;
}
