/**
 * La regola che decide se Escape può interrompere il turno dell'AI.
 *
 * Il bug che questi test inchiodano: con un modale aperto che NON stava nella
 * lista scritta a mano dentro `useKeyboardShortcuts` (Impostazioni, roster
 * agenti, editor di profilo, lightbox delle anteprime), Escape cadeva nel ramo
 * "niente da chiudere" e ammazzava il turno in streaming dietro al modale.
 *
 * Due cose vanno tenute ferme, e sono qui:
 *   1. il comportamento di `hasOpenModalSurface` (aperto/chiuso/nascosto);
 *   2. il LEGAME strutturale — che gli stili condivisi dei modali continuino a
 *      soddisfare il selettore, e che i popover/menu continuino a NON farlo.
 *      Se qualcuno toglie `native-occlude` da `MODAL_PANEL`, o mette
 *      `glass-surface` su un modale, deve rompersi QUI.
  * @covers MODAL-01, LAYOUT-38
 */
import { test, expect } from 'bun:test';
import {
  hasOpenModalSurface,
  MODAL_SURFACE_SELECTOR,
  type ModalSurfaceNode,
  type ModalSurfaceRoot,
} from './modalSurface';
import { MODAL_PANEL, MODAL_OVERLAY, MODAL_BACKDROP } from './modalStyles';
import { POPOVER_SURFACE, POPOVER_PANEL } from './popoverStyles';
import { OVERLAY_SELECTOR } from './shell/browserOcclusion';

// ── 1. Comportamento ────────────────────────────────────────────────────────

const node = (rects: number): ModalSurfaceNode => ({ getClientRects: () => ({ length: rects }) });
const root = (nodes: ModalSurfaceNode[]): ModalSurfaceRoot => ({ querySelectorAll: () => nodes });

test('nessun modale nel DOM → Escape resta libero di interrompere il turno', () => {
  expect(hasOpenModalSurface(root([]))).toBe(false);
});

test('un modale aperto → Escape NON deve arrivare allo stop del turno', () => {
  expect(hasOpenModalSurface(root([node(1)]))).toBe(true);
});

test('un modale montato ma non disegnato (display:none) non conta', () => {
  // Altrimenti basterebbe averlo aperto una volta per disarmare Escape per
  // sempre: chi tiene il nodo montato per conservare lo stato lo lascia lì.
  expect(hasOpenModalSurface(root([node(0)]))).toBe(false);
});

test('basta UNO visibile in mezzo a tanti nascosti', () => {
  expect(hasOpenModalSurface(root([node(0), node(0), node(1), node(0)]))).toBe(true);
});

// ── 2. Legame strutturale ───────────────────────────────────────────────────

/** I token di classe richiesti da un selettore (`.foo, [role=x]` → ['foo']). */
function classTokensOf(selector: string): string[] {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'))
    .map((s) => s.slice(1));
}

/** The node, mounted, answering `Element.matches` on a runtime with no DOM.
 *
 *  `bun test` has no document: `document`, `Element` and `DOMParser` are all
 *  undefined (probed on bun 1.3.8), so the element is parsed by `HTMLRewriter`,
 *  which is a real CSS selector engine and therefore reads ATTRIBUTES and not
 *  only class tokens. One element is mounted alone, so "the selector matched
 *  something" and "this element matches" are the same sentence.
 *
 *  It replaces a helper that only compared class tokens, and the difference is
 *  the whole point of the negative contracts below: half of
 *  MODAL_SURFACE_SELECTOR is `[role="dialog"]`, so a class-token comparison was
 *  blind to the one line that would turn pane zoom into a modal (LAYOUT-38). */
function mount(html: string): { matches(selector: string): boolean } {
  return {
    matches(selector: string): boolean {
      let hit = false;
      new HTMLRewriter().on(selector, { element() { hit = true; } }).transform(html);
      return hit;
    },
  };
}

/** A bare element carrying just a class string: the shape of the shared style
 *  constants, which are className values and nothing else. */
function mountWithClass(className: string): { matches(selector: string): boolean } {
  return mount(`<div class="${className}"></div>`);
}

test('MODAL_PANEL è riconosciuto come modale — è il legame che regge tutto', () => {
  expect(mountWithClass(MODAL_PANEL).matches(MODAL_SURFACE_SELECTOR)).toBe(true);
});

test('il backdrop NON è la superficie: conta la card, non il velo', () => {
  // Se contasse anche il velo, un modale che disegna solo il backdrop (in
  // uscita, in animazione) terrebbe Escape disarmato più a lungo del dovuto.
  expect(mountWithClass(MODAL_OVERLAY).matches(MODAL_SURFACE_SELECTOR)).toBe(false);
  expect(mountWithClass(MODAL_BACKDROP).matches(MODAL_SURFACE_SELECTOR)).toBe(false);
});

test('popover e menu NON sono modali: hanno il loro Escape (useDismissable)', () => {
  // L'errore opposto: un tooltip aperto che disarma l'interruzione del turno.
  expect(mountWithClass(POPOVER_SURFACE).matches(MODAL_SURFACE_SELECTOR)).toBe(false);
  expect(mountWithClass(POPOVER_PANEL).matches(MODAL_SURFACE_SELECTOR)).toBe(false);
});

test('ogni marcatore di modale è anche un marcatore di occlusione nativa', () => {
  // Sottoinsieme stretto di OVERLAY_SELECTOR: un modale che sta sopra alla pane
  // nativa (Tauri) ma che qui non risultasse aperto sarebbe di nuovo il bug.
  const occlusion = classTokensOf(OVERLAY_SELECTOR);
  for (const token of classTokensOf(MODAL_SURFACE_SELECTOR)) {
    expect(occlusion).toContain(token);
  }
  expect(OVERLAY_SELECTOR).toContain('[role="dialog"]');
});

// ── 3. The other direction: what must NOT count (LAYOUT-38) ────────────────
// Pane zoom is LAYOUT, not a modal: it changes the weights of the split tree
// and paints a frame around the surviving cell. If its container or its veil
// satisfied this selector, `hasOpenModalSurface` would be true for as long as
// the zoom lasts, and Escape would stop interrupting the streaming turn:
// enlarging a chat is what you do to WATCH the agent work, and it would take
// away the key that stops it. One line causes all of that, `role="dialog"`, and
// it is exactly the one the old class-token comparison could not see.
//
// The nodes are mounted here rather than imported from the component: the
// contract is on the SHAPE of the markup, not on the wiring, and it has to hold
// the day somebody writes it (or rewrites it) somewhere else.

/** The frame the zoom paints, as the surface renders it: the node carrying
 *  `data-pane-zoom`, and the stage that holds the tree. */
const ZOOM_CONTAINER: Array<[string, string]> = [
  ['la superficie ingrandita', '<div data-split-surface data-pane-zoom="1" class="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"></div>'],
  ['lo stage dello zoom', '<div class="pane-zoom-stage"></div>'],
];

/** The veil over the frame: click to exit, out of the tab order, and carrying
 *  its own no-drag attributes. */
const ZOOM_SCRIM =
  '<div class="pane-zoom-scrim app-no-drag" data-testid="pane-zoom-scrim" data-tauri-drag-region="false" aria-hidden="true"></div>';

test('il contenitore dello zoom NON e\' una superficie modale: Escape resta dell\'agente', () => {
  for (const [label, html] of ZOOM_CONTAINER) {
    expect(mount(html).matches(MODAL_SURFACE_SELECTOR), label).toBe(false);
  }
});

test('nemmeno il velo dello zoom lo e\', attributi di ruolo compresi', () => {
  expect(mount(ZOOM_SCRIM).matches(MODAL_SURFACE_SELECTOR)).toBe(false);
});
