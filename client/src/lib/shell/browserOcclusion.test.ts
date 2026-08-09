import { test, expect } from 'bun:test';
import { slotIntersectsRects, decideFreeze, OVERLAY_SELECTOR, type OverlayRect } from './browserOcclusion';
import { MODAL_PANEL } from '../modalStyles';
import { POPOVER_SURFACE, POPOVER_PANEL, POPOVER_SHEET } from '../popoverStyles';

const slot = { x: 100, y: 100, width: 200, height: 200 }; // covers 100..300 × 100..300

test('an overlay overlapping the slot intersects', () => {
  const o: OverlayRect = { left: 250, top: 250, right: 350, bottom: 350 }; // overlaps the corner
  expect(slotIntersectsRects(slot, [o])).toBe(true);
});

test('an overlay fully inside the slot intersects', () => {
  const o: OverlayRect = { left: 150, top: 150, right: 180, bottom: 180 };
  expect(slotIntersectsRects(slot, [o])).toBe(true);
});

test('an overlay nowhere near the slot does NOT intersect (the key non-kludge case)', () => {
  const toolbarMenu: OverlayRect = { left: 0, top: 0, right: 80, bottom: 60 }; // top-left, far from the pane
  expect(slotIntersectsRects(slot, [toolbarMenu])).toBe(false);
});

test('edge-touching (shared border, zero overlap area) does NOT count as intersecting', () => {
  const flush: OverlayRect = { left: 300, top: 100, right: 400, bottom: 300 }; // left edge == slot right edge
  expect(slotIntersectsRects(slot, [flush])).toBe(false);
});

test('any one of several overlays intersecting is enough', () => {
  const far: OverlayRect = { left: 0, top: 0, right: 10, bottom: 10 };
  const over: OverlayRect = { left: 120, top: 120, right: 140, bottom: 140 };
  expect(slotIntersectsRects(slot, [far, over])).toBe(true);
});

test('a zero-area slot is never occluded', () => {
  const o: OverlayRect = { left: 0, top: 0, right: 9999, bottom: 9999 };
  expect(slotIntersectsRects({ x: 100, y: 100, width: 0, height: 0 }, [o])).toBe(false);
});

test('no overlays → not occluded', () => {
  expect(slotIntersectsRects(slot, [])).toBe(false);
});

// ── Structural invariant for checklist point 11: modals render ABOVE the
// native browser pane. The pane composites over the DOM, so a modal is only
// lifted above it when the occlusion tracker recognises the modal CARD as an
// overlay (freeze-frame path in useTauriBrowser). That recognition hinges on
// the modal's class string matching OVERLAY_SELECTOR. These tests lock that
// link so a refactor that drops `native-occlude` from MODAL_PANEL — or the
// `.glass-surface` marker from popovers — fails HERE instead of silently
// leaving Settings & co. hidden behind a browser pane on Tauri.

/** Does a space-separated className match a class-token selector list?
 *  OVERLAY_SELECTOR is only class tokens (`.foo`) + attribute selectors — for
 *  a plain class string the class tokens are what matter. */
function classStringMatchesSelector(className: string, selector: string): boolean {
  const classTokens = selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'))
    .map((s) => s.slice(1));
  const have = new Set(className.split(/\s+/).filter(Boolean));
  return classTokens.some((t) => have.has(t));
}

test('MODAL_PANEL (Settings & every full-screen dialog) is recognised as an overlay', () => {
  // MODAL_PANEL must carry a class in OVERLAY_SELECTOR (currently `native-occlude`),
  // otherwise a Settings modal would NOT freeze the native pane and would render
  // BEHIND it on Tauri.
  expect(MODAL_PANEL).toContain('native-occlude');
  expect(classStringMatchesSelector(MODAL_PANEL, OVERLAY_SELECTOR)).toBe(true);
});

test('POPOVER_SURFACE (context menus / dropdowns) is recognised as an overlay', () => {
  // Menus use `.glass-surface` (in OVERLAY_SELECTOR), so a right-click menu over
  // a browser pane also lifts above it.
  expect(classStringMatchesSelector(POPOVER_SURFACE, OVERLAY_SELECTOR)).toBe(true);
});

test('a modal card overlapping a browser-pane slot is detected as occluding it', () => {
  // End-to-end of the two halves: a modal-sized rect centred over the pane slot
  // intersects → freeze fires → the modal composites over the still.
  const modalOverPane: OverlayRect = { left: 120, top: 120, right: 280, bottom: 280 };
  expect(slotIntersectsRects(slot, [modalOverPane])).toBe(true);
});

// ── Guardrail for the unified `Menu` primitive (dropdown-unification). Every
// menu built on `Menu` carries BOTH a `.glass-surface` (via POPOVER_*) and a
// `role="menu"`/`"listbox"` container. Either alone is enough to match
// OVERLAY_SELECTOR, so a menu can't accidentally render behind a native pane.
// These lock the two halves of that marker so a refactor that drops the glass
// token from a POPOVER_* surface, or the role from OVERLAY_SELECTOR, fails HERE.

test('every POPOVER_* surface carries the glass-surface occlusion marker', () => {
  // Menu uses POPOVER_SURFACE (desktop) and POPOVER_SHEET (mobile); POPOVER_PANEL
  // backs the header/scroll pickers. All three must stay recognisable overlays.
  for (const surface of [POPOVER_SURFACE, POPOVER_PANEL, POPOVER_SHEET]) {
    expect(surface).toContain('glass-surface');
    expect(classStringMatchesSelector(surface, OVERLAY_SELECTOR)).toBe(true);
  }
});

test('OVERLAY_SELECTOR matches the Menu container roles', () => {
  // Menu sets role="menu" (action menus) or role="listbox" (pickers) on its
  // panel; both must be in the selector so the role alone lifts the menu.
  expect(OVERLAY_SELECTOR).toContain('[role="menu"]');
  expect(OVERLAY_SELECTOR).toContain('[role="listbox"]');
});

// ── «Non so dove sto» non è «non mi copre nessuno» ──────────────────────────
// Il silenzio era il difetto: una pane senza rettangolo non si congelava mai, e
// un menu aperto sopra di lei finiva sotto la webview nativa senza che niente
// lo segnalasse. La decisione ora è esplicita e sbaglia dalla parte che si può
// guardare: nel dubbio si congela.

test('senza rettangolo e con un overlay aperto, la pane si congela lo stesso', () => {
  const menu: OverlayRect = { left: 0, top: 0, right: 80, bottom: 60 };
  expect(decideFreeze(null, [menu])).toBe(true);
});

test('senza rettangolo e senza overlay non si congela niente', () => {
  // La prudenza vale solo quando c'è davvero qualcosa da proteggere: fuori da
  // quel caso una pane senza rettangolo resta viva.
  expect(decideFreeze(null, [])).toBe(false);
});

test('col rettangolo, decide l\'intersezione e non altro', () => {
  const lontano: OverlayRect = { left: 0, top: 0, right: 80, bottom: 60 };
  const sopra: OverlayRect = { left: 120, top: 120, right: 280, bottom: 280 };
  expect(decideFreeze(slot, [lontano])).toBe(false);
  expect(decideFreeze(slot, [sopra])).toBe(true);
});
