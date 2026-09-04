import { useRef, type ReactNode } from 'react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useT } from '../../hooks/useT';

/**
 * ONE confirmation dialog for the destructive actions.
 *
 * There used to be THREE copies of it, identical line by line (delete a file
 * in FileExplorer, delete a branch in BranchList, discard changes in
 * GitChanges): same markup, same veil, same `useEffect` with Escape bound to
 * `document`. Three copies mean three places to fix the same defect, and all
 * three were defective in the same three ways:
 *
 *   - no `role="dialog"`, so the `hasOpenModalSurface` gate could not see
 *     them and Escape, while closing the confirmation, also killed the AI
 *     turn running behind it;
 *   - no focus trap and no initial focus: from the keyboard the first Tab
 *     left into the covered page, and on a dialog asking "shall I delete
 *     this?" you could not even tell which button you were on;
 *   - Escape on `document` instead of in capture on `window`: with two nested
 *     dialogs both answered.
 *
 * All of that now lives in `useModalDialog`, and lives in one place.
 *
 * Initial focus goes on CANCEL on purpose: this is a destructive dialog, and
 * the dangerous button must not be the one that fires when somebody presses
 * Enter out of reflex.
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
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const tr = useT();
  // The two buttons of a destructive dialog were `'Confirm'` and `'Cancel'`,
  // hard-coded as defaults. A caller that translated its own title therefore
  // shipped "Sposta nel cestino" next to an English "Cancel": the mixed
  // language showed up exactly where a person is about to lose something.
  const confirmWord = confirmLabel ?? tr('common.confirm');
  const cancelWord = cancelLabel ?? tr('common.cancel');
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
            {cancelWord}
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
            {confirmWord}
          </button>
        </div>
      </div>
    </div>
  );
}
