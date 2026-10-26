/**
 * `POST /api/machines/:id/model-token` mints the key a node uses against the
 * model proxy. The role check must not rest on "nobody said who": a request
 * with no resolved identity is refused, the loopback owner still mints.
 * @covers MACHINE-03
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMachinesRouter } from "./machines";
import type { AppContext } from "../types";

type Identity = { role: "owner" | "guest"; deviceId: string | null } | null;

let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "model-token-"));
});
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

function post(identity: Identity): Promise<Response | null> {
  const ctx = {
    STATE_DIR: stateDir,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    errorResponse: (status: number, error: string) =>
      new Response(JSON.stringify({ error }), { status }),
    readJSON: async () => null,
    matchRoute: (path: string, pattern: string) => {
      const m = path.match(new RegExp(`^${pattern.replace(":id", "([^/]+)")}$`));
      return m ? { id: m[1] } : null;
    },
    machineStore: { get: (id: string) => ({ id, baseUrl: "http://node.test:3333" }) },
    broadcastToAll: () => {},
    requestIdentity: () => identity,
  } as unknown as AppContext;
  const req = new Request("http://localhost/api/machines/m1/model-token", { method: "POST" });
  const url = new URL(req.url);
  return Promise.resolve(createMachinesRouter(ctx)(req, url, url.pathname, "POST"));
}

describe("model-token mint", () => {
  test("no resolved identity is refused with 403", async () => {
    const res = await post(null);
    expect(res?.status).toBe(403);
    expect((await res!.json()).code).toBe("owner_required");
  });

  test("a guest is refused with 403", async () => {
    expect((await post({ role: "guest", deviceId: "d1" }))?.status).toBe(403);
  });

  test("the loopback owner (owner, no device) mints a token", async () => {
    const res = await post({ role: "owner", deviceId: null });
    expect(res?.status).toBe(200);
    expect(typeof (await res!.json()).token).toBe("string");
  });
});
