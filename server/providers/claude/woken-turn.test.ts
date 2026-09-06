/**
 * La regola che riconosce un turno aperto DA SOLA dalla CLI.
 *
 * Sta qui e non dentro il test del provider perché è una decisione pura: si
 * prova senza montare un finto processo, e sono le tre esclusioni a valerne la
 * pena. La prima è ovvia, la seconda è quella che si dimentica, la terza è
 * quella che romperebbe il riavvio del server scrivendo in chat la risposta di
 * un turno di ieri.
 * @covers MONITOR-02
 */

import { describe, expect, test } from "bun:test";
import { isWokenTurnLine } from "./woken-turn";

/** Il caso base: la CLI ha ricominciato a parlare e nessuno ascolta. */
const risveglio = {
  hasHandler: false,
  replayMute: false,
  replaySilent: false,
  kind: "content" as const,
};

describe("isWokenTurnLine", () => {
  test("contenuto + nessuno in ascolto = un turno che nessuno ha chiesto", () => {
    expect(isWokenTurnLine(risveglio)).toBe(true);
  });

  test("i pezzi in streaming contano quanto i blocchi interi", () => {
    // Con `--include-partial-messages` il primo segno di vita di un turno può
    // essere un `stream_event`, non un `assistant`: escluderlo vorrebbe dire
    // svegliarsi in ritardo di qualche centinaio di millisecondi, con i primi
    // pezzi già caduti.
    expect(isWokenTurnLine({ ...risveglio, kind: "partial" })).toBe(true);
  });

  test("con un handler vivo è un turno normale, non un risveglio", () => {
    expect(isWokenTurnLine({ ...risveglio, hasHandler: true })).toBe(false);
  });

  test("durante una riadozione NON si sveglia niente", () => {
    // La guardia che conta. `reattach` rilegge lo store del broker, che contiene
    // turni già finiti: senza queste due esclusioni ogni riavvio del server
    // riscriverebbe in chat la risposta di un turno vecchio.
    expect(isWokenTurnLine({ ...risveglio, replayMute: true })).toBe(false);
    expect(isWokenTurnLine({ ...risveglio, replaySilent: true })).toBe(false);
  });

  test("un `result` non apre niente: chiude, e senza handler non c'è nulla da chiudere", () => {
    expect(isWokenTurnLine({ ...risveglio, kind: "result" })).toBe(false);
  });

  test("rumore e compattazione non sono il modello che parla", () => {
    expect(isWokenTurnLine({ ...risveglio, kind: "noise" })).toBe(false);
    expect(isWokenTurnLine({ ...risveglio, kind: "compaction" })).toBe(false);
    expect(isWokenTurnLine({ ...risveglio, kind: "unknown" })).toBe(false);
    // A rate-limit ping is the plan talking about itself, not the model
    // working: waking a turn on it would resurrect a session nobody prompted.
    expect(isWokenTurnLine({ ...risveglio, kind: "rate_limit" })).toBe(false);
  });
});
