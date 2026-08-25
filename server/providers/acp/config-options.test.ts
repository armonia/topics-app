/**
 * IL PATTO DEL DEGRADO SUL MODELLO PER TASK.
 *
 * `board_model` scrive `task.model` a mano, e il classificatore automatico ne
 * sceglie uno per ogni card. Un nome sbagliato — un refuso, un modello ritirato
 * dal catalogo — deve costare un turno sul modello di DEFAULT, non una card
 * ferma: e' la differenza fra una spesa e un blocco.
 *
 * ── Perche' la guardia sta PRIMA della chiamata ─────────────────────────────
 * Misurato il 2026-08-18 contro jcode vero: `session/set_model` ACCETTA un nome
 * inesistente senza protestare. Il rifiuto arriva dopo, dal vero endpoint della
 * chat, a turno gia' partito:
 *
 *   OpenAI-compatible chat request failed
 *     model: modello-che-non-esiste-42
 *     status: 404 Not Found
 *
 * A quel punto il turno e' morto e `applyModel` non e' piu' in gioco: il suo
 * `catch` non vede niente, perche' l'errore non e' suo. L'unica cosa che
 * sappiamo prima di provarci e' il catalogo che l'agente ha dichiarato nei suoi
 * `configOptions`, ed e' li' che la domanda si fa.
 *
 * Il test vivo contro il binario e' `acp-jcode-model.integration.test.ts` («un
 * modello inesistente non fa fallire il turno»), che si salta dove `jcode` non
 * e' installato. Questi casi sono la stessa regola senza binario.
 * @covers KANBAN-07
 */
import { describe, it, expect } from "bun:test";
import { modelIsKnown, parseModelOptions, currentModelFrom } from "./config-options";

const CATALOGO = ["claude-opus-5", "claude-haiku-4-5", "gpt-5"];

describe("modelIsKnown", () => {
  it("un modello del catalogo si applica", () => {
    expect(modelIsKnown("claude-haiku-4-5", CATALOGO)).toBe(true);
  });

  it("un modello che il catalogo non elenca NON si applica", () => {
    expect(modelIsKnown("modello-che-non-esiste-42", CATALOGO)).toBe(false);
  });

  it("il confronto e' esatto: un prefisso non basta", () => {
    // `claude-opus` non e' `claude-opus-5`. Accettare i prefissi vorrebbe dire
    // mandare all'agente un nome che lui non ha, cioe' il difetto di partenza.
    expect(modelIsKnown("claude-opus", CATALOGO)).toBe(false);
    expect(modelIsKnown("claude-opus-5", CATALOGO)).toBe(true);
  });

  it("SENZA catalogo si prova: non sapere non e' un no", () => {
    // Un agente che non ha ancora dichiarato i suoi `configOptions` non ha
    // detto «quel modello non esiste»: ha detto niente. Rifiutare qui vorrebbe
    // dire non applicare MAI il modello per task su quegli agenti — cioe'
    // spegnere una leva di costo per prudenza.
    expect(modelIsKnown("qualunque", null)).toBe(true);
    expect(modelIsKnown("qualunque", undefined)).toBe(true);
    expect(modelIsKnown("qualunque", [])).toBe(true);
  });
});

describe("la lettura dei configOptions", () => {
  const RES = {
    configOptions: [
      { id: "model", currentValue: "claude-opus-5", options: [
        { value: "claude-opus-5" }, { value: "claude-haiku-4-5" },
      ] },
      { id: "effort", currentValue: "high" },
    ],
  };

  it("il catalogo esce dai nomi dichiarati", () => {
    expect(parseModelOptions(RES)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("il modello attivo e' quello che l'agente DICHIARA, non quello chiesto", () => {
    expect(currentModelFrom(RES)).toBe("claude-opus-5");
  });

  it("una risposta senza configOptions non inventa un catalogo", () => {
    // `null` e' «non lo so», ed e' cio' che fa passare `modelIsKnown`: i due
    // pezzi si tengono, e leggere `[]` qui spegnerebbe la leva per sempre.
    expect(parseModelOptions({})).toBeNull();
    expect(parseModelOptions(undefined)).toBeNull();
    expect(currentModelFrom({})).toBeNull();
  });
});
