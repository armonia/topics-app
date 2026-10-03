/**
 * AICTRL-05 + MSEL-06: lo switch lato client. Dal model-selector un bersaglio che il motore non raggiunge va diretto e la strada si dichiara: l'invio si blocca solo per la chat legacy legata al motore stesso (`provider: "topics"`) col motore giu'. allow-italian: dice quale contratto copre il file
 * Logica pura: si osserva senza montare ChatPane/ChatInput, che dipendono da store e WS. allow-italian: perche' si prova qui e non sulla superficie
 * @covers AICTRL-05, MSEL-06
 */
import { describe, it, expect } from "bun:test";
import { topicsRoutingBlocked, boardTopicsRoutingEnabled, cardBoardSettings, chatTopicsRoute } from "./topicsRoutingGate";
import type { ProvidersSnapshot } from "../types";

function snapshot(providers: ProvidersSnapshot["providers"], defaultProvider: string | null = null): ProvidersSnapshot {
  return { providers, defaultProvider, generatedAt: new Date().toISOString() };
}

const base = { isDefault: false, requirements: [] as ProvidersSnapshot["providers"][number]["requirements"], fetchedAt: new Date().toISOString() };
const claudeReady = { ...base, name: "claude-code", status: "ready" as const, models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5" };
const topicsReady = { ...base, name: "topics", status: "ready" as const, models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5" };
const topicsDown = { ...base, name: "topics", status: "error" as const, models: [] };
const codexReady = { ...base, name: "codex", status: "ready" as const, models: ["gpt-5"] };

describe("topicsRoutingBlocked", () => {
  it("switch OFF: mai bloccato, qualunque sia lo snapshot", () => {
    expect(topicsRoutingBlocked(false, null, undefined, snapshot([claudeReady, topicsDown]))).toBe(false);
    expect(topicsRoutingBlocked(null, null, undefined, null)).toBe(false);
  });

  it("switch ON e motore nativo pronto: non bloccato", () => {
    expect(topicsRoutingBlocked(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, snapshot([claudeReady, topicsReady]))).toBe(false);
  });

  it("MSEL-06: switch ON col motore sparito dopo un refresh: non bloccato, il turno va diretto", () => {
    expect(topicsRoutingBlocked(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, snapshot([claudeReady, topicsDown]))).toBe(false);
    expect(chatTopicsRoute(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, snapshot([claudeReady, topicsDown])))
      .toEqual({ via: "direct", reason: "engine-down" });
  });

  it("MSEL-06: switch ON su Codex: non bloccato, diretto per famiglia", () => {
    expect(topicsRoutingBlocked(true, { provider: "codex", model: "gpt-5" }, undefined, snapshot([codexReady, topicsReady]))).toBe(false);
    expect(chatTopicsRoute(true, { provider: "codex", model: "gpt-5" }, undefined, snapshot([codexReady, topicsReady])))
      .toEqual({ via: "direct", reason: "family" });
  });

  it("la chat legacy legata al motore stesso, col motore giu': l'unico invio che si blocca", () => {
    expect(topicsRoutingBlocked(null, null, "topics", snapshot([claudeReady, topicsDown]))).toBe(true);
    expect(topicsRoutingBlocked(null, null, "topics", snapshot([claudeReady, topicsReady]))).toBe(false);
  });
});

describe("chatTopicsRoute (MSEL-06)", () => {
  it("chat mai toccata (null) su Claude Code con un modello servito: via Topics", () => {
    expect(chatTopicsRoute(null, null, "claude-code", snapshot([claudeReady, topicsReady]))).toEqual({ via: "topics" });
  });

  it("Automatico vero col default su Codex: diretto, il default si risolve prima della strada", () => {
    expect(chatTopicsRoute(null, null, undefined, snapshot([codexReady, topicsReady], "codex"))).toEqual({ via: "direct", reason: "family" });
  });

  it("scritto spento: diretto/off", () => {
    expect(chatTopicsRoute(false, null, "claude-code", snapshot([claudeReady, topicsReady]))).toEqual({ via: "direct", reason: "off" });
  });
});

describe("boardTopicsRoutingEnabled", () => {
  it("board mai toccata (null) con dispatchModel legacy topics:<model>: letta ON", () => {
    // Il `!!` del pannello collassava null a false anche col prefisso legacy acceso. allow-italian: l'espressione sbagliata che questo test vieta
    expect(boardTopicsRoutingEnabled(null, "topics:claude-sonnet-5")).toBe(true);
  });

  it("board mai toccata (null) senza prefisso legacy: letta OFF", () => {
    expect(boardTopicsRoutingEnabled(null, "claude-sonnet-5")).toBe(false);
    expect(boardTopicsRoutingEnabled(null, null)).toBe(false);
  });

  it("switch esplicito vince sempre sul prefisso legacy del modello", () => {
    expect(boardTopicsRoutingEnabled(false, "topics:claude-sonnet-5")).toBe(false);
    expect(boardTopicsRoutingEnabled(true, "claude-sonnet-5")).toBe(true);
  });
});

// The all-boards view lists every board's cards inside one project pane, whose
// settings are its own board's: a card of another board read that default.
describe("cardBoardSettings", () => {
  const pane = { dispatchModel: "codex" };
  const other = { dispatchModel: "claude-sonnet-5" };

  it("a card of the pane's board reads the pane's settings", () => {
    expect(cardBoardSettings("alpha", "alpha", pane, null)).toBe(pane);
  });

  it("a card of another board reads that board's settings once they arrive", () => {
    expect(cardBoardSettings("beta", "alpha", pane, { projectId: "beta", settings: other })).toBe(other);
  });

  it("until they arrive, or with a third board's in hand, the default is unknown, never the pane's", () => {
    expect(cardBoardSettings("beta", "alpha", pane, null)).toBeNull();
    expect(cardBoardSettings("beta", "alpha", pane, { projectId: "gamma", settings: other })).toBeNull();
  });
});
