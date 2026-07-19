/**
 * Engine switch (task 54601eeb) — the pure ORCHESTRATION of a pane's engine
 * change, sitting between the WS route (server.ts) and the two collaborators it
 * coordinates: the engine registry (ref-counted sidecar bookkeeping) and the
 * browser service (context lifecycle). Extracted as a dependency-injected
 * function so the ordering contract is unit-tested without a live browser, a
 * live sidecar, or the server's WS plumbing.
 *
 * The contract, in order:
 *   1. registry.setEngine(engine) — acquires exactly one sidecar ref on
 *      native→chromium (returning its CDP endpoint) or releases it on
 *      chromium→native. Throws if no chromium is installed; we let it propagate
 *      so the caller can tell the client the switch failed (pane stays put).
 *   2. service.setEngineHint(...) — records the engine the context must be
 *      RECREATED on. createContext consults this, so the recreate lands on the
 *      right engine even though getOrCreate passes no opts.
 *   3. service.destroyContext(...) — tears the current context down. The client,
 *      seeing the 'engine' broadcast, remounts its WS → open handler →
 *      startScreencast → getOrCreate → createContext picks up the hint.
 *
 * The returned value is exactly the `engine` WS message to broadcast to every
 * client watching this context.
 */

export type PaneEngine = "native" | "chromium";

export interface EngineSwitchRegistry {
  setEngine(
    contextId: string,
    engine: PaneEngine,
  ): Promise<{ engine: PaneEngine; cdpEndpoint?: string }>;
}

export interface EngineSwitchService {
  setEngineHint(id: string, engine: "default" | "chromium", cdpEndpoint?: string): void;
  destroyContext(id: string): Promise<void>;
}

export interface EngineSwitchDeps {
  registry: EngineSwitchRegistry;
  service: EngineSwitchService;
  /** How many extensions the chromium sidecar profile carries — for the toolbar
   *  badge. A thunk so the (cached) disk walk only runs when actually switching. */
  extensionsCount?: () => number;
}

export interface EngineBroadcast {
  type: "engine";
  engine: PaneEngine;
  extensions?: number;
}

/** The browser service speaks 'default'|'chromium'; the registry + WS protocol
 *  speak 'native'|'chromium'. This is the one place the two vocabularies meet. */
function toServiceEngine(engine: PaneEngine): "default" | "chromium" {
  return engine === "chromium" ? "chromium" : "default";
}

export async function applyEngineSwitch(
  deps: EngineSwitchDeps,
  contextId: string,
  engine: PaneEngine,
): Promise<EngineBroadcast> {
  const state = await deps.registry.setEngine(contextId, engine);
  // Trust the registry's resolved engine (idempotent no-ops return current state).
  const resolved = state.engine;
  deps.service.setEngineHint(contextId, toServiceEngine(resolved), state.cdpEndpoint);
  await deps.service.destroyContext(contextId);
  return {
    type: "engine",
    engine: resolved,
    ...(resolved === "chromium" && deps.extensionsCount
      ? { extensions: deps.extensionsCount() }
      : {}),
  };
}
