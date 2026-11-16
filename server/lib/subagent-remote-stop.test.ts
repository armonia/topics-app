/**
 * @covers SUBAGENT-27
 */
import { describe, it, expect } from "bun:test";
import { stopRemoteChild } from "./subagent-remote-stop";

describe("stopRemoteChild", () => {
  const base = { machineId: "node-1", runId: "run-1", baseUrlOf: () => "https://node.local", tokenOf: () => "tok" };

  it("cancella la corsa sul nodo", async () => {
    const calls: unknown[] = [];
    const result = await stopRemoteChild({ ...base, cancelRun: async (input) => { calls.push(input); } });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ baseUrl: "https://node.local", token: "tok", runId: "run-1" }]);
  });

  it("nodo che non risponde: nessuna eccezione, ok false col motivo", async () => {
    const result = await stopRemoteChild({ ...base, cancelRun: async () => { throw new Error("unreachable"); } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unreachable");
  });

  it("nodo senza token: nessuna chiamata", async () => {
    const result = await stopRemoteChild({ ...base, tokenOf: () => null, cancelRun: async () => { throw new Error("must not be called"); } });
    expect(result).toEqual({ ok: false, reason: "node address or token unavailable" });
  });
});
