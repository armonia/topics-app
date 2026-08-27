/**
 * Why a turn ended, in the vocabulary the board dispatcher acts on: which
 * endings consume an attempt, which ones resume, and which ones need a human.
 * @covers KANBAN-07
 */
import { describe, it, expect } from "bun:test";
import {
  ACP_STOP_REASONS,
  cancelled,
  classifyResultEvent,
  classifyTurnError,
  consumesAttempt,
  describeTurnEnd,
  isAcpStopReason,
  needsHuman,
  shouldResume,
} from "./stop-reason";

describe("vocabolario ACP", () => {
  it("sono esattamente le cinque ragioni di ACP", () => {
    expect([...ACP_STOP_REASONS]).toEqual([
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]);
  });

  it("`error` NON è una ragione ACP — non deve finire su un filo che parla ACP", () => {
    expect(isAcpStopReason("error")).toBe(false);
    expect(isAcpStopReason("end_turn")).toBe(true);
    expect(isAcpStopReason("")).toBe(false);
    expect(isAcpStopReason(undefined)).toBe(false);
  });
});

describe("classifyResultEvent — l'evento finale della CLI", () => {
  it("success = l'agente ha finito il suo turno", () => {
    expect(classifyResultEvent({ subtype: "success", result: "fatto" }).end).toBe("end_turn");
  });

  it("un result senza subtype né errore è comunque una fine normale", () => {
    expect(classifyResultEvent({ result: "ok" }).end).toBe("end_turn");
  });

  it("error_max_turns = tetto di richieste al modello", () => {
    expect(classifyResultEvent({ subtype: "error_max_turns", is_error: true }).end)
      .toBe("max_turn_requests");
  });

  it("contesto pieno, con le parole che usano davvero", () => {
    for (const text of [
      "prompt is too long",
      "context length exceeded for this model",
      "input length and `max_tokens` exceed context limit",
      "maximum tokens reached",
    ]) {
      expect(classifyResultEvent({ subtype: "error_during_execution", is_error: true, errors: [text] }).end)
        .toBe("max_tokens");
    }
  });

  it("un rifiuto del modello è riconosciuto", () => {
    expect(classifyResultEvent({ is_error: true, errors: ["stop_reason: refusal"] }).end).toBe("refusal");
    expect(classifyResultEvent({ subtype: "error_during_execution", is_error: true, errors: ["the model refused to continue"] }).end)
      .toBe("refusal");
  });

  it("il contesto pieno vince sul rifiuto quando il testo contiene entrambi", () => {
    // Un messaggio di limite token può spiegare "…so the request was refused";
    // mai il contrario. Sbagliare verso `refusal` parcheggerebbe un task che si
    // sarebbe ripreso da solo.
    const info = classifyResultEvent({
      is_error: true,
      errors: ["prompt is too long, request refused"],
    });
    expect(info.end).toBe("max_tokens");
  });

  it("tutto il resto degli errori è un guasto, non uno stop", () => {
    const info = classifyResultEvent({ subtype: "error_during_execution", is_error: true, errors: ["ECONNRESET"] });
    expect(info.end).toBe("error");
    expect(info.cause).toBe("provider-error");
    expect(info.detail).toContain("ECONNRESET");
  });

  it("is_error senza subtype d'errore basta a marcare l'errore", () => {
    expect(classifyResultEvent({ subtype: "success", is_error: true, errors: ["boom"] }).end).toBe("error");
  });
});

describe("classifyTurnError — la promise del turno morta", () => {
  it("il tetto a orologio del dispatcher", () => {
    const info = classifyTurnError(new Error("turn exceeded wall-clock timeout"));
    expect(info.end).toBe("cancelled");
    expect(info.cause).toBe("wall-clock");
  });

  it("ABORTED = qualcuno ha premuto stop; la causa la porta il chiamante", () => {
    expect(classifyTurnError(new Error("ABORTED")).cause).toBe("user");
    expect(classifyTurnError(new Error("ABORTED"), "watchdog").cause).toBe("watchdog");
    expect(classifyTurnError(new Error("ABORTED"), "watchdog").end).toBe("cancelled");
  });

  it("SESSION_RESET è una ripartenza, non un fallimento", () => {
    const info = classifyTurnError(new Error("SESSION_RESET"));
    expect(info.end).toBe("cancelled");
    expect(info.cause).toBe("session-reset");
  });

  it("PROCESS_DIED_n è un guasto", () => {
    const info = classifyTurnError(new Error("PROCESS_DIED_137"));
    expect(info.end).toBe("error");
    expect(info.cause).toBe("process-died");
  });

  it("legge anche i limiti annunciati nel testo dell'errore", () => {
    expect(classifyTurnError(new Error("prompt is too long")).end).toBe("max_tokens");
    expect(classifyTurnError(new Error("max turns exceeded")).end).toBe("max_turn_requests");
  });

  it("un errore sconosciuto resta un errore, con la causa che gli passa il chiamante", () => {
    const info = classifyTurnError("boh", "provider-error");
    expect(info.end).toBe("error");
    expect(info.cause).toBe("provider-error");
  });
});

describe("politica del dispatcher", () => {
  it("max_tokens si riprende — il contesto pieno non è un fallimento", () => {
    const info = { end: "max_tokens" } as const;
    expect(shouldResume(info)).toBe(true);
    expect(needsHuman(info)).toBe(false);
  });

  it("refusal è l'unico che ferma tutto e chiama l'umano", () => {
    const info = { end: "refusal" } as const;
    expect(shouldResume(info)).toBe(false);
    expect(needsHuman(info)).toBe(true);
    for (const end of ["end_turn", "max_tokens", "max_turn_requests", "cancelled", "error"] as const) {
      expect(needsHuman({ end })).toBe(false);
      expect(shouldResume({ end })).toBe(true);
    }
  });

  it("uno stop premuto dall'umano non costa un tentativo", () => {
    expect(consumesAttempt(cancelled("user"))).toBe(false);
  });

  it("…ma il nostro tetto a orologio SÌ, o il freno non frenerebbe mai", () => {
    expect(consumesAttempt(cancelled("wall-clock"))).toBe(true);
    expect(consumesAttempt(cancelled("watchdog"))).toBe(true);
  });

  it("una sessione persa e riavviata è lo stesso turno: non costa", () => {
    expect(consumesAttempt(cancelled("session-reset"))).toBe(false);
  });

  // Il 409 `stream_in_flight` della front-door significa «la sessione sta già
  // rispondendo», non «il provider è guasto». Finché veniva mappato su
  // `provider-error` bruciava un tentativo, e con un tetto basso bastava
  // arrivare mentre l'agente parlava per far parcheggiare il task come FAILED.
  it("un turno respinto perché ce n'era già uno in volo non costa: non abbiamo guidato niente", () => {
    expect(consumesAttempt(cancelled("turn-in-flight"))).toBe(false);
  });

  it("tutto ciò che non è cancelled costa un tentativo", () => {
    for (const end of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "error"] as const) {
      expect(consumesAttempt({ end })).toBe(true);
    }
  });

  // The passive stall detector's recycle cause: a confirmed "stuck" judge
  // verdict, never a bare timer. It must resume the same session (same
  // contract as wall-clock/watchdog) and count as an attempt.
  it("un turno riciclato dallo stall detector si riprende e costa un tentativo", () => {
    expect(shouldResume(cancelled("stall"))).toBe(true);
    expect(consumesAttempt(cancelled("stall"))).toBe(true);
  });
});

describe("describeTurnEnd — la riga che sostituisce «probabile timeout»", () => {
  it("dice la causa, non una supposizione", () => {
    expect(describeTurnEnd(cancelled("wall-clock"))).toBe("Turno fermo: nessun segno di vita fino allo scadere");
    expect(describeTurnEnd(cancelled("user"))).toBe("Turno fermato a mano");
    expect(describeTurnEnd({ end: "max_tokens" })).toContain("Contesto pieno");
    expect(describeTurnEnd({ end: "refusal" })).toContain("rifiutato");
  });

  it("nessuna fine resta senza descrizione", () => {
    for (const end of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"] as const) {
      expect(describeTurnEnd({ end }).length).toBeGreaterThan(0);
    }
  });

  it("un riciclo dello stall detector si distingue da un taglio a orologio", () => {
    const stallText = describeTurnEnd(cancelled("stall"));
    expect(stallText.length).toBeGreaterThan(0);
    expect(stallText).not.toBe(describeTurnEnd(cancelled("wall-clock")));
  });
});
