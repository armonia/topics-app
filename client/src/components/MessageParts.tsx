import { useEffect, useState } from 'react';
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
}: {
  since?: number;
  /** Serve solo per lo stato "lento": senza, l'indicatore resta quello normale. */
  sessionKey?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
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
  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage((msg: WSMessage) => {
      const m = msg as { type?: string; sessionKey?: string };
      if (m.sessionKey !== sessionKey) return;
      if (m.type === 'stream:slow') setSlow(true);
      else if (m.type === 'stream:resumed') setSlow(false);
    });
  }, [onMessage, sessionKey]);

  const base = since != null && Number.isFinite(since) ? since : now;
  const elapsed = Math.max(0, now - base);
  return (
    <div
      data-testid="chat-streaming-indicator"
      data-slow={slow ? 'true' : undefined}
      className="flex items-center gap-2 mt-1 text-[11px] leading-none select-none"
      role="status"
      aria-live="polite"
      aria-label={slow ? 'Lo stream è lento, il provider è ancora connesso' : 'L’assistente sta elaborando'}
    >
      <span
        className={`turn-activity-dot inline-block w-1.5 h-1.5 rounded-full shrink-0 ${slow ? 'bg-amber-500' : 'bg-primary'}`}
      />
      <span
        className={`turn-activity-phrase font-medium ${slow ? 'text-amber-500' : ''}`}
        data-testid="turn-phrase"
      >
        {slow ? 'stream lento, il provider è ancora connesso' : `${phraseAt(elapsed)}…`}
      </span>
      <span className="tabular-nums text-app-text-muted shrink-0" data-testid="turn-timer">· {formatDurationMs(elapsed)}</span>
    </div>
  );
}
