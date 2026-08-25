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
  * @covers MODAL-01
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

/** Una stringa di className soddisfa il selettore? (solo token di classe: gli
 *  attributi ARIA non stanno nel className). */
function matches(className: string, selector: string): boolean {
  const have = new Set(className.split(/\s+/).filter(Boolean));
  return classTokensOf(selector).some((t) => have.has(t));
}

test('MODAL_PANEL è riconosciuto come modale — è il legame che regge tutto', () => {
  expect(matches(MODAL_PANEL, MODAL_SURFACE_SELECTOR)).toBe(true);
});

test('il backdrop NON è la superficie: conta la card, non il velo', () => {
  // Se contasse anche il velo, un modale che disegna solo il backdrop (in
  // uscita, in animazione) terrebbe Escape disarmato più a lungo del dovuto.
  expect(matches(MODAL_OVERLAY, MODAL_SURFACE_SELECTOR)).toBe(false);
  expect(matches(MODAL_BACKDROP, MODAL_SURFACE_SELECTOR)).toBe(false);
});

test('popover e menu NON sono modali: hanno il loro Escape (useDismissable)', () => {
  // L'errore opposto: un tooltip aperto che disarma l'interruzione del turno.
  expect(matches(POPOVER_SURFACE, MODAL_SURFACE_SELECTOR)).toBe(false);
  expect(matches(POPOVER_PANEL, MODAL_SURFACE_SELECTOR)).toBe(false);
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
