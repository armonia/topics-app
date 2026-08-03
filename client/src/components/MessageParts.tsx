import { useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { formatDurationMs } from './Chat/toolGrouping';
import { phraseAt } from '../lib/thinkingPhrases';
import type { WSMessage } from '../types';

// The old ToolCallBadge (colored bordered pill + raw JSON args) lived here.
// Every tool render — blocks timeline, legacy bucket AND inline contentOffset
// tools — now goes through <ToolCallRow>, the single compact row + typed-card
// language (chat-rendering-parity).

/**
 * The live "assistant is working" line. Replaces the old three bouncing dots
 * AND the generic spinner + "Streaming..." row with one consistent element for
 * the whole turn: a softly glowing dot, a playful phrase that rotates every
 * few seconds, and a running turn timer. It is rendered at the current bottom
 * of the turn, so the elapsed reads "right here, right now" — under whatever
 * step is active (thinking or the streaming prose). Per-tool steps keep their
 * own <ElapsedTimer>.
 *
 * `since` is the turn start (ms epoch); may be undefined/NaN if the message
 * timestamp is unparseable, in which case elapsed starts from mount. Both the
 * phrase and the timer advance off a single 1s tick; `elapsed` is derived
 * during render (no Date.now() at render time — react-hooks/purity, same
 * shape as ElapsedTimer).
 */
export function TurnActivityIndicator({
  since,
  sessionKey,
  onMessage,
  awaitingInput,
}: {
  since?: number;
  /** Serve solo per lo stato "lento": senza, l'indicatore resta quello normale. */
  sessionKey?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /**
   * Il turno è fermo su una domanda all'umano (un tool in `waiting_for_input`).
   * Tecnicamente il turno è ancora vivo — il messaggio resta `partial` — ma
   * "sto elaborando" con la frase che ruota e il puntino che pulsa è una bugia:
   * la palla è dall'altra parte. Qui la riga smette di fare finta di lavorare e
   * dice quello che sta davvero succedendo, in tono d'attesa.
   */
  awaitingInput?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [since]);

  // Stream lento: `stream:slow` lo accende, `stream:resumed` lo spegne.
  //
  // Il server annunciava già entrambi e NESSUNO li ascoltava; al loro posto
  // appendeva un'annotazione al CONTENUTO del messaggio, che se il turno si
  // chiudeva mentre era lento restava dentro per sempre e tornava al modello a
  // ogni turno successivo (64 messaggi così nel DB reale). L'indicatore è il
  // posto giusto: vive quanto il turno e sparisce con lui.
  //
  // L'iscrizione sta QUI e non cinque livelli più su perché `MessageContent` già
  // riceve `sessionKey` e `onMessage`: uno stato transitorio di un elemento non
  // ha motivo di attraversare l'albero come prop.
  const [slow, setSlow] = useState(false);
  // Il CONSUMO del turno mentre cresce. Stessa iscrizione, stessa ragione: uno
  // stato che vive quanto il turno non ha motivo di attraversare l'albero.
  //
  // Prima i numeri di consumo arrivavano una volta sola, a turno finito: durante
  // un turno agentico da otto tool call non si vedeva muovere niente, e l'unica
  // cosa viva era il cronometro. Il server manda i totali GIA' accumulati
  // (`stream:usage`), quindi qui non si fa aritmetica: si mostra.
  const [usage, setUsage] = useState<{ calls: number; tokens: number; costCents?: number } | null>(null);
  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage((msg: WSMessage) => {
      const m = msg as {
        type?: string; sessionKey?: string;
        calls?: number; promptTokens?: number; completionTokens?: number; costCents?: number;
      };
      if (m.sessionKey !== sessionKey) return;
      if (m.type === 'stream:slow') setSlow(true);
      else if (m.type === 'stream:resumed') setSlow(false);
      else if (m.type === 'stream:usage') {
        setUsage({
          calls: m.calls ?? 0,
          tokens: (m.promptTokens ?? 0) + (m.completionTokens ?? 0),
          costCents: m.costCents,
        });
      }
    });
  }, [onMessage, sessionKey]);

  // Il turno cambia ⇒ il conto riparte. Senza, un secondo turno erediterebbe i
  // numeri del primo finché non arriva la sua prima chiamata al modello.
  //
  // Azzerato in RENDER, non in un effect: un effect ridisegnerebbe una volta coi
  // numeri del turno vecchio prima di correggersi — un lampeggio del conteggio a
  // ogni turno nuovo. È il pattern React per "aggiustare lo stato quando cambia
  // una prop": si confronta con l'ultimo valore visto e si riparte subito.
  const [usageTurn, setUsageTurn] = useState(since);
  if (usageTurn !== since) {
    setUsageTurn(since);
    setUsage(null);
  }

  const base = since != null && Number.isFinite(since) ? since : now;
  const elapsed = Math.max(0, now - base);
  // L'attesa dell'umano vince su "lento": se il turno è fermo su una domanda,
  // uno stream che non produce token è la normalità, non un sintomo.
  const state = awaitingInput ? 'waiting' : slow ? 'slow' : 'working';
  const label =
    state === 'waiting'
      ? 'in attesa della tua risposta'
      : state === 'slow'
        ? 'stream lento, il provider è ancora connesso'
        : `${phraseAt(elapsed)}…`;
  return (
    <div
      data-testid="chat-streaming-indicator"
      data-slow={state === 'slow' ? 'true' : undefined}
      data-waiting={state === 'waiting' ? 'true' : undefined}
      className="flex items-center gap-2 mt-1 text-[11px] leading-none select-none"
      role="status"
      aria-live="polite"
      aria-label={
        state === 'waiting'
          ? 'L’assistente aspetta la tua risposta'
          : state === 'slow'
            ? 'Lo stream è lento, il provider è ancora connesso'
            : 'L’assistente sta elaborando'
      }
    >
      {state === 'waiting' ? (
        // Stessa icona della riga del tool in attesa: chi guarda collega le due
        // cose senza doverle leggere.
        <HelpCircle size={11} className="text-amber-500 shrink-0" />
      ) : (
        <span
          className={`turn-activity-dot inline-block w-1.5 h-1.5 rounded-full shrink-0 ${state === 'slow' ? 'bg-amber-500' : 'bg-primary'}`}
        />
      )}
      <span
        // `turn-activity-phrase` è lo shimmer del lavoro in corso: dipinge il
        // testo con un gradiente in `background-clip` e mette il fill a
        // trasparente, quindi qualunque colore Tailwind sopra sparirebbe. Negli
        // stati d'attesa la classe non si mette proprio — così l'ambra si vede
        // e l'animazione non suggerisce un'attività che non c'è.
        className={
          state === 'working'
            ? 'turn-activity-phrase font-medium'
            : 'font-medium text-amber-600 dark:text-amber-400'
        }
        data-testid="turn-phrase"
      >
        {label}
      </span>
      <span className="tabular-nums text-app-text-muted shrink-0" data-testid="turn-timer">· {formatDurationMs(elapsed)}</span>
      {usage && usage.tokens > 0 && (
        <span
          className="tabular-nums text-app-text-muted shrink-0"
          data-testid="turn-usage"
          // `calls` sta nel title e non nella riga: e' il numero che SPIEGA
          // perche' i token letti superano la finestra di contesto (lo stesso
          // prompt riletto N volte), ma la striscia deve restare una riga.
          title={`${usage.calls} chiamat${usage.calls === 1 ? 'a' : 'e'} al modello finora — i token letti comprendono il prompt riletto a ogni chiamata`}
        >
          · {usage.tokens.toLocaleString()} token
          {usage.costCents != null && usage.costCents > 0
            ? ` · ${usage.costCents / 100 >= 1 ? `$${(usage.costCents / 100).toFixed(2)}` : `$${(usage.costCents / 100).toFixed(4)}`}`
            : ''}
        </span>
      )}
    </div>
  );
}
