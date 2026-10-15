import { afterEach, describe, expect, test } from "bun:test";
import { createStatusRouter, _setPtyBridgeHealthForTest } from "./status";
import { HEALTH_SUBSYSTEMS } from "../../shared/system-health";
import type { AppContext } from "../types";

function makeRouter() {
  const ctx = {
    db: { prepare: () => ({ get: () => ({ total: 0, active: 0 }) }) },
    wsClients: new Set(),
    activeStreams: new Map(),
    STATE_DIR: "/tmp/topics-health-test",
    json: (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
  } as unknown as AppContext;
  return createStatusRouter(ctx);
}

afterEach(() => _setPtyBridgeHealthForTest(null));

describe("GET /api/system/health", () => {
  test("returns every subsystem and reports an actionable PTY failure", async () => {
    _setPtyBridgeHealthForTest(false);
    const router = makeRouter();
    const response = await router(new Request("http://topics/api/system/health"), new URL("http://topics/api/system/health"), "/api/system/health", "GET");
    const body = await response!.json() as { subsystems: Array<{ id: string; state: string; observed: string; action: string }> };
    expect(body.subsystems.map(({ id }) => id)).toEqual(HEALTH_SUBSYSTEMS.map(({ id }) => id));
    expect(body.subsystems.find(({ id }) => id === "pty-bridge")).toMatchObject({
      state: "error",
      observed: "Sonda fallita: Socket del bridge PTY assente",
      action: expect.any(String),
    });
  });
});
