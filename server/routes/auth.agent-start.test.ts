/**
 * Project-owner administration of the separate delegated-start capability.
 *
 * @covers GUEST-13, GUEST-15, GUEST-17
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import type { AppContext, RouteHandler } from "../types";
import { createAuthRouter } from "./auth";

function database(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT, revoked_at INTEGER)");
  db.run("CREATE TABLE installation_owners (person_id TEXT PRIMARY KEY, is_default INTEGER)");
  db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, role TEXT, person_id TEXT, revoked_at INTEGER)");
  db.run("CREATE TABLE org_members (org_id TEXT, person_id TEXT, revoked_at INTEGER, local_blocked_at INTEGER)");
  db.run("CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT)");
  db.run(`CREATE TABLE agent_start_capabilities (
    id TEXT PRIMARY KEY, recipient_kind TEXT, recipient_id TEXT, project_id TEXT,
    machine_id TEXT, repository_key TEXT, model TEXT, effort TEXT,
    max_duration_minutes INTEGER, max_attempts INTEGER, fanout INTEGER,
    granted_by_person_id TEXT, granted_at INTEGER, expires_at INTEGER,
    revoked_at INTEGER, revoked_by_person_id TEXT)`);
  db.run("CREATE UNIQUE INDEX one_live ON agent_start_capabilities(recipient_kind, recipient_id, project_id) WHERE revoked_at IS NULL");
  db.run(`CREATE TABLE machine_repository_authorizations (
    id TEXT PRIMARY KEY, machine_id TEXT, repository_key TEXT,
    authorized_by_person_id TEXT, authorized_at INTEGER, revoked_at INTEGER,
    revoked_by_person_id TEXT)`);
  db.run(`CREATE TABLE machine_delegated_model_catalogs (
    machine_id TEXT, repository_key TEXT, authorization_id TEXT, models_json TEXT,
    verified_at INTEGER, expires_at INTEGER, revoked_at INTEGER,
    PRIMARY KEY(machine_id, repository_key))`);
  db.run("INSERT INTO people VALUES ('owner','Owner',NULL), ('guest','Guest',NULL), ('legacy','Legacy',NULL)");
  db.run("INSERT INTO installation_owners VALUES ('owner',1)");
  db.run("INSERT INTO devices VALUES ('owner-device','Owner device','owner','owner',NULL), ('owner-person-guest','Confined owner person','guest','owner',NULL), ('legacy-device','Old owner token','owner','legacy',NULL)");
  db.run("INSERT INTO machines VALUES ('machine-a','Computer A',NULL,'online')");
  return db;
}

function context(db: Database, deviceId: string, role: "owner" | "guest" = "owner"): AppContext {
  return {
    db,
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (req: Request) => req.json(),
    requestIdentity: () => ({ role, deviceId }),
    sendToDevice: () => {},
  } as unknown as AppContext;
}

function call(router: RouteHandler, method: string, path: string, body?: unknown) {
  const req = new Request(`http://x${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, new URL(req.url), new URL(req.url).pathname, method);
}

const codingModels = () => ["model-b", "model-a"];

const policy = {
  projectId: "project-a",
  subjectType: "person",
  subjectId: "guest",
  machineId: "machine-a",
  model: "model-a",
  effort: "high",
  maxDurationMinutes: 30,
};

describe("agent start capability routes", () => {
  test("a legacy owner role without installation ownership cannot grant", async () => {
    const db = database();
    const router = createAuthRouter(context(db, "legacy-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });
    const response = await call(router, "POST", "/api/auth/agent-start-capabilities", policy);
    expect(response?.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM agent_start_capabilities").get()).toEqual({ n: 0 });
  });

  test("a guest device linked to the owner person is not promoted to installation owner", async () => {
    const db = database();
    const router = createAuthRouter(context(db, "owner-person-guest", "guest"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });
    const response = await call(router, "POST", "/api/auth/agent-start-capabilities", policy);
    expect(response?.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM agent_start_capabilities").get()).toEqual({ n: 0 });
  });

  test("the installation owner grants, lists and revokes without changing content grants", async () => {
    const db = database();
    let revoked = "";
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      onCapabilityRevoked: async (id) => { revoked = id; return 1; },
      taskModels: codingModels,
    });
    const created = await call(router, "POST", "/api/auth/agent-start-capabilities", policy);
    expect(created?.status).toBe(201);
    const capability = (await created!.json()).capability;
    expect(capability).toMatchObject({ model: "model-a", maxAttempts: 1, fanout: 1 });

    const listed = await call(router, "GET", "/api/auth/agent-start-capabilities?projectId=project-a");
    expect((await listed!.json()).capabilities).toHaveLength(1);

    const deleted = await call(router, "DELETE", `/api/auth/agent-start-capabilities?projectId=project-a&capabilityId=${capability.id}`);
    expect(deleted?.status).toBe(200);
    expect(await deleted!.json()).toMatchObject({ ok: true, canceledRuns: 1 });
    expect(revoked).toBe(capability.id);
  });

  test("replacing a policy revokes its old runs through the dispatcher seam", async () => {
    const db = database();
    const revoked: string[] = [];
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      onCapabilityRevoked: async (id) => { revoked.push(id); return 1; },
      taskModels: codingModels,
    });
    const first = await call(router, "POST", "/api/auth/agent-start-capabilities", policy);
    const firstId = (await first!.json()).capability.id;
    const second = await call(router, "POST", "/api/auth/agent-start-capabilities", { ...policy, model: "model-b" });
    expect(second?.status).toBe(201);
    expect(revoked).toEqual([firstId]);
    expect(db.query("SELECT revoked_at FROM agent_start_capabilities WHERE id = ?").get(firstId))
      .toMatchObject({ revoked_at: expect.any(Number) });
  });

  test("the board's canonical project id resolves the registered repository", async () => {
    const db = database();
    const directory = mkdtempSync(join(tmpdir(), "topics-agent-start-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
      execFileSync("git", ["remote", "add", "origin", "https://example.test/team/repository.git"], {
        cwd: directory,
      });
      const project = { id: "catalogue-row", name: "Project", slug: "project", path: directory };
      const ctx = context(db, "owner-device");
      ctx.projectStore = {
        get: (id: string) => id === project.id ? project : null,
        list: () => [project],
      } as AppContext["projectStore"];
      const router = createAuthRouter(ctx, { taskModels: codingModels });
      const boardProjectId = projectIdForPath(directory);

      const response = await call(router, "POST", "/api/auth/agent-start-capabilities", {
        ...policy,
        projectId: boardProjectId,
      });

      expect(response?.status).toBe(201);
      expect((await response!.json()).capability).toMatchObject({
        projectId: boardProjectId,
        repositoryKey: "example.test/team/repository",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("inventory preserves coding catalog order and marks legacy and remote support honestly", async () => {
    const db = database();
    db.run("CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, dispatch_model TEXT)");
    db.run("INSERT INTO board_settings VALUES ('project-a','model-b')");
    db.run("INSERT INTO machines VALUES ('machine-remote','Remote computer','http://node.test','online')");
    db.run(`INSERT INTO agent_start_capabilities VALUES
      ('legacy-local','person','guest','project-a','machine-a','example.test/team/repo','api-chat-model','high',30,1,1,'owner',1,NULL,NULL,NULL),
      ('legacy-remote','person','legacy','project-a','machine-remote','example.test/team/repo','remote-model','high',30,1,1,'owner',1,NULL,NULL,NULL)`);
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });

    const response = await call(router, "GET", "/api/auth/agent-start-capabilities?projectId=project-a");
    const inventory = await response!.json();
    expect(inventory.models).toEqual([{ id: "model-b" }, { id: "model-a" }]);
    expect(inventory.recommendedModel).toBe("model-b");
    expect(inventory.capabilities.find((item: { id: string }) => item.id === "legacy-local").modelAvailability)
      .toBe("unavailable");
    expect(inventory.capabilities.find((item: { id: string }) => item.id === "legacy-remote").modelAvailability)
      .toBe("unverified");
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-remote").modelSupport)
      .toBe("unverified");
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-remote").remote)
      .toBe(true);
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-remote").models)
      .toEqual([]);
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-a").models)
      .toEqual([{ id: "model-b" }, { id: "model-a" }]);
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-a").remote)
      .toBe(false);
  });

  test("a model outside the task coding catalog cannot be granted", async () => {
    const db = database();
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });
    const response = await call(router, "POST", "/api/auth/agent-start-capabilities", {
      ...policy,
      model: "api-chat-model",
    });
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "model_unavailable" });
    expect(db.query("SELECT COUNT(*) AS n FROM agent_start_capabilities").get()).toEqual({ n: 0 });
  });

  test("a remote machine without an authoritative model catalog fails closed", async () => {
    const db = database();
    db.run("INSERT INTO machines VALUES ('machine-remote','Remote computer','http://node.test','online')");
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });
    const response = await call(router, "POST", "/api/auth/agent-start-capabilities", {
      ...policy,
      machineId: "machine-remote",
    });
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "model_catalog_unverified" });
    expect(db.query("SELECT COUNT(*) AS n FROM agent_start_capabilities").get()).toEqual({ n: 0 });
  });

  test("a remote computer exposes and accepts only its own verified coding catalog", async () => {
    const db = database();
    db.run("INSERT INTO machines VALUES ('machine-remote','Remote computer','http://node.test','online')");
    db.query(`INSERT INTO machine_delegated_model_catalogs
      VALUES ('machine-remote','example.test/team/repo','catalog-proof',?, ?, ?,NULL)`)
      .run(JSON.stringify(["remote-only"]), Date.now(), Date.now() + 60_000);
    const router = createAuthRouter(context(db, "owner-device"), {
      repositoryKeyOf: async () => "example.test/team/repo",
      taskModels: codingModels,
    });

    const inventoryResponse = await call(router, "GET", "/api/auth/agent-start-capabilities?projectId=project-a");
    const inventory = await inventoryResponse!.json();
    const remote = inventory.computers.find((item: { id: string }) => item.id === "machine-remote");
    expect(remote).toMatchObject({ remote: true, modelSupport: "verified", models: [{ id: "remote-only" }] });
    expect(inventory.computers.find((item: { id: string }) => item.id === "machine-a").models)
      .toEqual([{ id: "model-b" }, { id: "model-a" }]);

    const accepted = await call(router, "POST", "/api/auth/agent-start-capabilities", {
      ...policy, machineId: "machine-remote", model: "remote-only",
    });
    expect(accepted?.status).toBe(201);
    const rejected = await call(router, "POST", "/api/auth/agent-start-capabilities", {
      ...policy, subjectId: "legacy", machineId: "machine-remote", model: "model-a",
    });
    expect(rejected?.status).toBe(409);
    expect(await rejected!.json()).toMatchObject({ code: "model_unavailable" });
  });
});
