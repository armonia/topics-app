/**
 * @covers THREAD-06
 */
import { describe, expect, test } from "bun:test";
import { isTurnStillLive, shouldConsultBroker } from "./historyCleanupPolicy";

describe("isTurnStillLive — chi decide se il turno è finito", () => {
  test("uno stream in memoria basta: è la strada di sempre", () => {
    expect(isTurnStillLive({ streamInMemory: true, hasPartialRows: true, brokerState: null })).toBe(true);
    expect(isTurnStillLive({ streamInMemory: true, hasPartialRows: false, brokerState: "idle" })).toBe(true);
  });

  test("il caso del guasto: niente in memoria ma il broker dice APERTO", () => {
    // Server appena ripartito ⇒ `activeStreams` vuota. Il figlio però è vivo e
    // fermo su una domanda: un ⌘R qui azzerava `partial`, e da lì il reattach
    // reapava un turno vivissimo.
    expect(isTurnStillLive({ streamInMemory: false, hasPartialRows: true, brokerState: "open" })).toBe(true);
  });

  test("`idle` è una risposta vera: il turno è finito e si pulisce", () => {
    expect(isTurnStillLive({ streamInMemory: false, hasPartialRows: true, brokerState: "idle" })).toBe(false);
  });

  test("`unknown` NON blocca la pulizia: col bridge spento sarebbe per sempre", () => {
    // La regola «unknown non autorizza a uccidere» vale dove il default è
    // uccidere. Qui il default è pulire righe stantie, e un host senza broker
    // risponde `unknown` a ogni domanda: trattarlo come «forse vivo» lascerebbe
    // parziali immortali, cioè il guasto opposto.
    expect(isTurnStillLive({ streamInMemory: false, hasPartialRows: true, brokerState: "unknown" })).toBe(false);
    expect(isTurnStillLive({ streamInMemory: false, hasPartialRows: true, brokerState: null })).toBe(false);
  });
});

describe("shouldConsultBroker — quando vale la pena pagare il giro", () => {
  test("solo se c'è davvero qualcosa da perdere", () => {
    expect(shouldConsultBroker({ streamInMemory: false, hasPartialRows: true })).toBe(true);
  });

  test("niente righe parziali ⇒ niente da pulire ⇒ niente da chiedere", () => {
    // `/api/history` gira a ogni pane che monta e a ogni cambio di tab: un
    // replay muto dello store a vuoto, ogni volta, si paga.
    expect(shouldConsultBroker({ streamInMemory: false, hasPartialRows: false })).toBe(false);
  });

  test("se lo stream è già in memoria la risposta si sa già", () => {
    expect(shouldConsultBroker({ streamInMemory: true, hasPartialRows: true })).toBe(false);
  });
});
