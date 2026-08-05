/**
 * Il tetto a orologio di un turno — che NON conta il tempo in cui la palla è
 * dell'umano.
 *
 * Il backstop esiste per un turno impazzito: se qualcosa va storto e nessuno
 * chiude lo stream, dopo N minuti si taglia. Ma un agente che fa una domanda e
 * una persona che va a pranzo sono la normalità, non un guasto — e il tetto,
 * che non sapeva distinguerli, ammazzava il turno con la domanda ancora a
 * schermo. Chi tornava trovava «Interrotto: il turno è finito mentre la domanda
 * era ancora a schermo», e la risposta appena scritta non aveva più nessuno a
 * cui arrivare: il pannello restava su «Invio…» (topic:ed2070df, 5 agosto).
 *
 * Qui il tetto si RIARMA finché una domanda è in sospeso. Il tempo dell'agente
 * si conta, quello dell'umano no — è la stessa scelta che fa il cronometro del
 * turno in chat, e quella che il watchdog del provider fa già col suo
 * `pendingAsk → rearm`.
 *
 * Le dipendenze si iniettano (orologio e domanda in sospeso) perché questa
 * regola si prova in millisecondi invece che in minuti.
 */

export interface TurnDeadlineOptions {
  /** Quanto dura il tetto quando nessuno sta aspettando un umano. */
  ms: number;
  /** Ogni quanto ricontrollare mentre una domanda è a schermo. */
  rearmMs?: number;
  /** C'è una domanda in sospeso per questa sessione? */
  isWaitingForHuman: () => boolean;
  /** Scatta solo se il tetto è stato raggiunto SENZA domande in sospeso. */
  onExpired: () => void;
  /** Nota ogni riarmo (log). Opzionale. */
  onRearm?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TurnDeadline {
  clear: () => void;
}

export function armTurnDeadline(opts: TurnDeadlineOptions): TurnDeadline {
  const rearmMs = opts.rearmMs ?? 60_000;
  const set = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (opts.isWaitingForHuman()) {
      opts.onRearm?.();
      handle = set(tick, rearmMs);
      return;
    }
    opts.onExpired();
  };
  handle = set(tick, opts.ms);
  return {
    clear: () => {
      stopped = true;
      clear(handle);
    },
  };
}
