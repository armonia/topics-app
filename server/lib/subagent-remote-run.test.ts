/**
 * @covers SUBAGENT-27
 */
import { describe, it, expect } from "bun:test";
import { pickNodeForChild, startRemoteChildRun, type ChildNodeCandidate } from "./subagent-remote-run";
import type { CreateRunBody } from "../services/node-client";


describe("pickNodeForChild (sottoagenti-nodo, traccia 2)", () => {
  const node = (over: Partial<ChildNodeCandidate> = {}): ChildNodeCandidate => ({
    machineId: "node-1", name: "PC", online: true, slots: 2, load: 0, ...over,
  });

  it("un nodo online con un posto libero su machines.slots viene scelto", () => {
    expect(pickNodeForChild([node({ load: 1, slots: 2 })])).toEqual(node({ load: 1, slots: 2 }));
  });

  it("nessun nodo: il figlio resta sul Mac (null)", () => {
    expect(pickNodeForChild([])).toBeNull();
  });

  it("un nodo pieno (load >= slots) non viene scelto: il figlio resta sul Mac", () => {
    expect(pickNodeForChild([node({ load: 2, slots: 2 })])).toBeNull();
  });

  it("un nodo offline non viene scelto anche con posto libero", () => {
    expect(pickNodeForChild([node({ online: false, load: 0, slots: 2 })])).toBeNull();
  });

  it("il primo nodo con posto libero vince, non il più vuoto", () => {
    const full = node({ machineId: "node-full", load: 2, slots: 2 });
    const free = node({ machineId: "node-free", load: 1, slots: 2 });
    expect(pickNodeForChild([full, free])?.machineId).toBe("node-free");
  });
});

describe("startRemoteChildRun (sottoagenti-nodo, traccia 2/4: avvio corsa)", () => {
  const node = (over: Partial<ChildNodeCandidate> = {}): ChildNodeCandidate => ({
    machineId: "node-1", name: "PC", online: true, slots: 2, load: 0, ...over,
  });
  const body: CreateRunBody = {
    originTaskId: "child-1", originUrl: "http://localhost/x", text: "do it",
    description: "", model: null, effort: null,
  };

  it("posta su POST /api/nodes/runs (createRun) e torna il runId del nodo", async () => {
    const calls: unknown[] = [];
    const result = await startRemoteChildRun({
      node: node(),
      body,
      baseUrlOf: () => "https://node.local",
      tokenOf: () => "tok",
      createRun: async (input) => { calls.push(input); return { runId: "run-1" }; },
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(calls).toEqual([{ baseUrl: "https://node.local", token: "tok", body }]);
  });

  it("nodo senza indirizzo: nessuna chiamata, errore chiaro", async () => {
    const result = await startRemoteChildRun({
      node: node(), body, baseUrlOf: () => null, tokenOf: () => "tok",
      createRun: async () => { throw new Error("must not be called"); },
    });
    expect(result).toEqual({ ok: false, reason: "node address or token unavailable" });
  });

  it("nodo senza token: nessuna chiamata, errore chiaro", async () => {
    const result = await startRemoteChildRun({
      node: node(), body, baseUrlOf: () => "https://node.local", tokenOf: () => null,
      createRun: async () => { throw new Error("must not be called"); },
    });
    expect(result).toEqual({ ok: false, reason: "node address or token unavailable" });
  });
});
