/**
 * The cron routes go through the gateway's RPCs, and a failure never reads as "no jobs".
 *
 * GET /api/cron/jobs once answered 200 `{jobs: [], warning}` on a gateway error,
 * and the panel (which checks `res.ok` only) showed an empty list: the jobs
 * looked deleted while OpenClaw was simply down. Since OpenClaw 2026.10.5 the
 * scheduler tool is denied on `POST /tools/invoke`, so the routes call
 * `openclaw gateway call cron.*` instead. The router gets a stubbed call; the
 * CLI wrapper gets a fake `openclaw` script. Nothing reaches a real gateway.
 * @covers CRON-01
 * @covers CRONRPC-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCronRouter, openclawGatewayCall, type GatewayCallResult } from "./cron";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Same contract as the server's matchRoute: `:name` segments become params.
function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const p = pattern.split("/"), a = pathname.split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

function routerWith(answer: (method: string, params: Record<string, unknown>) => GatewayCallResult) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const broadcasts: unknown[] = [];
  const router = createCronRouter({
    readJSON: async (req: Request) => req.json(),
    json,
    matchRoute,
    broadcastToAll: (msg: unknown) => { broadcasts.push(msg); },
  } as never, async (method, params) => { calls.push({ method, params }); return answer(method, params); });
  const send = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`);
    const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
    return (await router(new Request(url, init), url, url.pathname, method))!;
  };
  return { calls, broadcasts, send };
}

const JOBS = { jobs: [{ id: "j1", enabled: true }, { id: "j2", enabled: false }], total: 2 };

describe("GET /api/cron/jobs", () => {
  test("lists the jobs from cron.list, disabled ones included", async () => {
    const { calls, send } = routerWith(() => ({ ok: true, payload: JOBS }));
    const resp = await send("GET", "/api/cron/jobs");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jobs: JOBS.jobs });
    expect(calls).toEqual([{ method: "cron.list", params: { includeDisabled: true } }]);
  });

  test("a gateway that fails answers as an error, with its reason", async () => {
    const { send } = routerWith(() => ({ ok: false, status: 502, message: "connect ECONNREFUSED 127.0.0.1:18789" }));
    const resp = await send("GET", "/api/cron/jobs");
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(502);
    expect(((await resp.json()) as { warning: string }).warning).toContain("ECONNREFUSED");
  });
});

describe("job commands", () => {
  test("PATCH sends the panel's patch to cron.update and broadcasts the fresh list", async () => {
    const { calls, broadcasts, send } = routerWith((m) => ({ ok: true, payload: m === "cron.list" ? JOBS : { id: "j1" } }));
    const resp = await send("PATCH", "/api/cron/jobs/j1", { enabled: false });
    expect(resp.status).toBe(200);
    expect(calls[0]).toEqual({ method: "cron.update", params: { id: "j1", patch: { enabled: false } } });
    expect(broadcasts).toEqual([{ type: "cron:updated", jobs: JOBS.jobs }]);
  });

  test("run forces the job, as `openclaw cron run` does", async () => {
    const { calls, send } = routerWith((m) => ({ ok: true, payload: m === "cron.list" ? JOBS : { enqueued: true } }));
    const resp = await send("POST", "/api/cron/jobs/j1/run");
    expect(resp.status).toBe(200);
    expect(calls[0]).toEqual({ method: "cron.run", params: { id: "j1", mode: "force" } });
  });

  test("DELETE goes to cron.remove", async () => {
    const { calls, send } = routerWith((m) => ({ ok: true, payload: m === "cron.list" ? JOBS : { removed: true } }));
    expect((await send("DELETE", "/api/cron/jobs/j1")).status).toBe(200);
    expect(calls[0]).toEqual({ method: "cron.remove", params: { id: "j1" } });
  });

  test("a refusal keeps the gateway's status and sentence, and broadcasts nothing", async () => {
    const { broadcasts, send } = routerWith(() => ({ ok: false, status: 400, message: "cron job not found: j9" }));
    const resp = await send("PATCH", "/api/cron/jobs/j9", { enabled: true });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toContain("cron job not found: j9");
    expect(broadcasts).toEqual([]);
  });
});

describe("openclawGatewayCall", () => {
  const dir = mkdtempSync(join(tmpdir(), "topics-test-cron-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fakeCli = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test("passes method and params as `gateway call` arguments and returns the payload", async () => {
    const argsFile = join(dir, "ok.args");
    const bin = fakeCli("ok", `printf '%s\\n' "$@" > '${argsFile}'; printf '{"token":"%s"}' "\${GATEWAY_TOKEN:-absent}"`);
    const before = process.env.GATEWAY_TOKEN;
    process.env.GATEWAY_TOKEN = "must-not-reach-the-cli";
    try {
      const r = await openclawGatewayCall("cron.run", { id: "j1", mode: "force" }, bin);
      expect(r).toEqual({ ok: true, payload: { token: "absent" } });
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["gateway", "call", "cron.run", "--params", '{"id":"j1","mode":"force"}', "--json"]);
    } finally {
      if (before === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = before;
    }
  });

  test("an invalid request is a 400 with the gateway's sentence", async () => {
    const bin = fakeCli("refuse", `echo '{"ok":false,"error":{"code":"INVALID_REQUEST","message":"cron job not found: nope"}}'; exit 1`);
    expect(await openclawGatewayCall("cron.get", { id: "nope" }, bin)).toEqual({ ok: false, status: 400, message: "cron job not found: nope" });
  });

  test("a gateway that cannot be reached is a 502 with the CLI's last line", async () => {
    const bin = fakeCli("down", `echo 'gateway connect failed: ECONNREFUSED' >&2; exit 1`);
    const r = await openclawGatewayCall("cron.list", {}, bin);
    expect(r).toEqual({ ok: false, status: 502, message: "openclaw gateway call cron.list failed: gateway connect failed: ECONNREFUSED" });
  });

  test("no CLI on PATH is a 502 that says so", async () => {
    expect(await openclawGatewayCall("cron.list", {}, null)).toEqual({ ok: false, status: 502, message: "openclaw CLI not found on PATH" });
  });
});
