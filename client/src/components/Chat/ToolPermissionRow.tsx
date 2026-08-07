import { useState } from 'react';
import { ShieldQuestion, Loader2, Check, ShieldCheck, Ban } from 'lucide-react';
import type { PermissionDecision, ToolPermissionOutcome, ToolPermissionRequest } from '../../types';
import { PERMISSION_CHOICES, PERMISSION_HINTS, PERMISSION_LABELS, summarizeToolInput } from '../../../../shared/permission-decision';

/**
 * Il pannello di un PERMESSO. Non è il form delle domande, e non lo era mai
 * stato davvero.
 *
 * Il primo taglio riusava `ToolInputForm` con uno schema `kind: 'questions'`,
 * per ereditare gratis pannello inline, ambra della tab e sopravvivenza al
 * reload. Reggeva, e ha lasciato la firma di una cosa nel posto sbagliato:
 * dentro il form delle domande sono servite TRE eccezioni — spegnere «Altro»
 * (qui il testo libero non è una risposta: il server ne riconosce tre e tutto
 * il resto valeva NEGA), cambiare l'etichetta del tasto, cambiare l'occhiello.
 * E la decisione viaggiava come TESTO dentro una mappa di risposte,
 * riconosciuta per prefisso di stringa.
 *
 * Qui invece: tre bottoni, una `PermissionDecision` sul filo, nessuna prosa da
 * interpretare. Un click = una decisione, senza il passaggio «scegli poi
 * invia» — su tre esiti esatti quel secondo gesto non aggiunge una scelta,
 * aggiunge un'occasione di lasciare il pannello a metà.
 */
interface Props {
  request: ToolPermissionRequest;
  /** Presente quando è già stata presa: la riga mostra l'esito, non i bottoni. */
  outcome?: ToolPermissionOutcome;
  /** Risolve quando il server conferma; rigetta con `{message}` su 4xx/5xx. */
  onDecide: (decision: PermissionDecision) => Promise<void>;
  toolCallId: string;
}

const DECISION_ICON = {
  allow: Check,
  allow_always: ShieldCheck,
  deny: Ban,
} as const;

export function ToolPermissionRow({ request, outcome, onDecide, toolCallId }: Props) {
  const [sending, setSending] = useState<PermissionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeToolInput(request.input);

  // Già decisa: resta la riga, non i bottoni. Un pannello che continua a
  // invitare un click dopo che la decisione è partita è un pannello che mente.
  if (outcome) {
    const Icon = DECISION_ICON[outcome.decision];
    return (
      <div
        className="mt-1.5 flex items-center gap-1.5 rounded-md bg-app-hover/30 px-3 py-1.5 text-[12px] text-app-text-muted"
        data-testid={`tool-permission-outcome-${toolCallId}`}
      >
        <Icon size={12} className={outcome.decision === 'deny' ? 'text-red-500' : 'text-emerald-500'} />
        <span>
          {PERMISSION_LABELS[outcome.decision]} · <span className="font-mono">{request.toolName}</span>
        </span>
      </div>
    );
  }

  async function decide(decision: PermissionDecision) {
    if (sending) return;
    setError(null);
    setSending(decision);
    try {
      await onDecide(decision);
    } catch (err: unknown) {
      const message = err && typeof err === 'object' && 'message' in err ? String((err as { message?: unknown }).message) : null;
      setError(message || 'La decisione non è arrivata al server');
      setSending(null);
    }
  }

  return (
    <div
      className="mt-1.5 space-y-2.5 rounded-md border border-amber-500/25 bg-app-hover/30 px-3 py-2.5"
      data-testid={`tool-permission-${toolCallId}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
        <ShieldQuestion size={12} />
        <span>L'agente chiede un permesso</span>
      </div>

      {/* Il nome dello strumento e con quali argomenti: un permesso concesso
          senza vedere cosa farà non è un permesso, è un pulsante. Alla misura
          del corpo della chat (13px), non del chrome del log: è la cosa su cui
          si decide. */}
      <div className="space-y-1">
        <div className="font-mono text-[13px] leading-snug text-app-text break-all">{request.toolName}</div>
        {summary && (
          <div className="font-mono text-[11.5px] leading-snug text-app-text-muted break-all" data-testid="tool-permission-detail">
            {summary}
          </div>
        )}
      </div>

      {error && <div className="rounded px-2 py-1 text-[12px] text-red-500 bg-red-500/5">{error}</div>}

      <div className="flex flex-wrap gap-1.5">
        {PERMISSION_CHOICES.map((choice) => {
          const Icon = DECISION_ICON[choice];
          const isDeny = choice === 'deny';
          return (
            <button
              key={choice}
              type="button"
              onClick={() => void decide(choice)}
              disabled={sending !== null}
              title={PERMISSION_HINTS[choice]}
              data-testid={`tool-permission-${choice}-${toolCallId}`}
              className={
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' +
                (isDeny
                  ? 'text-app-text-secondary hover:bg-app-hover'
                  : choice === 'allow'
                  ? 'bg-primary text-white hover:bg-primary-hover'
                  : 'text-app-text border border-app-border hover:bg-app-hover')
              }
            >
              {sending === choice ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
              {PERMISSION_LABELS[choice]}
            </button>
          );
        })}
      </div>

      <div className="text-[11px] leading-snug text-app-text-muted">{PERMISSION_HINTS.allow_always}</div>
    </div>
  );
}
