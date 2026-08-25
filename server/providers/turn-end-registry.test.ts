/**
 * Where a finished turn deposits its reason and the dispatcher withdraws it:
 * one withdrawal per turn, so an old ending is never read as the new one.
 * @covers KANBAN-07
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordTurnEnd,
  resetTurnEndRegistry,
  takeTurnEnd,
  turnEndRegistrySize,
} from "./turn-end-registry";
import { cancelled } from "./stop-reason";

beforeEach(() => resetTurnEndRegistry());

describe("deposita / ritira", () => {
  it("chi ritira ottiene quello che è stato depositato", () => {
    recordTurnEnd("s1", { end: "max_tokens" });
    expect(takeTurnEnd("s1")).toEqual({ end: "max_tokens" });
  });

  it("ritirare CONSUMA: la stessa fine non può essere attribuita a due turni", () => {
    // È il bug che questo lavoro elimina: la ragione di un turno vecchio letta
    // come se fosse quella del turno appena finito.
    recordTurnEnd("s1", cancelled("user"));
    expect(takeTurnEnd("s1")).toBeDefined();
    expect(takeTurnEnd("s1")).toBeUndefined();
  });

  it("una sessione mai vista non inventa niente", () => {
    expect(takeTurnEnd("mai-vista")).toBeUndefined();
  });

  it("il turno nuovo sovrascrive quello vecchio", () => {
    recordTurnEnd("s1", { end: "end_turn" });
    recordTurnEnd("s1", { end: "refusal" });
    expect(takeTurnEnd("s1")?.end).toBe("refusal");
  });

  it("le sessioni non si mescolano", () => {
    recordTurnEnd("a", { end: "end_turn" });
    recordTurnEnd("b", { end: "refusal" });
    expect(takeTurnEnd("a")?.end).toBe("end_turn");
    expect(takeTurnEnd("b")?.end).toBe("refusal");
  });

  it("una sessionKey vuota non deposita niente", () => {
    recordTurnEnd("", { end: "end_turn" });
    expect(turnEndRegistrySize()).toBe(0);
  });
});

describe("tetto ai residui", () => {
  it("non cresce all'infinito: sfratta le sessioni più vecchie", () => {
    for (let i = 0; i < 500; i++) recordTurnEnd(`s${i}`, { end: "end_turn" });
    expect(turnEndRegistrySize()).toBeLessThanOrEqual(200);
    // La più vecchia è sparita, le ultime ci sono ancora.
    expect(takeTurnEnd("s0")).toBeUndefined();
    expect(takeTurnEnd("s499")).toBeDefined();
  });

  it("scrivere di nuovo su una sessione la salva dallo sfratto", () => {
    recordTurnEnd("vip", { end: "end_turn" });
    for (let i = 0; i < 150; i++) recordTurnEnd(`s${i}`, { end: "end_turn" });
    recordTurnEnd("vip", { end: "refusal" }); // rimessa in coda
    // Altre 100: sfrattano le più vecchie fra le s*, non "vip" che è appena
    // stata riscritta. Con l'ordine di inserimento nudo sarebbe già sparita.
    for (let i = 150; i < 250; i++) recordTurnEnd(`s${i}`, { end: "end_turn" });
    expect(takeTurnEnd("s0")).toBeUndefined();
    expect(takeTurnEnd("vip")?.end).toBe("refusal");
  });
});
