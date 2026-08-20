import { ClipboardList, Check, X } from 'lucide-react';
import { useT } from '@/hooks/useT';

/**
 * Il piano che aspetta la tua approvazione, DOVE si risponde.
 *
 * Stava solo dentro il messaggio, come pannello sulla riga del tool. Ma in
 * questa chat ciò che aspetta te vive nella striscia sopra il composer —
 * l'obiettivo, la todo, i sotto-agenti, i checkpoint stanno tutti lì — e una
 * decisione lasciata a metà trascrizione la trovi solo se stai già guardando
 * quel punto. Qui è dove finisce l'occhio quando si sta per scrivere.
 *
 * La riga NON ripete il piano: quello sta nella sua card, con la sua struttura.
 * Qui c'è la scelta, e basta.
 */
export function PlanApprovalBar({ onApprove, onReject, busy }: {
  onApprove: () => void;
  onReject: () => void;
  /** Mentre la scelta è in volo i due tasti si spengono: un doppio click
   *  manderebbe due turni. */
  busy?: boolean;
}) {
  const tr = useT();
  return (
    <div
      data-testid="plan-approval-bar"
      className="mx-2 mb-1.5 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
    >
      <ClipboardList size={14} className="flex-shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-app-text">
        {tr('plan.awaiting')}
      </span>
      <button
        type="button"
        onClick={onReject}
        disabled={busy}
        data-testid="plan-reject"
        className="flex-shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-40 transition-colors"
      >
        <X size={12} /> Rifiuta
      </button>
      <button
        type="button"
        onClick={onApprove}
        disabled={busy}
        data-testid="plan-approve"
        className="flex-shrink-0 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
      >
        <Check size={12} /> {tr('plan.approveAndRun')}
      </button>
    </div>
  );
}
