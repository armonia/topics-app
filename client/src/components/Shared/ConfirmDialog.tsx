import { useRef, type ReactNode } from 'react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { useModalDialog } from '../../hooks/useModalDialog';

/**
 * ConfirmDialog — UN dialogo di conferma per le azioni distruttive.
 *
 * Ne esistevano TRE copie identiche riga per riga (cancella file in
 * FileExplorer, cancella branch in BranchList, scarta modifiche in GitChanges):
 * stesso markup, stesso velo, stesso `useEffect` con Escape su `document`. Tre
 * copie vogliono dire tre posti dove correggere lo stesso difetto, ed erano
 * infatti difettose tutte e tre allo stesso modo:
 *
 *   • niente `role="dialog"`: il gate `hasOpenModalSurface` non le vedeva, e
 *     Escape — mentre chiudeva la conferma — ammazzava anche il turno dell'AI
 *     che stava girando dietro;
 *   • niente trappola del focus e niente focus iniziale: da tastiera il primo
 *     Tab usciva nella pagina coperta, e su un dialogo che chiede «cancello?»
 *     non si sapeva nemmeno su quale bottone si era;
 *   • Escape su `document` invece che in capture su `window`: con due dialoghi
 *     annidati rispondevano entrambi.
 *
 * Tutto questo ora sta in `useModalDialog`, e sta in un posto solo.
 *
 * Il focus iniziale va su ANNULLA di proposito: è un dialogo distruttivo, il
 * tasto pericoloso non deve essere quello che si attiva premendo Invio per
 * riflesso.
 */
export interface ConfirmDialogProps {
  title: string;
  /** Il corpo: testo, o markup se serve (nomi di file in mono, elenchi…). */
  children: ReactNode;
  /** Etichetta del tasto che conferma (l'interfaccia è in inglese). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' (default) = tasto rosso: cancella, scarta, forza. */
  tone?: 'danger' | 'default';
  /** Spegne il tasto che conferma: il dialogo sta ancora contando cosa tocca,
   *  oppure non c'è niente da fare. Un tasto distruttivo attivo prima di sapere
   *  su cosa cade è la stessa promessa a vuoto che il dialogo serve a evitare. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalDialog({ onClose: onCancel, panelRef, initialFocusRef: cancelRef });

  return (
    // `MODAL_OVERLAY` e non `z-[100]` scritto a mano. Le classi sono le stesse
    // riga per riga — velo, blur, centratura — TRANNE il piano, e il piano era
    // sbagliato: 100 è esattamente la quota che `lib/popoverStyles.ts` chiama
    // «l'ad-hoc chrome dell'app» e che la scala dei popover (9998–10000) è
    // costruita apposta per SCAVALCARE. Un dialogo di conferma finiva quindi
    // sotto ogni popover, sotto il velo del bottom-sheet (Z_POPOVER_SCRIM) e
    // sotto la card di pairing che arriva da sola: la stessa forma del bug per
    // cui ⌘N «apriva tutti i dropdown». Ora il piano lo dichiara la costante.
    <div
      className={MODAL_OVERLAY}
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${MODAL_PANEL} p-5 max-w-md w-full mx-4`}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-app-text-heading mb-2">{title}</h3>
        <div className="text-xs text-app-text-body mb-3">{children}</div>
        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-body hover:bg-app-hover transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={
              tone === 'danger'
                ? 'px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-red-600 transition-colors'
                : 'px-3 py-1.5 text-xs rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:hover:bg-primary transition-colors'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
