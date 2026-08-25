/**
 * @covers ENGSW-01
 */
import { describe, it, expect } from "bun:test";
import { applyEngineSwitch, type EngineSwitchDeps, type PaneEngine } from "./browser-engine-switch";

function makeDeps(overrides?: Partial<{ setEngineResult: { engine: PaneEngine; cdpEndpoint?: string }; setEngineThrows: Error; extensionsCount: number }>) {
  const calls = {
    setEngine: [] as PaneEngine[],
    hints: [] as { engine: "default" | "chromium"; cdp?: string }[],
    destroyed: [] as string[],
    extensionsCountCalled: 0,
  };
  const deps: EngineSwitchDeps = {
    registry: {
      async setEngine(_ctx, engine) {
        calls.setEngine.push(engine);
        if (overrides?.setEngineThrows) throw overrides.setEngineThrows;
        return overrides?.setEngineResult ?? { engine, ...(engine === "chromium" ? { cdpEndpoint: "ws://side/car" } : {}) };
      },
    },
    service: {
      setEngineHint(_id, engine, cdp) { calls.hints.push({ engine, cdp }); },
      async destroyContext(id) { calls.destroyed.push(id); },
    },
    extensionsCount: () => { calls.extensionsCountCalled++; return overrides?.extensionsCount ?? 42; },
  };
  return { deps, calls };
}

describe("applyEngineSwitch", () => {
  it("native→chromium: acquires the engine, hints chromium+endpoint, destroys, broadcasts ext count", async () => {
    const { deps, calls } = makeDeps();
    const msg = await applyEngineSwitch(deps, "ctx-1", "chromium");
    expect(calls.setEngine).toEqual(["chromium"]);
    expect(calls.hints).toEqual([{ engine: "chromium", cdp: "ws://side/car" }]);
    expect(calls.destroyed).toEqual(["ctx-1"]);
    expect(msg).toEqual({ type: "engine", engine: "chromium", extensions: 42 });
  });

  it("chromium→native: hints default (no endpoint), destroys, no extension count", async () => {
    const { deps, calls } = makeDeps();
    const msg = await applyEngineSwitch(deps, "ctx-2", "native");
    expect(calls.hints).toEqual([{ engine: "default", cdp: undefined }]);
    expect(calls.destroyed).toEqual(["ctx-2"]);
    expect(calls.extensionsCountCalled).toBe(0);
    expect(msg).toEqual({ type: "engine", engine: "native" });
  });

  it("hint is set BEFORE destroy (so the recreate can read it)", async () => {
    const order: string[] = [];
    const deps: EngineSwitchDeps = {
      registry: { async setEngine(_c, e) { order.push("setEngine"); return { engine: e, cdpEndpoint: "ws://x" }; } },
      service: {
        setEngineHint() { order.push("setEngineHint"); },
        async destroyContext() { order.push("destroyContext"); },
      },
    };
    await applyEngineSwitch(deps, "ctx-3", "chromium");
    expect(order).toEqual(["setEngine", "setEngineHint", "destroyContext"]);
  });

  it("trusts the registry's resolved engine over the requested one (idempotent no-op)", async () => {
    // Registry reports the pane is already native (nothing acquired) even though
    // chromium was requested — we must not hint/broadcast chromium then.
    const { deps } = makeDeps({ setEngineResult: { engine: "native" } });
    const msg = await applyEngineSwitch(deps, "ctx-4", "chromium");
    expect(msg).toEqual({ type: "engine", engine: "native" });
  });

  it("propagates a registry failure (no chromium installed) without hinting/destroying", async () => {
    const { deps, calls } = makeDeps({ setEngineThrows: new Error("no chromium installed") });
    await expect(applyEngineSwitch(deps, "ctx-5", "chromium")).rejects.toThrow("no chromium installed");
    expect(calls.hints).toEqual([]);
    expect(calls.destroyed).toEqual([]);
  });
});
