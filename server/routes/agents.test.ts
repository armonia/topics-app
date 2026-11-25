// @covers AGENTS-REG-01
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAgentsRouter } from "./agents";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agents-router-"));
  dirs.push(home);
  const ws = join(home, "ws", "a");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "IDENTITY.md"), "# Prima\nScrive il codice\n");
  writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: { a: { workspace: ws } } }));
  return home;
}

function ctx(role: "owner" | "guest" = "owner") {
  return {
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    requestIdentity: () => ({ role, deviceId: "d1" }),
  };
}

describe("GET /api/agents", () => {
  test("reads the configured agents", async () => {
    const home = fixtureHome();
    const router = createAgentsRouter(ctx(), () => home, () => join(home, "agents"));
    const res = await router(new Request("http://x/api/agents"), new URL("http://x/api/agents"), "/api/agents", "GET");
    const body = await res!.json();
    expect(body.agents).toEqual([{ id: "a", name: "Prima", job: "Scrive il codice", workspace: join(home, "ws", "a") }]);
  });

  test("no configuration, empty list", async () => {
    const router = createAgentsRouter(ctx(), () => "", () => "/tmp/agents");
    const res = await router(new Request("http://x/api/agents"), new URL("http://x/api/agents"), "/api/agents", "GET");
    expect(await res!.json()).toEqual({ agents: [] });
  });
});

describe("POST /api/agents", () => {
  test("a guest is refused", async () => {
    const home = fixtureHome();
    const router = createAgentsRouter(ctx("guest"), () => home, () => join(home, "agents"));
    const req = new Request("http://x/api/agents", { method: "POST", body: JSON.stringify({ name: "Seconda", job: "Fa i turni" }) });
    const res = await router(req, new URL("http://x/api/agents"), "/api/agents", "POST");
    expect(res!.status).toBe(403);
  });

  test("an owner creates an agent", async () => {
    const home = fixtureHome();
    const router = createAgentsRouter(ctx("owner"), () => home, () => join(home, "agents"));
    const req = new Request("http://x/api/agents", { method: "POST", body: JSON.stringify({ name: "Seconda", job: "Fa i turni" }) });
    const res = await router(req, new URL("http://x/api/agents"), "/api/agents", "POST");
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.agent.id).toBe("seconda");
  });

  test("a duplicate id is refused with 400", async () => {
    const home = fixtureHome();
    const router = createAgentsRouter(ctx("owner"), () => home, () => join(home, "agents"));
    const req = () => new Request("http://x/api/agents", { method: "POST", body: JSON.stringify({ name: "Terza", job: "Fa i turni" }) });
    await router(req(), new URL("http://x/api/agents"), "/api/agents", "POST");
    const res = await router(req(), new URL("http://x/api/agents"), "/api/agents", "POST");
    expect(res!.status).toBe(400);
  });
});
