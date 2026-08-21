/**
 * A turn's INACTIVITY cap: it fires on silence, not on duration, and it does not
 * count the time the ball is in a person's court.
 *
 * IT USED TO BE A WALL-CLOCK CAP, and it cut healthy turns. Measured on
 * 2026-08-21 against the live DB: 60 comments reading "Turno tagliato dal limite
 * di tempo", the most recent at 00:37 that same night. An agent turn that is
 * really working (twenty tools, a long test, a build) passes 20 minutes without
 * being broken, and it was being killed halfway: the work was lost and the card
 * went back with the job half done. The card that forbade this (`29451376`) was
 * closed on 2025-07-19 without a line being written; this is that work.
 *
 * The provider one level down already knew the right rule:
 * `claude-code.ts:1515` says "an INACTIVITY backstop, NOT a wall-clock cap".
 * The dispatcher stacked a second, dumber cap on top, and that was the one doing
 * the cutting. Now the two measure the same thing.
 *
 * The liveness signal is neither new nor expensive: the SSE stream
 * `runHeadlessTurn` already drains to learn WHEN the turn ends also says THAT it
 * is still going. It only had to be looked at.
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
  /** The clock. Injectable because this rule is tested in milliseconds. */
  now?: () => number;
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
  /**
   * THE TURN SHOWED A SIGN OF LIFE. Call it for every chunk arriving on the
   * stream: it pushes forward the moment the cap is allowed to fire.
   *
   * It costs one assignment, not a new timer: there is still a single timer and,
   * when it fires, it looks at how long the silence has been instead of at the
   * absolute clock. A busy stream calls this thousands of times, so it has to be
   * free.
   */
  noteActivity: () => void;
}

export function armTurnDeadline(opts: TurnDeadlineOptions): TurnDeadline {
  const rearmMs = opts.rearmMs ?? 60_000;
  const set = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown;
  let stopped = false;
  const now = opts.now ?? (() => Date.now());
  let lastActivityAt = now();
  const tick = () => {
    if (stopped) return;
    if (opts.isWaitingForHuman()) {
      opts.onRearm?.();
      handle = set(tick, rearmMs);
      return;
    }
    // HOW LONG THE SILENCE HAS BEEN, not how long ago the turn started. That is
    // the difference between "this turn is taking too long" and "this turn is
    // stuck", and only the second one is a fault. See the file header.
    const silenzio = now() - lastActivityAt;
    if (silenzio < opts.ms) {
      handle = set(tick, opts.ms - silenzio);
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
    noteActivity: () => { lastActivityAt = now(); },
  };
}
