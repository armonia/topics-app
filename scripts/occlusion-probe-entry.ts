/**
 * Entry del banco di prova dell'occlusione (vedi `scripts/check-occlusion.mjs`).
 *
 * Non è codice di produzione e non è importato dall'app: esiste per portare il
 * modulo VERO — `lib/shell/browserOcclusion` — dentro un WebKit vero, che è
 * l'unico posto dove le domande in gioco hanno una risposta (un'animazione CSS
 * che parte, una `opacity` calcolata a metà transizione, `getAnimations()`).
 * Riscrivere quella logica dentro lo script di prova proverebbe soltanto che la
 * copia funziona; qui gira l'originale.
 */
import {
  onOcclusionChange,
  decideFreeze,
  slotIntersectsRects,
  currentOverlays,
  type OverlayRect,
} from '../client/src/lib/shell/browserOcclusion';
import { MODAL_PANEL } from '../client/src/lib/modalStyles';
import { POPOVER_SURFACE } from '../client/src/lib/popoverStyles';

declare global {
  interface Window {
    __occl?: {
      onOcclusionChange: typeof onOcclusionChange;
      decideFreeze: typeof decideFreeze;
      slotIntersectsRects: typeof slotIntersectsRects;
      currentOverlays: typeof currentOverlays;
      MODAL_PANEL: string;
      POPOVER_SURFACE: string;
    };
    __occlSeen?: OverlayRect[][];
  }
}

window.__occl = {
  onOcclusionChange,
  decideFreeze,
  slotIntersectsRects,
  currentOverlays,
  MODAL_PANEL,
  POPOVER_SURFACE,
};
