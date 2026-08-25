/**
 * `nextTextDelta` — la normalizzazione cumulativo → delta, e il token ripetuto.
 *
 * Il caso che ha motivato l'estrazione è l'ultimo di questo file: la route di
 * chat trattava il primo argomento di `onTextDelta` come CUMULATIVO e scartava
 * l'evento quando era identico al precedente. Quattro provider su cinque
 * (claude, openai, codex, claude-code) mandano invece il pezzo nuovo, quindi due
 * pezzi uguali di fila — «the the», due `\n`, un `= =` in una tabella — erano
 * uno solo. La perdita era muta: riga salvata e schermo dicevano la stessa cosa
 * sbagliata.
 *
 * Ora la regola vale SOLO per chi è cumulativo davvero (il gateway OpenClaw), e
 * qui si prova che su quel flusso «uguale a prima» significa davvero «niente di
 * nuovo», mentre il flusso a delta non passa più di qui.
  * @covers DELTA-01
 */
import { describe, expect, test } from "bun:test";
import { nextTextDelta } from "./text-delta";

/** Applica una sequenza di eventi cumulativi e ritorna i pezzi consegnati. */
function drive(events: string[]): { deltas: string[]; cumulative: string } {
  let prev = "";
  const deltas: string[] = [];
  for (const e of events) {
    const step = nextTextDelta(prev, e);
    prev = step.cumulative;
    if (step.delta) deltas.push(step.delta);
  }
  return { deltas, cumulative: prev };
}

describe("nextTextDelta", () => {
  test("un flusso cumulativo normale consegna solo la coda", () => {
    const { deltas, cumulative } = drive(["Ciao", "Ciao mo", "Ciao mondo"]);
    expect(deltas).toEqual(["Ciao", " mo", "ndo"]);
    expect(cumulative).toBe("Ciao mondo");
  });

  test("il testo ricomposto dai pezzi è identico all'ultimo cumulato", () => {
    const eventi = ["a", "ab", "abc", "abc", "abcd"];
    const { deltas, cumulative } = drive(eventi);
    expect(deltas.join("")).toBe(cumulative);
    expect(cumulative).toBe("abcd");
  });

  test("cumulato identico al precedente: nessun pezzo nuovo", () => {
    expect(nextTextDelta("abc", "abc")).toEqual({ delta: "", cumulative: "abc" });
  });

  test("primo evento: il cumulato di partenza è vuoto, il pezzo è tutto", () => {
    expect(nextTextDelta("", "primo")).toEqual({ delta: "primo", cumulative: "primo" });
  });

  test("un cumulato che NON estende il precedente riparte intero, non mutilato", () => {
    // Il mittente ha riscritto il messaggio (correzione, replay dopo una
    // riconnessione). Tagliare su un prefisso che non c'è produrrebbe testo
    // monco; ripetere è visibile e recuperabile, perdere no.
    expect(nextTextDelta("Ciao mondo", "Salve mondo"))
      .toEqual({ delta: "Salve mondo", cumulative: "Salve mondo" });
  });

  test("il token ripetuto: su un cumulato sopravvive, applicando la regola ai DELTA sparisce", () => {
    // Lo stesso testo, visto dai due lati. Il gateway lo manda cumulativo:
    // `nextTextDelta` ricostruisce le due occorrenze di "the ".
    const { deltas } = drive(["Ho detto ", "Ho detto the ", "Ho detto the the ", "Ho detto the the cosa?"]);
    expect(deltas.join("")).toBe("Ho detto the the cosa?");

    // Gli altri quattro provider mandano i pezzi. Passarli per questa stessa
    // funzione — che è ciò che la route faceva in linea per TUTTI — cancella la
    // seconda occorrenza, perché su un flusso cumulativo «uguale a prima» vuol
    // dire «niente di nuovo» e su un flusso a delta vuol dire l'opposto.
    // La route ora appende i pezzi senza interpretarli: la prova a quel livello
    // è in tests/integration/chat-stream-abort.test.ts.
    const pezzi = ["Ho detto ", "the ", "the ", "cosa?"];
    expect(drive(pezzi).deltas.join("")).toBe("Ho detto the cosa?");
    expect(pezzi.join("")).toBe("Ho detto the the cosa?");
  });
});
