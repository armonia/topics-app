/**
 * A gateway that fails must not read as "no jobs".
 *
 * GET /api/cron/jobs answered 200 `{jobs: [], warning}` on a gateway error,
 * and the panel (which checks `res.ok` only) showed an empty list: the jobs
 * looked deleted while OpenClaw was simply down. The gateway is a stubbed
 * `fetch`; nothing leaves the process.
 * @covers CRON-01
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createCronRouter } from "./cron";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const router = createCronRouter({
  GATEWAY_URL: "http://gateway.invalid",
  GATEWAY_TOKEN: "fake-token",
  readJSON: async () => ({}),
  json,
  matchRoute: () => null,
  broadcastToAll: () => {},
} as never);

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null = null;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = null; });

function gateway(answer: () => Promise<Response>) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(answer, { preconnect: () => {} }));
}

async function listJobs(): Promise<Response> {
  const url = new URL("http://x/api/cron/jobs");
  return (await router(new Request(url), url, url.pathname, "GET"))!;
}

describe("GET /api/cron/jobs", () => {
  test("a gateway error answers as an error, with its reason", async () => {
    gateway(async () => new Response("boom", { status: 500 }));
    const resp = await listJobs();
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(502);
    expect(((await resp.json()) as { warning: string }).warning).toContain("500");
  });

  test("an unreachable gateway answers as an error, with its reason", async () => {
    gateway(async () => { throw new Error("connect ECONNREFUSED"); });
    const resp = await listJobs();
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(502);
    expect(((await resp.json()) as { warning: string }).warning).toContain("ECONNREFUSED");
  });

  test("a gateway that answers still lists its jobs", async () => {
    gateway(async () => json({ result: { details: { jobs: [{ id: "j1" }] } } }));
    const resp = await listJobs();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jobs: [{ id: "j1" }] });
  });
});
