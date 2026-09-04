import { useState } from 'react';
import { ShieldQuestion, Loader2, Check, ShieldCheck, ShieldOff, Ban } from 'lucide-react';
import type { PermissionDecision, ToolPermissionOutcome, ToolPermissionRequest } from '../../types';
import { PERMISSION_CHOICES, PERMISSION_HINT_KEY, PERMISSION_LABEL_KEY, summarizeToolInput } from '../../../../shared/permission-decision';
import { useT } from '../../hooks/useT';

/**
 * The PERMISSION panel. It is not the question form, and it never really was.
 *
 * The first cut reused `ToolInputForm` with a `kind: 'questions'` schema, to
 * inherit the inline panel, the amber tab and surviving a reload for free. It
 * held, and it left the signature of a thing in the wrong place: inside the
 * question form it took THREE exceptions. Switch off the free-text answer
 * (here free text is not an answer: the server knows three outcomes and
 * everything else counted as DENY), change the button label, change the
 * eyebrow. Three exceptions are the sign that something is in the wrong place.
 *
 * Here instead: three buttons, a `PermissionDecision` on the wire, no prose to
 * interpret. One click is one decision, without the "pick then send" step. On
 * three exact outcomes that second gesture adds no choice, it adds a chance of
 * leaving the panel half done.
 *
 * A FOURTH ACTION, which does not stand in the row.
 * "Switch to free mode" (`allow_free`) allows THIS request and puts the
 * session in free mode: from there on it stops asking. It is the only press
 * that changes the regime instead of the outcome, so it lives below a line,
 * with its own treatment and the line that says what it entails and how to
 * come back. Next to "Allow" it would have made the heaviest decision in the
 * panel the easiest one to take by mistake.
 *
 * The WORDS of the four decisions are not here and not in `shared/` either:
 * they are i18n keys (`PERMISSION_LABEL_KEY`), because the panel where a
 * person decides whether an agent may touch their files was the one panel the
 * language selector could not reach.
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
  allow_free: ShieldOff,
} as const;

export function ToolPermissionRow({ request, outcome, onDecide, toolCallId }: Props) {
  const tr = useT();
  const [sending, setSending] = useState<PermissionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeToolInput(request.input);

  // Già decisa: resta la riga, non i bottoni. Un pannello che continua a
  // invitare un click dopo che la decisione è partita è un pannello che mente.
  if (outcome) {
    const Icon = DECISION_ICON[outcome.decision];
    const freed = outcome.decision === 'allow_free';
    return (
      <div
        className="mt-1.5 flex items-center gap-1.5 rounded-md bg-app-hover/30 px-3 py-1.5 text-[12px] text-app-text-muted"
        data-testid={`tool-permission-outcome-${toolCallId}`}
      >
        <Icon
          size={12}
          className={outcome.decision === 'deny' ? 'text-red-500' : freed ? 'text-amber-500' : 'text-emerald-500'}
        />
        <span>
          {tr(PERMISSION_LABEL_KEY[outcome.decision])} · <span className="font-mono">{request.toolName}</span>
          {/* Chi ha deciso si scrive solo dove cambia il regime: su un
              «Consenti» non c'è niente da attribuire. */}
          {freed && outcome.actor && <> · {tr('permission.decidedBy', { actor: outcome.actor })}</>}
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
      setError(message || tr('permission.notDelivered'));
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
        <span>{tr('permission.asks')}</span>
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
              title={tr(PERMISSION_HINT_KEY[choice])}
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
              {tr(PERMISSION_LABEL_KEY[choice])}
            </button>
          );
        })}
      </div>

      <div className="text-[11px] leading-snug text-app-text-muted">{tr(PERMISSION_HINT_KEY.allow_always)}</div>

      {/* ── «Passa a libero» ────────────────────────────────────────────────
          Sotto una linea, e non in fila con gli altri tre, perché non è un
          quarto esito della stessa domanda: gli altri decidono di QUESTA
          richiesta, questo decide di tutte quelle che verranno. Un bottone
          uguale agli altri, a un pollice di distanza da «Consenti», sarebbe
          esattamente il modo in cui si toglie una barriera di sicurezza per
          sbaglio.

          Il testo dice le due cose che servono per premerlo con cognizione:
          cosa smette di succedere, e da dove si torna indietro. */}
      <div className="border-t border-app-border-light pt-2 space-y-1">
        <button
          type="button"
          onClick={() => void decide('allow_free')}
          disabled={sending !== null}
          title={tr(PERMISSION_HINT_KEY.allow_free)}
          data-testid={`tool-permission-allow_free-${toolCallId}`}
          className={
            'flex w-full items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-1.5 ' +
            'text-[12.5px] font-medium text-amber-600 dark:text-amber-400 transition-colors ' +
            'hover:bg-amber-500/15 disabled:opacity-40 disabled:cursor-not-allowed'
          }
        >
          {sending === 'allow_free' ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
          {tr(PERMISSION_LABEL_KEY.allow_free)}
        </button>
        <div className="text-[11px] leading-snug text-app-text-muted">{tr(PERMISSION_HINT_KEY.allow_free)}</div>
      </div>
    </div>
  );
}
