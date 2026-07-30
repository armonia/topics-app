/**
 * L'accumulo del consumo di un turno.
 *
 * Prima viveva inline dentro l'handler in `routes/chat.ts`, dove nessun test
 * poteva arrivarci: un segno sbagliato, una quota dimenticata o una somma doppia
 * si sarebbero visti solo come un numero storto nella UI, e solo se qualcuno
 * fosse stato a guardare mentre un turno girava.
 */
import { describe, expect, test } from "bun:test";
import {
  accumulateTurnUsage,
  emptyTurnUsage,
  turnUsageCostParts,
  type CallUsage,
} from "./turn-usage";

const call = (o: Partial<CallUsage> = {}): CallUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation1h: 0,
  ...o,
});

describe("accumulateTurnUsage", () => {
  test("il totale vuoto è tutto a zero, chiamate comprese", () => {
    const u = emptyTurnUsage();
    expect(u).toEqual({ calls: 0, prompt: 0, completion: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 });
  });

  test("somma chiamata per chiamata, e conta le chiamate", () => {
    let u = emptyTurnUsage();
    u = accumulateTurnUsage(u, call({ inputTokens: 1000, outputTokens: 50, cacheRead: 800 }));
    u = accumulateTurnUsage(u, call({ inputTokens: 1200, outputTokens: 30, cacheRead: 1100 }));
    expect(u.calls).toBe(2);
    expect(u.prompt).toBe(2200);
    expect(u.completion).toBe(80);
    expect(u.cacheRead).toBe(1900);
  });

  test("NON muta l'accumulatore precedente", () => {
    // L'accumulatore attraversa un handler asincrono chiamato da un parser di
    // stream: una mutazione condivisa è il modo in cui due turni sulla stessa
    // sessione finirebbero per sommarsi a vicenda.
    const prev = emptyTurnUsage();
    const next = accumulateTurnUsage(prev, call({ inputTokens: 10 }));
    expect(prev.prompt).toBe(0);
    expect(prev.calls).toBe(0);
    expect(next).not.toBe(prev);
  });

  test("un NaN dal provider non avvelena il totale per il resto del turno", () => {
    // `prompt_tokens: null` che passa da Number() dà NaN, e qui si SOMMA: un solo
    // valore sporco renderebbe NaN ogni numero successivo.
    let u = emptyTurnUsage();
    u = accumulateTurnUsage(u, call({ inputTokens: 1000 }));
    u = accumulateTurnUsage(u, call({ inputTokens: Number.NaN, outputTokens: 5 }));
    u = accumulateTurnUsage(u, call({ inputTokens: 500 }));
    expect(u.prompt).toBe(1500);
    expect(u.completion).toBe(5);
    expect(Number.isFinite(u.prompt)).toBe(true);
  });

  test("Infinity e i negativi valgono zero", () => {
    let u = emptyTurnUsage();
    u = accumulateTurnUsage(u, call({ inputTokens: Number.POSITIVE_INFINITY, cacheRead: -100 }));
    expect(u.prompt).toBe(0);
    expect(u.cacheRead).toBe(0);
    // La chiamata però è avvenuta, e va contata: il conteggio delle chiamate non
    // dipende dalla qualità dei numeri.
    expect(u.calls).toBe(1);
  });
});

describe("turnUsageCostParts — lo scorporo per il prezzo", () => {
  test("il fresco è il RESTO e le quattro parti sommano al prompt", () => {
    const u = { calls: 1, prompt: 1000, completion: 20, cacheRead: 700, cacheCreation: 200, cacheCreation1h: 50 };
    const p = turnUsageCostParts(u);
    expect(p.fresh).toBe(100);
    expect(p.cacheRead + p.cacheCreation5m + p.cacheCreation1h + p.fresh).toBe(1000);
  });

  test("write1h è una QUOTA di write, non un'aggiunta", () => {
    const u = { calls: 1, prompt: 100, completion: 0, cacheRead: 0, cacheCreation: 40, cacheCreation1h: 10 };
    const p = turnUsageCostParts(u);
    // 40 di scrittura totale: 10 a un'ora, 30 a cinque minuti. Non 50.
    expect(p.cacheCreation1h).toBe(10);
    expect(p.cacheCreation5m).toBe(30);
  });

  test("un 1h maggiore delle scritture totali non produce un negativo", () => {
    // Capita per arrotondamenti fra chiamate. Un negativo qui farebbe pagare una
    // tariffa a un numero inventato.
    const u = { calls: 1, prompt: 100, completion: 0, cacheRead: 0, cacheCreation: 20, cacheCreation1h: 50 };
    const p = turnUsageCostParts(u);
    expect(p.cacheCreation1h).toBe(20);
    expect(p.cacheCreation5m).toBe(0);
  });

  test("il fresco non va sotto zero se le quote superano il prompt", () => {
    const u = { calls: 1, prompt: 100, completion: 0, cacheRead: 90, cacheCreation: 40, cacheCreation1h: 0 };
    expect(turnUsageCostParts(u).fresh).toBe(0);
  });

  test("il caso reale: quasi tutto è rilettura, il fresco è una briciola", () => {
    const u = { calls: 8, prompt: 2_000_000, completion: 4_000, cacheRead: 1_950_000, cacheCreation: 45_000, cacheCreation1h: 5_000 };
    const p = turnUsageCostParts(u);
    expect(p.fresh).toBe(5_000);
    expect(p.cacheRead).toBe(1_950_000);
    expect(p.output).toBe(4_000);
  });
});
