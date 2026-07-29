/**
 * Il denominatore del ring. Le proprietà che contano:
 *  • un nome di modello vero (con data e suffissi) trova la sua finestra;
 *  • un modello sconosciuto non mente: cade sul default e lo dichiara;
 *  • le soglie sono UNA sola scala, condivisa fra colore e preavviso.
 */
import { describe, it, expect } from "bun:test";
import {
  contextWindowFor,
  windowModelFor,
  classifyContext,
  contextLevel,
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_WARN_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
} from "./context-window";

describe("contextWindowFor", () => {
  it("riconosce i nomi pieni che arrivano dal provider, data compresa", () => {
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("claude-opus-4-6")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("gpt-4o-mini")).toEqual({ tokens: 128_000, known: true });
  });

  it("gli alias corti del selettore cadono sulla famiglia", () => {
    expect(contextWindowFor("opus")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("sonnet")).toEqual({ tokens: 200_000, known: true });
  });

  it("la variante a finestra lunga vince sulla famiglia", () => {
    // Stesso modello, servito con la beta 1M: leggerlo come 200k farebbe
    // segnare "90%" a una sessione che sta al 18%.
    expect(contextWindowFor("claude-sonnet-4-5[1m]")).toEqual({ tokens: 1_000_000, known: true });
    expect(contextWindowFor("claude-sonnet-4-5-1m")).toEqual({ tokens: 1_000_000, known: true });
  });

  it("un modello sconosciuto usa il default e lo DICHIARA", () => {
    // `known: false` è il permesso della UI di scrivere "≈": una finestra
    // inventata con tre cifre di precisione è peggio di un'approssimazione
    // dichiarata.
    expect(contextWindowFor("qualcosa-di-nuovo-v9")).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
    expect(contextWindowFor(null)).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
    expect(contextWindowFor("")).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
  });

  it("le chiavi più lunghe vincono su quelle più corte", () => {
    // "gpt-4o-mini" non deve finire su "gpt-4o", né "gpt-5-codex" su "gpt-5".
    expect(contextWindowFor("gpt-4o-mini-2024-07-18").tokens).toBe(128_000);
    expect(contextWindowFor("gpt-5-codex").tokens).toBe(400_000);
  });
});

describe("contextLevel", () => {
  it("una sola scala per colore e preavviso", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_PERCENT - 1)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_PERCENT)).toBe("warn");
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT - 1)).toBe("warn");
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT)).toBe("critical");
    expect(contextLevel(100)).toBe("critical");
  });
});

describe("classifyContext", () => {
  it("calcola percentuale e livello dalla misura reale", () => {
    expect(classifyContext(150_000, { tokens: 200_000, known: true })).toEqual({
      used: 150_000, size: 200_000, percent: 75, level: "warn", estimated: false,
    });
  });

  it("satura a 100: oltre la finestra non esiste il 110%", () => {
    // Succede davvero al confine: la misura è di UNA chiamata e la finestra
    // viene da una tabella. Un ring al 110% disegnerebbe un arco impossibile.
    expect(classifyContext(260_000, { tokens: 200_000, known: true }).percent).toBe(100);
  });

  it("numeri assurdi non producono NaN nel ring", () => {
    expect(classifyContext(Number.NaN, { tokens: 200_000, known: true }).percent).toBe(0);
    expect(classifyContext(-5, { tokens: 200_000, known: true }).used).toBe(0);
    expect(classifyContext(1000, { tokens: 0, known: false }).size).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("propaga `estimated` dalla finestra", () => {
    expect(classifyContext(1000, contextWindowFor("modello-ignoto")).estimated).toBe(true);
    expect(classifyContext(1000, contextWindowFor("claude-opus-4-6")).estimated).toBe(false);
  });
});

/**
 * `[1m]` è una MODALITÀ di servizio, non un modello diverso: il picker manda
 * `claude-opus-5[1m]`, la CLI nei suoi eventi riporta `claude-opus-5` nudo. Chi
 * dimensionava la finestra guardava il secondo e leggeva 200k — l'anello diceva
 * "quasi pieno" a un sesto della capacità vera.
 */
describe("windowModelFor — il suffisso 1M sopravvive al nome nudo della CLI", () => {
  it("la richiesta a 1M vince quando a rispondere è lo stesso modello", () => {
    expect(windowModelFor("claude-opus-5", "claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(contextWindowFor(windowModelFor("claude-opus-5", "claude-opus-5[1m]")).tokens).toBe(1_000_000);
    // Anche col suffisso di data che la CLI a volte aggiunge.
    expect(contextWindowFor(windowModelFor("claude-opus-5-20260101", "claude-opus-5[1m]")).tokens).toBe(1_000_000);
  });

  it("un ripiego su un ALTRO modello porta la SUA finestra, non quella richiesta", () => {
    // Fast mode / sovraccarico: ha risposto sonnet, la finestra è la sua.
    expect(windowModelFor("claude-sonnet-5", "claude-opus-5[1m]")).toBe("claude-sonnet-5");
    expect(contextWindowFor(windowModelFor("claude-sonnet-5", "claude-opus-5[1m]")).tokens).toBe(200_000);
  });

  it("senza 1M nella richiesta non inventa niente", () => {
    expect(contextWindowFor(windowModelFor("claude-opus-5", "claude-opus-5")).tokens).toBe(200_000);
    expect(windowModelFor(null, "claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(windowModelFor("claude-opus-5", null)).toBe("claude-opus-5");
    expect(windowModelFor(null, null)).toBeNull();
  });
});
