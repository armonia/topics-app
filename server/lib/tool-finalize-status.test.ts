/**
 * Un tool mai eseguito non ha la spunta verde.
 *
 * Il caso che ha motivato il modulo: 2026-08-28, topic:4c935add, tre volte su
 * tre. Il modello scriveva un documento dentro l'argomento di un `write_file`,
 * ha sfondato il tetto di output a meta' del JSON, e il giro e' uscito prima di
 * eseguire i tool. `reason` era `done`, quindi la riga di prima chiudeva tutto
 * come riuscito: nel log `Tool start: write_file` e ZERO `Tool result`, su disco
 * nessun file, e a schermo una spunta verde.
 * @covers CHAT-01
 */
import { describe, test, expect } from "bun:test";
import { toolOutcomeAtTurnEnd } from "./tool-finalize-status";

describe("come si chiudono i tool appesi", () => {
  test("un turno finito davvero lascia i tool riusciti", () => {
    expect(toolOutcomeAtTurnEnd("done", { end: "end_turn" })).toEqual({ status: "success" });
  });

  test("IL CASO: tagliato dal tetto di output -> errore, non successo", () => {
    const e = toolOutcomeAtTurnEnd("done", { end: "max_tokens" });
    expect(e.status).toBe("error");
    // La frase deve dire DOVE si e' rotto, non solo che si e' rotto: il tool non
    // e' fallito eseguendo, non e' proprio mai partito.
    expect(e.error).toContain("limite di lunghezza");
  });

  test("lo stop dell'utente resta suo, e si vede", () => {
    expect(toolOutcomeAtTurnEnd("aborted", { end: "end_turn" })).toEqual({
      status: "error",
      error: "Aborted by user",
    });
  });

  test("un errore di stream porta con se' il suo messaggio", () => {
    expect(toolOutcomeAtTurnEnd("error", undefined, "socket hung up")).toEqual({
      status: "error",
      error: "socket hung up",
    });
  });

  test("senza turnEnd il turno finito resta un successo: non si inventa un guasto", () => {
    // `turnEnd` manca quando a finalizzare e' un timer nostro. Li' la ragione la
    // conosce il chiamante e la passa a parte: dedurre «tagliato» da un campo
    // assente trasformerebbe ogni watchdog in un falso taglio.
    expect(toolOutcomeAtTurnEnd("done", undefined)).toEqual({ status: "success" });
  });
});
