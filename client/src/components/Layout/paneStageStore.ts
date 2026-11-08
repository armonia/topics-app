/**
 * The store behind `PaneStage` (SPLITPERF-01): which pane body is mounted, and
 * which slot of the layout its DOM currently sits in.
 *
 * WHY A STORE AND NOT A PARENT. React cannot move a component from one parent
 * to another: a pane dropped into another group, a group that ends up under a
 * new row, a cell split down — each of those changed the React parent of the
 * pane body, and React unmounted it and mounted a new one. A remounted terminal
 * re-attaches, a remounted chat re-reads its history and loses its place, a
 * remounted browser pane reloads. That is the flash.
 *
 * So the body is mounted ONCE, at a place in the tree that does not move (the
 * stage, one per tiling surface), through a portal into a container element the
 * store owns. The layout renders only an empty SLOT where the body goes, and
 * the store moves the container into whichever slot currently claims the pane.
 * Moving a DOM node is a move; rebuilding a component tree is a remount.
 *
 * THE HAND-OVER. When a pane changes place, its old slot unmounts and its new
 * slot mounts in the same commit, and React runs every unmount cleanup before
 * any mount. `release` therefore does not drop the pane: it PARKS the container
 * (still connected, in a hidden element of the stage), remembers the scroll
 * offsets and the focus inside it, and waits for the end of the commit. A `put`
 * from the new slot takes it out of the parking and restores what a detached
 * node forgets. Only a release that nobody claims by then is a real close.
 */
import type { DragEvent, MouseEvent, ReactNode } from 'react';

/** The React event props a layout element between the stage and a slot may carry. */
export type BridgeEventName =
  | 'onMouseDownCapture'
  | 'onDragOverCapture'
  | 'onDropCapture'
  | 'onDragOver'
  | 'onDragLeave'
  | 'onDrop';

export const BRIDGE_EVENTS: readonly BridgeEventName[] = [
  'onMouseDownCapture',
  'onDragOverCapture',
  'onDropCapture',
  'onDragOver',
  'onDragLeave',
  'onDrop',
];

/**
 * The handlers of ONE layout element that sits between the stage and a slot,
 * and how to find that element again from the slot (`closest(selector)`).
 *
 * A body rendered through a portal receives React events along the path of
 * the REACT tree, which goes from the body to the stage and skips every element
 * in between: the group's content area that turns a drag over the body into an
 * edge split, the cell that takes a row drop, the mousedown that focuses the
 * group. Those handlers are handed to the stage with the slot, and replayed on
 * the body's events in the same order the DOM would have delivered them.
 */
export interface BridgeHandlers {
  onMouseDownCapture?: (e: MouseEvent) => void;
  onDragOverCapture?: (e: DragEvent) => void;
  onDropCapture?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}

export interface BridgeLevel {
  readonly selector: string;
  readonly handlers: BridgeHandlers;
}

export interface StageEntry {
  readonly key: string;
  readonly element: ReactNode;
  /** Levels from the slot outwards: the innermost element first. */
  readonly levels: readonly BridgeLevel[];
  /** The element the portal renders into. Owned by the store, never by React. */
  readonly container: HTMLElement;
  /** The slot the container sits in now. */
  readonly slot: HTMLElement;
}

export interface PaneStageStore {
  put(key: string, element: ReactNode, slot: HTMLElement, levels: readonly BridgeLevel[]): void;
  release(key: string, slot: HTMLElement): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly StageEntry[];
  setParking(el: HTMLElement | null): void;
}

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/**
 * Move `node` to the end of `parent`. `moveBefore` where the engine has it: it is
 * the state-preserving move (a frame inside does not reload, focus stays).
 * `appendChild` otherwise, and the caller restores what that forgets.
 */
function moveNode(parent: HTMLElement, node: HTMLElement): void {
  if (node.parentNode === parent) return;
  const p = parent as MovableParent;
  if (typeof p.moveBefore === 'function' && node.isConnected && parent.isConnected) {
    try {
      p.moveBefore(node, null);
      return;
    } catch {
      // Not movable here (different document, disconnected): plain insert.
    }
  }
  parent.appendChild(node);
}

/**
 * What a node loses when it leaves the document for a moment: the scroll
 * offsets of everything inside it that is scrolled, and the focus. Captured
 * while the node is still in place, restored once it is in its new slot.
 */
function captureDetachables(root: HTMLElement): () => void {
  const scrolled: Array<[Element, number, number]> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrolled.push([el, el.scrollTop, el.scrollLeft]);
  }
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
  return () => {
    for (const [el, top, left] of scrolled) {
      if (el.scrollTop !== top) el.scrollTop = top;
      if (el.scrollLeft !== left) el.scrollLeft = left;
    }
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };
}

export function createPaneStageStore(): PaneStageStore {
  const entries = new Map<string, StageEntry>();
  const restores = new Map<string, () => void>();
  const pendingDrop = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: readonly StageEntry[] = [];
  let parking: HTMLElement | null = null;
  let flushQueued = false;

  const changed = (): void => {
    snapshot = [...entries.values()];
    for (const l of listeners) l();
  };

  const flush = (): void => {
    flushQueued = false;
    if (pendingDrop.size === 0) return;
    for (const key of pendingDrop) {
      entries.delete(key);
      restores.delete(key);
    }
    pendingDrop.clear();
    changed();
  };

  return {
    put(key, element, slot, levels) {
      const prev = entries.get(key);
      if (!prev) {
        const container = document.createElement('div');
        container.style.display = 'contents';
        container.setAttribute('data-pane-stage-body', key);
        moveNode(slot, container);
        entries.set(key, { key, element, levels, container, slot });
        changed();
        return;
      }
      pendingDrop.delete(key);
      if (prev.container.parentNode !== slot) {
        moveNode(slot, prev.container);
        restores.get(key)?.();
      }
      restores.delete(key);
      if (prev.element === element && prev.slot === slot && prev.levels === levels) return;
      entries.set(key, { ...prev, element, slot, levels });
      changed();
    },

    release(key, slot) {
      const entry = entries.get(key);
      if (!entry || entry.slot !== slot) return;
      if (entry.container.isConnected) restores.set(key, captureDetachables(entry.container));
      if (parking) moveNode(parking, entry.container);
      pendingDrop.add(key);
      if (!flushQueued) {
        flushQueued = true;
        queueMicrotask(flush);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },

    setParking(el) {
      parking = el;
    },
  };
}
