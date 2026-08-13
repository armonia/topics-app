import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useMobile } from '../../hooks/useMobile';
import { useDismissable } from '../../hooks/useDismissable';
import { useMenuKeyboard } from '../../hooks/useMenuKeyboard';
import { useSheetDrag } from '../../hooks/useSheetDrag';
import { SheetGrabber } from './SheetGrabber';
// Import RELATIVI e non `@/lib/...`: l'alias lo risolve Vite, `bun test` no. Da
// quando `Shared/Select` (che passa di qui) è usato dalle Impostazioni e dai
// modali, questo file entra nel grafo che i test unitari importano davvero —
// e con l'alias due suite morivano su «Cannot find module» prima di eseguire
// una riga.
import { computeMenuPosition } from '../../lib/popoverPosition';
import { POPOVER_SURFACE, POPOVER_SHEET, Z_POPOVER, Z_POPOVER_SCRIM } from '../../lib/popoverStyles';

/**
 * Menu — the ONE anchored-popover primitive. Every custom menu / dropdown in the
 * app should route through here (directly or via the `DropdownPortal` wrapper) so
 * they all inherit, for free and identically:
 *   - a portal to <body> (escapes parent `overflow`/stacking contexts),
 *   - viewport-aware placement with flip-above + horizontal clamp (`computeMenuPosition`),
 *   - the `useDismissable` contract (outside-pointer close, Escape, focus-restore),
 *   - roving keyboard nav (Arrow/Home/End) over real focusable items, più
 *     l'attivazione col tasto NUDO per le righe che dichiarano `data-mnemonic`
 *     (hooks/useMenuKeyboard),
 *   - `role="menu"`/`"listbox"` + `.glass-surface` — the double marker
 *     `browserOcclusion.OVERLAY_SELECTOR` needs to lift the menu over native panes,
 *   - the mobile bottom-sheet, and the tokenised `Z_POPOVER` layer.
 *
 * Look is unchanged: it reuses the canonical `POPOVER_SURFACE`/`POPOVER_SHEET`.
 */

// La selezione delle righe navigabili vive in `hooks/useMenuKeyboard` insieme
// alla regola che la usa — qui c'era una copia, e una regola in due posti è una
// regola che diverge.

export interface MenuProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  /** Which trigger edge the menu aligns to (default 'left'). */
  align?: 'left' | 'right';
  /** Container role — 'menu' for action menus, 'listbox' for pickers. Default 'menu'. */
  role?: 'menu' | 'listbox';
  /** Desktop min panel width in px (default 150). */
  minWidth?: number;
  /** Extra class names appended to the desktop panel. */
  className?: string;
  /** Let the panel own its focus + keyboard (e.g. a search field + custom list).
   *  Disables the container auto-focus and roving-tabindex. Default false. */
  unmanagedFocus?: boolean;
  /** Return focus to the trigger on close (default true). */
  restoreFocus?: boolean;
  /** Extra nodes that count as "inside" for dismissal (nested panels/menus). */
  extraRefs?: Array<React.RefObject<HTMLElement | null>>;
  /** `data-testid` sul pannello. Serve ai call-site il cui pannello è già un
   *  contratto per i test (es. `pane-add-menu`, atteso da 16 spec E2E): senza,
   *  adottare la primitiva significherebbe romperli tutti. */
  testId?: string;
  /** Etichetta accessibile del menu (`aria-label` sul pannello). */
  ariaLabel?: string;
  /** false = aprendosi NON chiude gli altri popover (sotto-superficie). */
  exclusive?: boolean;
}

export function Menu({
  open,
  anchorRef,
  onClose,
  children,
  align = 'left',
  role = 'menu',
  minWidth = 150,
  className = '',
  unmanagedFocus = false,
  restoreFocus = true,
  extraRefs,
  testId,
  ariaLabel,
  exclusive = true,
}: MenuProps) {
  const { isMobile } = useMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Il foglio dal basso si spinge giù col dito (hooks/useSheetDrag). Sul
  // cartellino ancorato del desktop non c'è niente da trascinare.
  useSheetDrag({ enabled: open && isMobile, sheetRef: panelRef, scrimRef, onClose });

  // Dismissal: trigger + panel (+ any caller sub-panels) are "inside".
  useDismissable({
    open,
    onClose,
    refs: [anchorRef, panelRef, ...(extraRefs ?? [])],
    restoreFocus,
    exclusive,
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const next = computeMenuPosition(a, { width: p.width, height: p.height }, { align });
    setPos({ top: next.top, left: next.left });
  }, [anchorRef, align]);

  // Measure the real panel and place it BEFORE paint; keep it placed while open.
  useLayoutEffect(() => {
    if (!open || isMobile) {
      // Clear the measured position when hidden so the next open re-measures
      // from scratch; paired with reposition()'s measure below.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPos(null);
      return;
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, isMobile, reposition]);

  // Move focus INTO the menu on open (container, tabIndex=-1) so Arrow keys work
  // and screen readers announce it — no per-item ring for mouse users.
  useEffect(() => {
    if (!open || unmanagedFocus || isMobile) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [open, unmanagedFocus, isMobile]);

  const onKeyDown = useMenuKeyboard({ panelRef, enabled: !unmanagedFocus });

  if (!open) return null;

  return createPortal(
    <>
      {/* Il velo del foglio dal basso era TRASPARENTE — nessuno sfondo — quindi
          non c'era niente a staccarlo dalla pagina. Da quando su mobile le
          superfici di base collassano in una sola, il foglio dipinge il pixel
          del suo fondo e resterebbe in piedi sul solo bordo (misurato: 1,04:1 in
          chiaro; in scuro l'ombra è nero su quasi-nero e non aiuta). Il gemello
          in `ChatInput` usa `bg-black/40` da sempre: qui mancava e basta. */}
      {isMobile && (
        <div ref={scrimRef} className="fixed inset-0 bg-black/40" style={{ zIndex: Z_POPOVER_SCRIM }} onClick={onClose} />
      )}
      <div
        ref={panelRef}
        role={role}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid={testId}
        // Marchio STABILE «questo è un menu fluttuante», per chi deve
        // distinguere il fuoco dentro un popover dal fuoco su un campo della
        // pagina. Il pannello è portalato su <body>, quindi un `closest()`
        // sull'ospite React non lo trova mai: senza questo marchio la board
        // scambiava la casella di ricerca del picker progetto per «l'utente sta
        // scrivendo altrove» e SMONTAVA il composer che ospitava il menu — il
        // popover spariva sotto il primo carattere digitato.
        data-popover=""
        aria-label={ariaLabel}
        className={
          isMobile
            // Tetto e scroll: senza, il foglio dal basso cresce verso l'ALTO
            // oltre lo schermo e le prime voci diventano irraggiungibili —
            // `html, body, #root` hanno `overflow: hidden`, quindi non c'e'
            // nessun modo di recuperarle. Caso vero: il menu di overflow della
            // riga progetto, 10 voci, reso SOLO su tocco: 475px contro i ~390
            // di un telefono in orizzontale.
            //
            // `100dvh` e non una frazione fissa: `70vh` taglierebbe anche in
            // verticale, dove oggi il menu si vede intero. `overscroll-contain`
            // e' obbligatorio perche' gli antenati hanno gia'
            // `overscroll-behavior-y: contain`: senza, il rubber-band di iOS
            // annulla il gesto di scorrimento.
            //
            // E `className` ANCHE qui: era concatenato solo nel ramo desktop,
            // quindi le larghezze che i chiamanti passano (`max-w-[460px]`,
            // `w-[420px]`, `w-48`) erano gia' oggi silenziosamente morte sotto
            // i 768px. Il tetto e lo scroll pero' NON stanno in classe ma nello
            // stile qui sotto: uno dei chiamanti passa `overflow-hidden`, e fra
            // due utility dello stesso layer a vincere e' l'ordine nel foglio
            // generato, non quello nell'attributo. Lo stile inline non ha
            // questa ambiguita'.
            ? `fixed bottom-0 left-0 right-0 ${POPOVER_SHEET} outline-none overscroll-contain ${className}`
            : `${POPOVER_SURFACE} outline-none ${className}`
        }
        style={
          isMobile
            ? {
                zIndex: Z_POPOVER,
                paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)',
                maxHeight: 'calc(100dvh - 3rem)',
                overflowY: 'auto',
              }
            : {
                position: 'fixed',
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                minWidth,
                zIndex: Z_POPOVER,
                // Hidden for the one layout pass before we've measured, so the
                // menu never flashes at the guess position.
                visibility: pos ? 'visible' : 'hidden',
              }
        }
      >
        {isMobile && <SheetGrabber />}
        {children}
      </div>
    </>,
    document.body,
  );
}
