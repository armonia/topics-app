import { describe, expect, test } from "bun:test";
import { turnWatchdogDecision } from "./claude-code";

/**
 * The turn watchdog kills a turn that has gone SILENT, on the assumption that
 * silence means a wedged CLI child. A pending `mcp__topics__ask_user_question`
 * breaks that assumption: the child is blocked on the bridge's JSON-RPC
 * response and streams nothing until the human clicks the panel, so the idle
 * clock is measuring how long the HUMAN took. These cases pin the difference.
 * @covers CHAT-REL-03
 */

const WINDOW = 30 * 60 * 1000;

describe("turnWatchdogDecision", () => {
  test("silenzio oltre la finestra e nessuna domanda in volo: il turno muore", () => {
    expect(turnWatchdogDecision({ pendingAsk: false, idleMs: WINDOW, windowMs: WINDOW }))
      .toEqual({ action: "reject" });
    expect(turnWatchdogDecision({ pendingAsk: false, idleMs: WINDOW + 1, windowMs: WINDOW }))
      .toEqual({ action: "reject" });
  });

  test("silenzio dentro la finestra: riarma per il tempo che resta, non per uno intero", () => {
    // Self-rescheduling is what makes the watchdog measure CONTINUOUS silence:
    // an event that landed 10 min ago must leave exactly 20 min on the clock.
    expect(turnWatchdogDecision({ pendingAsk: false, idleMs: 10 * 60 * 1000, windowMs: WINDOW }))
      .toEqual({ action: "rearm", delayMs: 20 * 60 * 1000 });
  });

  test("domanda in volo: NON muore, per quanto lungo sia il silenzio", () => {
    // Il caso vero: la domanda compare alle 12:55 e la risposta arriva dopo
    // pranzo. Senza questa regola il watchdog uccideva un turno sanissimo col
    // pannello ancora a schermo.
    const twoHoursIdle = 2 * 60 * 60 * 1000;
    expect(turnWatchdogDecision({ pendingAsk: true, idleMs: twoHoursIdle, windowMs: WINDOW }))
      .toEqual({ action: "rearm", delayMs: WINDOW });
  });

  test("risposto: il silenzio ricomincia a contare da subito", () => {
    // `deliverAnswer` toglie il waiter, quindi al primo giro dopo la risposta
    // `pendingAsk` è falso e la stessa attesa che prima era esente ora conta.
    const idle = WINDOW + 1;
    expect(turnWatchdogDecision({ pendingAsk: true, idleMs: idle, windowMs: WINDOW }).action)
      .toBe("rearm");
    expect(turnWatchdogDecision({ pendingAsk: false, idleMs: idle, windowMs: WINDOW }).action)
      .toBe("reject");
  });
});
