/**
 * Terminal session control must NOT depend on the (dismissed) OpenClaw gateway
 * token. This proves the native Topics credential — X-Agent-Token for a
 * lead-role profile — authorizes the RCE-sensitive /send route, with
 * GATEWAY_TOKEN unset. It also covers the token-minting endpoint and the
 * lead-only restriction (a worker token is rejected).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext } from "./helpers";
import type { AppContext, RouteHandler } from "../../server/types";

const TEST_DATA = "/tmp/topics-agent-token-test";
// The whole point: no gateway token in the environment. If OpenClaw were still
// the gate, every /send below would be 401 and this suite would fail.
const PRIOR_GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
beforeAll(() => { delete process.env.GATEWAY_TOKEN; setupTestDataDir(TEST_DATA); });

let disconnect: (() => void) | null = null;
afterAll(() => {
  if (PRIOR_GATEWAY_TOKEN === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = PRIOR_GATEWAY_TOKEN;
  try { disconnect?.(); } catch {}
});

function call(router: RouteHandler, method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const url = new URL("http://h" + path);
  const req = new Request(url, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { "x-agent-token": opts.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return router(req, url, url.pathname, method);
}

async function createProfile(profiles: RouteHandler, name: string, role: string): Promise<string> {
  const resp = await call(profiles, "POST", "/api/agents/profiles", { body: { name, role } });
  expect(resp!.status).toBe(201);
  const p = (await resp!.json()) as { id: string };
  return p.id;
}

async function mintToken(profiles: RouteHandler, id: string): Promise<string> {
  const resp = await call(profiles, "POST", `/api/agents/profiles/${id}/token`, { body: {} });
  expect(resp!.status).toBe(200);
  const { token } = (await resp!.json()) as { token: string };
  expect(token).toMatch(/^topix_/);
  return token;
}

describe("Terminal control via native agent token (no OpenClaw)", () => {
  let ctx: AppContext;
  let terminal: RouteHandler;
  let profiles: RouteHandler;
  let leadToken: string;
  let workerToken: string;

  beforeAll(async () => {
    const { createTerminalRouter, disconnectBridge } = await import("../../server/routes/terminal");
    const { createAgentProfilesRouter } = await import("../../server/routes/agent-profiles");
    ctx = await createTestAppContext();
    terminal = createTerminalRouter(ctx);
    profiles = createAgentProfilesRouter(ctx);
    disconnect = disconnectBridge;

    const leadId = await createProfile(profiles, "test-lead", "lead");
    const workerId = await createProfile(profiles, "test-worker", "worker");
    leadToken = await mintToken(profiles, leadId);
    workerToken = await mintToken(profiles, workerId);
  });

  test("no credential → 401", async () => {
    const resp = await call(terminal, "POST", "/api/terminal/sessions/bogus/send", { body: { input: "" } });
    expect(resp!.status).toBe(401);
  });

  test("worker token → 401 (lead-only)", async () => {
    const resp = await call(terminal, "POST", "/api/terminal/sessions/bogus/send", { body: { input: "" }, token: workerToken });
    expect(resp!.status).toBe(401);
  });

  test("lead token authorizes: past 401 (404 on unknown session)", async () => {
    const resp = await call(terminal, "POST", "/api/terminal/sessions/bogus/send", { body: { input: "hi" }, token: leadToken });
    expect(resp!.status).not.toBe(401);
    expect(resp!.status).toBe(404);
  });

  test("lead token → 400 on empty input for a live session", async () => {
    // Needs a real PTY. Skip gracefully where the bridge can't spawn.
    const createResp = await call(terminal, "POST", "/api/terminal/sessions", { body: { name: "tok-test", type: "shell", cwd: "/tmp" } });
    if (createResp!.status === 502) {
      console.warn("[agent-token] PTY bridge unavailable (502) — skipping live-session 400 assertion");
      return;
    }
    expect(createResp!.status).toBe(200);
    const { id } = (await createResp!.json()) as { id: string };

    const emptyResp = await call(terminal, "POST", `/api/terminal/sessions/${id}/send`, { body: { input: "" }, token: leadToken });
    expect(emptyResp!.status).toBe(400); // authorized, rejected only for empty input

    await call(terminal, "DELETE", `/api/terminal/sessions/${id}`, { token: leadToken });
  }, 20000);
});
