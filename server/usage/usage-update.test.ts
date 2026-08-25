/**
 * 3.1 — la forma standard del contatore di contesto.
 *
 * Due cose vanno bloccate qui, perché sono quelle che si rompono in silenzio:
 * QUALI token contano come contesto (l'output non è contesto, e i reasoning
 * token contati qui li conterebbero due volte) e che il blocco sul filo sia
 * l'oggetto ACP letterale — `sessionUpdate` incluso — e non una sua parafrasi
 * che il giorno di 3.2 andrebbe tradotta.
 *
 * @covers USAGE-06, USAGE-07, USAGE-08
 */
import { describe, it, expect } from "bun:test";
import {
  buildContextUpdate,
  contextTokensFromUsage,
  contextUpdateFromUsage,
} from "./usage-update";
import { classifyContext, DEFAULT_CONTEXT_WINDOW } from "./context-window";

describe("contextTokensFromUsage — il numeratore, uguale per ogni provider", () => {
  it("somma input + cache_read + cache_creation", () => {
    expect(
      contextTokensFromUsage({ inputTokens: 1_000, cacheRead: 40_000, cacheCreation: 2_000 }),
    ).toBe(43_000);
  });

  it("NON conta l'output: è ciò che il modello ha prodotto, non ciò che ha letto", () => {
    expect(contextTokensFromUsage({ inputTokens: 1_000, outputTokens: 900_000 })).toBe(1_000);
  });

  it("NON conta i reasoning token: sono già dentro l'input del giro dopo", () => {
    expect(contextTokensFromUsage({ inputTokens: 1_000, reasoningTokens: 50_000 })).toBe(1_000);
  });

  it("usage assente o malformato vale 0, non lancia", () => {
    expect(contextTokensFromUsage(null)).toBe(0);
    expect(contextTokensFromUsage(undefined)).toBe(0);
    expect(contextTokensFromUsage({} as never)).toBe(0);
    expect(contextTokensFromUsage({ inputTokens: NaN, cacheRead: -5 } as never)).toBe(0);
  });
});

describe("buildContextUpdate — blocco ACP + presentazione", () => {
  it("il blocco è `usage_update` verbatim, con used e size dentro", () => {
    const u = buildContextUpdate({ tokens: 50_000, model: "claude-opus-5" });
    expect(u.usage).toEqual({ sessionUpdate: "usage_update", used: 50_000, size: 200_000 });
    // La presentazione sta FUORI dal blocco: non è protocollo.
    expect(u.usage).not.toHaveProperty("percent");
    expect(u.usage).not.toHaveProperty("level");
    expect(u.percent).toBe(25);
    expect(u.level).toBe("ok");
    expect(u.estimated).toBe(false);
    expect(u.model).toBe("claude-opus-5");
  });

  it("`cost` compare solo se c'è: ACP lo vuole opzionale, non a zero", () => {
    expect(buildContextUpdate({ tokens: 10, model: "opus" }).usage.cost).toBeUndefined();
    const withCost = buildContextUpdate({
      tokens: 10,
      model: "opus",
      cost: { amount: 0.045, currency: "USD" },
    });
    expect(withCost.usage.cost).toEqual({ amount: 0.045, currency: "USD" });
  });

  it("il modello della chiamata batte quello richiesto: è lui a dimensionare la finestra", () => {
    // La CLI ha ripiegato su un modello a finestra lunga a metà turno.
    const u = buildContextUpdate({ tokens: 180_000, model: "claude-sonnet-4-5[1m]", fallbackModel: "opus" });
    expect(u.usage.size).toBe(1_000_000);
    expect(u.percent).toBe(18); // non 90: leggerlo dalla richiesta sarebbe una bugia
  });

  it("senza modello per-chiamata usa il fallback della richiesta", () => {
    const u = buildContextUpdate({ tokens: 1_000, fallbackModel: "gpt-4o" });
    expect(u.usage.size).toBe(128_000);
    expect(u.model).toBe("gpt-4o");
  });

  it("il nome nudo della CLI non regge contro la misura: 576k non stanno in 200k", () => {
    // Sessione lanciata a `[1m]`, transcript col nome nudo e nessuna richiesta da
    // cui recuperare il suffisso: senza rete l'evento vivo diceva 288%. Quella
    // chiamata ha ricevuto risposta, quindi la finestra è quella lunga.
    const u = buildContextUpdate({ tokens: 576_211, model: "claude-opus-5" });
    expect(u.usage.size).toBe(1_000_000);
    expect(u.percent).toBe(58);
  });

  it("modello sconosciuto: default DICHIARATO come stima, non spacciato per certo", () => {
    const u = buildContextUpdate({ tokens: 1_000, model: "qualcosa-mai-visto-v9" });
    expect(u.usage.size).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(u.estimated).toBe(true);
  });

  it("la finestra DETTA dal provider vince sulla tabella e spegne `estimated`", () => {
    const u = buildContextUpdate({
      tokens: 136_000,
      model: "un-modello-codex-nuovissimo",
      windowTokens: 272_000,
    });
    expect(u.usage.size).toBe(272_000);
    expect(u.percent).toBe(50);
    expect(u.estimated).toBe(false);
  });

  it("una finestra dichiarata assurda (0, negativa, NaN) non azzera il denominatore", () => {
    for (const w of [0, -1, NaN, null, undefined]) {
      const u = buildContextUpdate({ tokens: 1_000, model: "opus", windowTokens: w as never });
      expect(u.usage.size).toBe(200_000);
    }
  });

  it("`model` è assente quando nessuno lo conosce — non stringa vuota", () => {
    const u = buildContextUpdate({ tokens: 1_000 });
    expect(u.model).toBeUndefined();
    expect(Object.keys(u)).not.toContain("model");
  });

  it("oltre la finestra satura a 100: non esiste un contesto al 110%", () => {
    const u = buildContextUpdate({ tokens: 1_300_000, model: "opus" });
    expect(u.percent).toBe(100);
    expect(u.level).toBe("critical");
    // `used` resta il numero VERO: satura la percentuale, non la misura.
    expect(u.usage.used).toBe(1_300_000);
  });
});

describe("contextUpdateFromUsage — la misura persistita, stessa forma", () => {
  it("WS e REST producono lo stesso oggetto per la stessa misura", () => {
    const live = buildContextUpdate({ tokens: 143_000, model: "claude-opus-5" });
    const stored = contextUpdateFromUsage(
      classifyContext(143_000, { tokens: 200_000, known: true }),
      "claude-opus-5",
    );
    expect(stored).toEqual(live);
  });

  it("porta il costo quando c'è", () => {
    const u = contextUpdateFromUsage(
      classifyContext(1_000, { tokens: 200_000, known: true }),
      null,
      { amount: 1.5, currency: "USD" },
    );
    expect(u.usage.cost).toEqual({ amount: 1.5, currency: "USD" });
    expect(u.model).toBeUndefined();
  });
});
