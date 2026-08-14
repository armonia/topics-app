import { describe, expect, test } from "bun:test";
import {
  CACHE_READ_WEIGHT,
  contextTokens,
  costTokens,
  partsFromMessage,
  partsFromTask,
} from "./token-cost";

describe("una sola definizione di token", () => {
  test("il COSTO pesa la rilettura un decimo, il CONTESTO la pesa uno", () => {
    const parts = { billable: 10_000, cacheRead: 1_000_000 };
    expect(costTokens(parts)).toBe(110_000);
    expect(contextTokens(parts)).toBe(1_010_000);
  });

  test("il peso è dichiarato, non sparso: 0,1", () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    expect(costTokens({ billable: 0, cacheRead: 100 })).toBe(10);
  });

  test("una riga di MESSAGGIO: il prompt contiene già la rilettura, quindi si sottrae", () => {
    // 200k di prompt di cui 180k riletti + 5k di output: fatturabili 25k.
    const parts = partsFromMessage({
      usagePromptTokens: 200_000,
      usageCompletionTokens: 5_000,
      cacheReadTokens: 180_000,
    });
    expect(parts).toEqual({ billable: 25_000, cacheRead: 180_000 });
    expect(costTokens(parts)).toBe(43_000);
  });

  test("una riga di TASK: le parti sono già separate", () => {
    const parts = partsFromTask({ agentTokens: 25_000, agentCacheReadTokens: 180_000 });
    expect(parts).toEqual({ billable: 25_000, cacheRead: 180_000 });
    expect(costTokens(parts)).toBe(43_000);
  });

  test("LE DUE TABELLE DANNO LO STESSO NUMERO per lo stesso consumo", () => {
    // È la tesi della card: due scomposizioni diverse, una definizione sola.
    // Se questa uguaglianza si rompe, sono tornati due numeri.
    const daMessaggio = partsFromMessage({ usagePromptTokens: 200_000, usageCompletionTokens: 5_000, cacheReadTokens: 180_000 });
    const daTask = partsFromTask({ agentTokens: 25_000, agentCacheReadTokens: 180_000 });
    expect(costTokens(daMessaggio)).toBe(costTokens(daTask));
    expect(contextTokens(daMessaggio)).toBe(contextTokens(daTask));
  });

  test("una riga vecchia con la rilettura più grande del prompt non produce uno sconto", () => {
    const parts = partsFromMessage({ usagePromptTokens: 100, usageCompletionTokens: 10, cacheReadTokens: 5_000 });
    expect(parts.billable).toBe(10);       // niente numeri negativi
    expect(costTokens(parts)).toBe(510);
  });

  test("assente, nullo o NaN vale zero, e non NaN", () => {
    expect(costTokens(null)).toBe(0);
    expect(costTokens({})).toBe(0);
    expect(costTokens({ billable: Number.NaN, cacheRead: 10 })).toBe(1);
    expect(contextTokens(undefined)).toBe(0);
    expect(partsFromMessage({})).toEqual({ billable: 0, cacheRead: 0 });
  });
});
