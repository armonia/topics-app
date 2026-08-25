/**
 * @covers HOLD-03
 */
import { describe, expect, test } from "bun:test";
import { createHumanWaitLedger } from "./human-wait";

describe("createHumanWaitLedger", () => {
  test("turno senza domande: niente da sottrarre", () => {
    const l = createHumanWaitLedger();
    expect(l.totalMs()).toBe(0);
    expect(l.isWaiting()).toBe(false);
  });

  test("un'attesa aperta e chiusa vale il suo pezzo", () => {
    const l = createHumanWaitLedger();
    l.open("t1", 1_000);
    expect(l.isWaiting()).toBe(true);
    l.close("t1", 601_000);
    expect(l.totalMs()).toBe(600_000);
    expect(l.isWaiting()).toBe(false);
  });

  test("più domande nello stesso turno si sommano", () => {
    const l = createHumanWaitLedger();
    l.open("t1", 0);
    l.close("t1", 10_000);
    l.open("t2", 50_000);
    l.close("t2", 80_000);
    expect(l.totalMs()).toBe(40_000);
  });

  test("attese sovrapposte contano il tempo di ciascuna", () => {
    // Due tool che chiedono insieme è raro ma possibile; qui non si prova a
    // fondere gli intervalli — ogni attesa è il tempo di QUEL tool.
    const l = createHumanWaitLedger();
    l.open("t1", 0);
    l.open("t2", 5_000);
    l.close("t1", 10_000);
    l.close("t2", 10_000);
    expect(l.totalMs()).toBe(15_000);
  });

  test("riaprire un'attesa già aperta non ne perde l'inizio", () => {
    const l = createHumanWaitLedger();
    l.open("t1", 0);
    l.open("t1", 9_000);
    l.close("t1", 10_000);
    expect(l.totalMs()).toBe(10_000);
  });

  test("chiudere un'attesa mai aperta non inventa tempo", () => {
    const l = createHumanWaitLedger();
    l.close("mai-vista", 10_000);
    expect(l.totalMs()).toBe(0);
  });

  test("chiudere due volte non conta due volte", () => {
    const l = createHumanWaitLedger();
    l.open("t1", 0);
    l.close("t1", 10_000);
    l.close("t1", 99_000);
    expect(l.totalMs()).toBe(10_000);
  });

  test("il turno finisce con la domanda ancora aperta: closeAll la chiude", () => {
    // Succede a ogni «ferma» premuto mentre la domanda è a schermo.
    const l = createHumanWaitLedger();
    l.open("t1", 0);
    l.open("t2", 1_000);
    l.closeAll(11_000);
    expect(l.totalMs()).toBe(21_000);
    expect(l.isWaiting()).toBe(false);
    l.closeAll(99_000);
    expect(l.totalMs()).toBe(21_000);
  });

  test("orologio all'indietro ⇒ zero, mai un pezzo negativo", () => {
    const l = createHumanWaitLedger();
    l.open("t1", 10_000);
    l.close("t1", 9_000);
    expect(l.totalMs()).toBe(0);
  });
});
