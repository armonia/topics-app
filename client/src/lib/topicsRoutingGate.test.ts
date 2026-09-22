/**
 * AICTRL-05: il blocco del send quando un refresh dello snapshot rende lo switch ON incompatibile col provider o col modello attivo. allow-italian: dice quale difetto copre il file
 * Logica pura: il rosso si osserva senza montare ChatPane/ChatInput, che dipendono da store e WS. allow-italian: perche' si prova qui e non sulla superficie
 * @covers AICTRL-05
 */
import { describe, it, expect } from "bun:test";
import { topicsRoutingBlocked, boardTopicsRoutingEnabled } from "./topicsRoutingGate";
import type { ProvidersSnapshot } from "../types";

function snapshot(providers: ProvidersSnapshot["providers"]): ProvidersSnapshot {
  return { providers, defaultProvider: null, generatedAt: new Date().toISOString() };
}

const base = { isDefault: false, requirements: [] as ProvidersSnapshot["providers"][number]["requirements"], fetchedAt: new Date().toISOString() };
const claudeReady = { ...base, name: "claude-code", status: "ready" as const, models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5" };
const topicsReady = { ...base, name: "topics", status: "ready" as const, models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5" };
const topicsDown = { ...base, name: "topics", status: "error" as const, models: [] };

describe("topicsRoutingBlocked", () => {
  it("switch OFF: mai bloccato, qualunque sia lo snapshot", () => {
    expect(topicsRoutingBlocked(false, null, undefined, snapshot([claudeReady, topicsDown]))).toBe(false);
    expect(topicsRoutingBlocked(null, null, undefined, null)).toBe(false);
  });

  it("switch ON e motore nativo pronto: non bloccato", () => {
    expect(topicsRoutingBlocked(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, snapshot([claudeReady, topicsReady]))).toBe(false);
  });

  it("switch ON ma il motore nativo e' sparito dallo snapshot dopo un refresh: bloccato", () => {
    expect(topicsRoutingBlocked(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, snapshot([claudeReady, topicsDown]))).toBe(true);
  });

  it("switch ON, override esplicito su un provider mai instradabile (codex): bloccato", () => {
    const codexReady = { ...base, name: "codex", status: "ready" as const, models: ["gpt-5"] };
    expect(topicsRoutingBlocked(true, { provider: "codex", model: "gpt-5" }, undefined, snapshot([codexReady, topicsReady]))).toBe(true);
  });

  it("switch ON, Automatico vero (nessun override, nessun pin): mai bloccato, anche se il default concreto non e' instradabile", () => {
    // Senza override ne' pin il resolver collassava su un candidato concreto (codex) e bloccava uno stato che il menu mostrava attivo. allow-italian: il caso che il cancello sbagliava
    const codexDefault = { ...base, name: "codex", status: "ready" as const, models: ["gpt-5"], isDefault: true };
    expect(topicsRoutingBlocked(true, null, undefined, snapshot([codexDefault, topicsReady]))).toBe(false);
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
