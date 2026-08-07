import { useLayoutEffect, useState, type RefObject } from 'react';
import { computeMenuPosition, type MenuPosition } from '../lib/popoverPosition';

/**
 * Colloca un popover sotto il suo bottone, misurandolo davvero.
 *
 * ── Perché non basta lo stile calcolato in render ───────────────────────────
 * Le tre tendine del pannello git scrivevano `top: trigger.bottom + 4` e
 * ricavavano il tetto dallo spazio SOTTO, in una sola passata. Due difetti in
 * una riga: non ribaltano mai, e il tetto è quello del lato peggiore.
 *
 * Misurato: l'intestazione della sezione Git si disegna anche a sezione chiusa,
 * quindi con Git e Processi collassati sotto al bottone restano 33px → tetto
 * 21px, contro un'intestazione di lista che da sola ne misura 24,5. **Zero
 * righe.** Il bottone c'è, il popover si apre, e dentro non si vede niente.
 *
 * ── Come funziona ──────────────────────────────────────────────────────────
 * Due passate, come fa già la barra delle tab: la prima rende il pannello
 * invisibile per misurarlo, la seconda lo colloca con `computeMenuPosition`,
 * che ribalta sopra quando serve e restituisce il tetto del lato SCELTO. Il
 * pannello resta `visibility: hidden` per quel solo fotogramma, così non
 * lampeggia mai nel posto sbagliato.
 */
export function useAnchoredPopover(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  opts?: { align?: 'left' | 'right'; minHeight?: number },
): MenuPosition | null {
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const align = opts?.align ?? 'left';
  const minHeight = opts?.minHeight ?? 160;

  useLayoutEffect(() => {
    // Alla chiusura si azzera: la prossima apertura deve rimisurare da capo,
    // altrimenti lampeggia per un fotogramma nel posto della volta prima.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) { setPos(null); return; }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const panel = panelRef.current;
    const rect = trigger.getBoundingClientRect();
    setPos(computeMenuPosition(
      rect,
      { width: panel?.offsetWidth ?? 0, height: panel?.offsetHeight ?? 0 },
      { align, minHeight },
    ));
  }, [open, triggerRef, panelRef, align, minHeight]);

  return pos;
}
