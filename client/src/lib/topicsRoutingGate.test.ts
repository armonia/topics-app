/**
 * AICTRL-05: il blocco del send quando un refresh dello snapshot rende lo switch ON incompatibile col provider o col modello attivo. allow-italian: dice quale difetto copre il file
 * Logica pura: il rosso si osserva senza montare ChatPane/ChatInput, che dipendono da store e WS. allow-italian: perche' si prova qui e non sulla superficie
 * @covers AICTRL-05
 */
import { describe, it, expect } from "bun:test";
import { topicsRoutingBlocked, boardTopicsRoutingEnabled, cardBoardSettings, fetchCardBoardSettings } from "./topicsRoutingGate";
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

// The drawer's settings for a card of another board are the ones fetched for
// THAT board: a fetch tagged with the pane's board never matches the card, and
// the drawer would judge every foreign card with no default.
describe("fetchCardBoardSettings", () => {
  const byBoard: Record<string, { dispatchModel: string }> = {
    alpha: { dispatchModel: "codex" },
    beta: { dispatchModel: "claude-sonnet-5" },
  };
  const api = () => {
    const asked: string[] = [];
    return { asked, getSettings: async (id: string) => { asked.push(id); return byBoard[id]!; } };
  };

  it("a card of another board: its board's settings are fetched and reach the drawer", async () => {
    const { asked, getSettings } = api();
    const fetched = await fetchCardBoardSettings("beta", "alpha", getSettings);
    expect(asked).toEqual(["beta"]);
    expect(cardBoardSettings("beta", "alpha", byBoard.alpha!, fetched)).toEqual({ dispatchModel: "claude-sonnet-5" });
  });

  it("a card of the pane's board, or no card: nothing is fetched and the pane's settings apply", async () => {
    const { asked, getSettings } = api();
    expect(await fetchCardBoardSettings("alpha", "alpha", getSettings)).toBeNull();
    expect(await fetchCardBoardSettings(undefined, "alpha", getSettings)).toBeNull();
    expect(asked).toEqual([]);
    expect(cardBoardSettings("alpha", "alpha", byBoard.alpha!, null)).toBe(byBoard.alpha!);
  });
});
