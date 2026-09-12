/**
 * The ingress of a mirrored card on a NODE: `/api/nodes/runs`.
 *
 * A real temporary git repository stands in for the node's checkout, with a
 * delivery branch one commit ahead of `main`, so the bundle that comes back
 * is verified by git itself and planted into a second clone: the round trip
 * of the KANBAN-76 scenario where the branch comes back as a bundle, not a
 * stub of it.
 *
 * @covers KANBAN-76
 * @covers MACHINE-02
 * @covers GUEST-17
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
import type { AppContext, RouteHandler } from "../../server/types";
import { hashToken } from "../../server/lib/device-auth";
import { resolveDelegatedCredential } from "../../server/lib/identity";
import { createNodeClient, readDelegatedNodeToken } from "../../server/services/node-client";
import { setupTestDataDir, cleanupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";

const ROOT = testTmpDir("nodes-routes");
const REPO = join(ROOT, "repo");
const CLONE = join(ROOT, "clone");
const DELIVERY_BRANCH = "topics/mirror-run";
const EMPTY_BRANCH = "topics/empty-run";
const ORIGIN_SSH = "git@github.com:Acme/Widgets.git";
const ORIGIN_HTTPS = "https://github.com/acme/widgets";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "node-test",
  GIT_AUTHOR_EMAIL: "node-test@example.invalid",
  GIT_COMMITTER_NAME: "node-test",
  GIT_COMMITTER_EMAIL: "node-test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let ctx: AppContext;
let router: RouteHandler;
let projectId: string;
let mainSha: string;
let deliverySha: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const resp = await router(req, url, url.pathname, method);
  if (!resp) throw new Error(`no route for ${method} ${path}`);
  return resp;
}

const DELEGATED_PERSON = "person-confined";
const DELEGATED_DEVICE = "device-confined";
const DELEGATED_CAPABILITY = "capability-confined";
const DELEGATED_TOKEN = "confined-node-credential-0123456789";
const DELEGATED_HEADERS = {
  cookie: `topics_device=${DELEGATED_TOKEN}`,
  "x-topics-delegated-capability": DELEGATED_CAPABILITY,
};
let delegatedMachineId: string;

function delegatedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originTaskId: "origin-task-confined",
    originUrl: ORIGIN_HTTPS,
    text: "confined delegated run",
    description: "immutable execution envelope",
    ...overrides,
  };
}

async function mirror(originTaskId: string, originUrl = ORIGIN_HTTPS): Promise<{ status: number; body: any }> {
  const resp = await call("POST", "/api/nodes/runs", { originTaskId, originUrl, text: `mirror of ${originTaskId}` });
  return { status: resp.status, body: await resp.json() };
}

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));

  // The node's checkout: one commit on main, a delivery branch one commit
  // ahead, an empty branch sitting on main, and an ssh-style origin so the
  // POST can present the https spelling of the same repository.
  git(ROOT, "init", "-q", "-b", "main", REPO);
  writeFileSync(join(REPO, "README.md"), "widgets\n");
  git(REPO, "add", "README.md");
  git(REPO, "commit", "-q", "-m", "first");
  mainSha = git(REPO, "rev-parse", "HEAD");
  git(REPO, "remote", "add", "origin", ORIGIN_SSH);
  git(REPO, "checkout", "-q", "-b", DELIVERY_BRANCH);
  appendFileSync(join(REPO, "README.md"), "delivered by the node\n");
  git(REPO, "commit", "-q", "-am", "node delivery");
  deliverySha = git(REPO, "rev-parse", "HEAD");
  git(REPO, "checkout", "-q", "main");
  git(REPO, "branch", EMPTY_BRANCH, "main");

  // The origin board's checkout: it has main, and nothing else.
  git(ROOT, "clone", "-q", REPO, CLONE);

  ctx = await createTestAppContext();
  ctx.requestIp = () => "127.0.0.1";
  projectId = ctx.projectStore.create({ name: "widgets", slug: "widgets", path: REPO }).id;
  delegatedMachineId = ctx.machineStore.upsertLocal().id;
  const now = Date.now();
  ctx.db.run(
    `INSERT INTO people (id, display_name, created_at, origin, rev, updated_at)
     VALUES (?, 'Confined collaborator', ?, 'local', 0, ?)`,
    [DELEGATED_PERSON, now, now],
  );
  const owner = ctx.db.query("SELECT person_id FROM installation_owners WHERE is_default = 1").get() as
    | { person_id: string }
    | null;
  if (!owner) throw new Error("test installation has no owner");
  ctx.db.run(
    `INSERT INTO machine_repository_authorizations
       (id, machine_id, repository_key, authorized_by_person_id, authorized_at)
     VALUES ('machine-repo-confined', ?, 'github.com/acme/widgets', ?, ?)`,
    [delegatedMachineId, owner.person_id, now],
  );
  ctx.db.run(
    `INSERT INTO delegated_node_authorizations
       (id, capability_id, credential_hash, subject_person_id, subject_device_id, machine_id,
        repository_key, model, effort, max_duration_minutes, max_attempts, fanout,
        authorized_by_person_id, authorized_at)
     VALUES ('node-auth-confined', ?, ?, ?, ?, ?,
       'github.com/acme/widgets', 'gpt-5', 'medium', 10, 1, 1, ?, ?)`,
    [DELEGATED_CAPABILITY, hashToken(DELEGATED_TOKEN), DELEGATED_PERSON, DELEGATED_DEVICE, delegatedMachineId, owner.person_id, now],
  );

  const { createNodesRouter } = await import("../../server/routes/nodes");
  const { createTasksRouter } = await import("../../server/routes/tasks");
  const tasksRouter = createTasksRouter(ctx);
  router = createNodesRouter(ctx, {
    deleteBoardTask: (pid, taskId) => {
      const url = new URL(`http://h/api/boards/${pid}/tasks/${taskId}`);
      return tasksRouter(new Request(url, { method: "DELETE" }), url, url.pathname, "DELETE");
    },
    taskModels: () => ["gpt-5", "gpt-mini"],
  });
});

afterAll(async () => {
  await cleanupTestDataDir(ROOT);
});

describe("nodes routes: ingress of a mirrored card", () => {
  test("catalog bootstrap reports node models but creates no execution authority", async () => {
    const requested = await call("POST", "/api/nodes/delegated-requests", {
      purpose: "catalog",
      repositoryKey: "github.com/acme/widgets",
      originMachineId: "origin-machine-different-uuid",
    });
    expect(requested.status).toBe(201);
    const opened = await requested.json();
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_authorizations").get()).toEqual({ n: 1 });

    const approved = await call("POST", `/api/nodes/delegated-requests/${opened.requestId}/approve`, { projectId });
    expect(approved.status).toBe(200);
    const claim = await call("GET", `/api/nodes/delegated-requests/${opened.requestId}/claim?claim=${opened.claim}`);
    expect(await claim.json()).toMatchObject({ state: "approved", models: ["gpt-5", "gpt-mini"] });
    expect(claim.headers.get("set-cookie")).toBeNull();
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_authorizations").get()).toEqual({ n: 1 });

    expect((await call("POST", "/api/nodes/delegated-runs", delegatedBody({ originTaskId: "catalog-cannot-run" }))).status)
      .toBe(403);
    expect((await call("POST", `/api/nodes/delegated-requests/${opened.requestId}/ack?claim=${opened.claim}`)).status).toBe(200);
    const originalIp = ctx.requestIp;
    const originalIdentity = ctx.requestIdentity;
    ctx.requestIp = () => "203.0.113.20";
    ctx.requestIdentity = () => null;
    try {
      expect((await call("DELETE", `/api/nodes/delegated-requests/${opened.requestId}`)).status).toBe(403);
      expect((await call("DELETE", `/api/nodes/delegated-requests/${opened.requestId}?claim=${opened.claim}`)).status).toBe(200);
    } finally {
      ctx.requestIp = originalIp;
      ctx.requestIdentity = originalIdentity;
    }
  });

  test("an authorization for a model absent from the node catalog cannot be approved", async () => {
    const requested = await call("POST", "/api/nodes/delegated-requests", {
      purpose: "authorization",
      capabilityId: "cap-unavailable-model",
      repositoryKey: "github.com/acme/widgets",
      originPersonId: "origin-person",
      originDeviceId: "origin-device",
      originMachineId: "origin-machine",
      model: "model-not-installed-on-node",
      effort: "medium",
      maxDurationMinutes: 10,
    });
    expect(requested.status).toBe(201);
    const opened = await requested.json();
    const approved = await call("POST", `/api/nodes/delegated-requests/${opened.requestId}/approve`, { projectId });
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ code: "model_unavailable" });
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_authorizations WHERE capability_id='cap-unavailable-model'").get())
      .toEqual({ n: 0 });
  });

  test("handshake delegato crea grant repo e credenziale confinata soltanto dopo approvazione owner", async () => {
    const requested = await call("POST", "/api/nodes/delegated-requests", {
      purpose: "authorization",
      capabilityId: "cap-handshake",
      repositoryKey: "github.com/acme/widgets",
      originPersonId: "origin-person",
      originDeviceId: "origin-device",
      originMachineId: "origin-machine",
      model: "gpt-5",
      effort: "medium",
      maxDurationMinutes: 10,
    });
    expect(requested.status).toBe(201);
    const opened = await requested.json();
    expect(opened.claim).toBeString();
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_authorizations WHERE capability_id='cap-handshake'").get())
      .toEqual({ n: 0 });

    const pending = await (await call("GET", "/api/nodes/delegated-requests")).json();
    expect(pending.requests.find((r: any) => r.id === opened.requestId)).toMatchObject({
      capabilityId: "cap-handshake", state: "pending", repositoryKey: "github.com/acme/widgets",
    });
    expect(JSON.stringify(pending)).not.toContain(opened.claim);

    const approved = await call("POST", `/api/nodes/delegated-requests/${opened.requestId}/approve`, { projectId });
    expect(approved.status).toBe(200);
    const authorization = ctx.db.query(`SELECT id,subject_person_id,subject_device_id,machine_id,expires_at
      FROM delegated_node_authorizations WHERE capability_id='cap-handshake'`).get() as any;
    expect(authorization).toMatchObject({ subject_person_id: "origin-person", subject_device_id: "origin-device" });
    expect(authorization.machine_id).toBe(delegatedMachineId);
    expect(authorization.expires_at).toBeGreaterThan(Date.now());

    const claim = await call("GET", `/api/nodes/delegated-requests/${opened.requestId}/claim?claim=${opened.claim}`);
    expect(claim.status).toBe(200);
    expect(claim.headers.get("set-cookie")).toContain("topics_device=");
    const claimBody = await claim.json();
    expect(claimBody).toMatchObject({ state: "approved", authorizationId: authorization.id });
    expect(JSON.stringify(claimBody)).not.toContain("token");
    {
      const firstCookie = claim.headers.get("set-cookie");
      const recovered = await call("GET", `/api/nodes/delegated-requests/${opened.requestId}/claim?claim=${opened.claim}`);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ state: "approved", authorizationId: authorization.id });
      expect(recovered.headers.get("set-cookie")).not.toBe(firstCookie);
      expect(ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_authorizations WHERE capability_id='cap-handshake'").get())
        .toEqual({ n: 1 });
      const recoveredCookie = recovered.headers.get("set-cookie");
      expect(resolveDelegatedCredential(ctx.db, recoveredCookie, "cap-handshake")).not.toBeNull();
      ctx.db.query("UPDATE delegated_node_authorizations SET expires_at=? WHERE id=?").run(Date.now() - 1, authorization.id);
      expect(resolveDelegatedCredential(ctx.db, recoveredCookie, "cap-handshake")).toBeNull();
      ctx.db.query("UPDATE delegated_node_authorizations SET expires_at=? WHERE id=?").run(Date.now() + 60_000, authorization.id);
    }
    expect((await call("POST", `/api/nodes/delegated-requests/${opened.requestId}/ack?claim=${opened.claim}`)).status).toBe(200);
    const claimedAgain = await call("GET", `/api/nodes/delegated-requests/${opened.requestId}/claim?claim=${opened.claim}`);
    expect(await claimedAgain.json()).toEqual({ state: "active" });
    expect(claimedAgain.headers.get("set-cookie")).toBeNull();

    const replacement = await (await call("POST", "/api/nodes/delegated-requests", {
      purpose: "authorization",
      capabilityId: "cap-handshake",
      repositoryKey: "github.com/acme/widgets",
      originPersonId: "origin-person",
      originDeviceId: "origin-device",
      originMachineId: "origin-machine",
      model: "gpt-5",
      effort: "low",
      maxDurationMinutes: 5,
    })).json();
    const originalIdentity = ctx.requestIdentity;
    ctx.requestIdentity = () => ({ role: "guest", deviceId: DELEGATED_DEVICE });
    expect((await call("POST", `/api/nodes/delegated-requests/${replacement.requestId}/approve`, { projectId })).status).toBe(403);
    ctx.requestIdentity = originalIdentity;
    expect((await call("POST", `/api/nodes/delegated-requests/${replacement.requestId}/approve`, { projectId })).status).toBe(200);
    const replaced = ctx.db.query("SELECT id,effort,max_duration_minutes FROM delegated_node_authorizations WHERE capability_id='cap-handshake'").get();
    expect(replaced).toEqual({ id: authorization.id, effort: "low", max_duration_minutes: 5 });
    expect(ctx.db.query("SELECT state FROM delegated_node_requests WHERE id=?").get(opened.requestId)).toEqual({ state: "revoked" });
  });

  test("POST crea la card specchiata in todo con la nota d'origine, e un secondo POST torna lo stesso runId", async () => {
    const first = await mirror("origin-task-1");
    expect(first.status).toBe(201);
    expect(first.body.projectId).toBe(projectId);
    const runId = first.body.runId as string;

    const { createTaskService } = await import("../../server/services/tasks");
    const got = createTaskService(ctx.db).get(runId)!;
    expect(got.task.status).toBe("todo");
    expect(got.task.projectId).toBe(projectId);
    const service = got.comments.filter((c) => c.kind === "service");
    expect(service.length).toBe(1);
    expect(service[0].content).toContain("github.com/acme/widgets");
    expect(service[0].content).toContain("origin-task-1");

    const again = await mirror("origin-task-1", ORIGIN_SSH);
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(runId);
    expect(createTaskService(ctx.db).get(runId)!.comments.filter((c) => c.kind === "service").length).toBe(1);
  });

  test("un'origine che nessun progetto conosce risponde no_such_repo e non crea progetti", async () => {
    const before = ctx.projectStore.list().length;
    const r = await mirror("origin-task-unknown", "https://github.com/acme/nowhere.git");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("no_such_repo");
    expect(ctx.projectStore.list().length).toBe(before);
  });

  test("GET riporta ramo, commit, baseSha e diffstat della consegna, e il cursore since e' inclusivo", async () => {
    const { body } = await mirror("origin-task-2");
    const runId = body.runId as string;
    const { createTaskService } = await import("../../server/services/tasks");
    const svc = createTaskService(ctx.db);
    svc.update({ taskId: runId, actor: "human", by: "user", patch: { status: "review" }, projectId });
    svc.recordDelivery({ taskId: runId, branch: DELIVERY_BRANCH, commit: deliverySha, stat: { filesChanged: 1, insertions: 1, deletions: 0 } });

    const resp = await call("GET", `/api/nodes/runs/${runId}`);
    expect(resp.status).toBe(200);
    const run = await resp.json();
    expect(run.status).toBe("review");
    expect(run.deliveryBranch).toBe(DELIVERY_BRANCH);
    expect(run.deliveryCommit).toBe(deliverySha);
    expect(run.baseSha).toBe(mainSha);
    expect(run.commitCount).toBe(1);
    expect(run.stat).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
    const service = run.comments.find((c: any) => c.kind === "service");
    expect(service.id).toBeTruthy();

    const sinceIt = await (await call("GET", `/api/nodes/runs/${runId}?since=${encodeURIComponent(service.createdAt)}`)).json();
    expect(sinceIt.comments.map((c: any) => c.id)).toContain(service.id);
    const sinceLater = await (await call("GET", `/api/nodes/runs/${runId}?since=9999-01-01T00:00:00.000Z`)).json();
    expect(sinceLater.comments).toEqual([]);
  });

  test("il bundle passa git bundle verify e pianta il ramo in un secondo clone", async () => {
    const { body } = await mirror("origin-task-2");
    const resp = await call("GET", `/api/nodes/runs/${body.runId}/bundle`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/octet-stream");
    expect(resp.headers.get("x-topics-base-sha")).toBe(mainSha);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    const bundlePath = join(ROOT, "run.bundle");
    writeFileSync(bundlePath, bytes);

    const verify = git(CLONE, "bundle", "verify", bundlePath);
    expect(verify).toContain(mainSha);
    git(CLONE, "fetch", "-q", bundlePath, `${DELIVERY_BRANCH}:refs/heads/${DELIVERY_BRANCH}`);
    expect(git(CLONE, "rev-parse", `refs/heads/${DELIVERY_BRANCH}`)).toBe(deliverySha);
  });

  test("una card senza commit risponde empty con il baseSha", async () => {
    const { body } = await mirror("origin-task-3");
    const { createTaskService } = await import("../../server/services/tasks");
    createTaskService(ctx.db).recordDelivery({ taskId: body.runId, branch: EMPTY_BRANCH, commit: null });
    const resp = await call("GET", `/api/nodes/runs/${body.runId}/bundle`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ empty: true, baseSha: mainSha });

    const never = await mirror("origin-task-4");
    const noBranch = await call("GET", `/api/nodes/runs/${never.body.runId}/bundle`);
    expect(await noBranch.json()).toEqual({ empty: true, baseSha: mainSha });
  });

  test("DELETE archivia, e' idempotente, e libera la chiave per una corsa nuova", async () => {
    const { body } = await mirror("origin-task-5");
    const runId = body.runId as string;
    expect((await call("DELETE", `/api/nodes/runs/${runId}`)).status).toBe(200);
    const row = ctx.db.query("SELECT archived FROM tasks WHERE id = ?").get(runId) as { archived: number };
    expect(row.archived).toBe(1);
    expect((await call("DELETE", `/api/nodes/runs/${runId}`)).status).toBe(200);
    expect((await call("DELETE", "/api/nodes/runs/not-a-run")).status).toBe(404);

    const rerun = await mirror("origin-task-5");
    expect(rerun.status).toBe(201);
    expect(rerun.body.runId).not.toBe(runId);
  });

  test("un dispositivo ospite riceve 403 su ogni rotta", async () => {
    const original = ctx.requestIdentity;
    ctx.requestIdentity = () => ({ role: "guest", deviceId: "guest-device" });
    try {
      expect((await call("GET", "/api/nodes/runs/whatever")).status).toBe(403);
      expect((await mirror("origin-task-guest")).status).toBe(403);
      expect((await call("DELETE", "/api/nodes/runs/whatever")).status).toBe(403);
    } finally {
      ctx.requestIdentity = original;
    }
  });

  test("il percorso confinato lega identita, repository e run id senza dare poteri owner", async () => {
    const original = ctx.requestIdentity;
    ctx.requestIdentity = () => ({
      role: "guest", deviceId: null, delegatedAuthorizationId: "node-auth-confined",
      delegatedCapabilityId: DELEGATED_CAPABILITY,
    });
    try {
      const created = await call("POST", "/api/nodes/delegated-runs", delegatedBody(), DELEGATED_HEADERS);
      expect(created.status).toBe(201);
      const { runId } = await created.json() as { runId: string };

      expect((await call("GET", `/api/nodes/delegated-runs/${runId}`, undefined, DELEGATED_HEADERS)).status).toBe(200);
      expect((await call("GET", "/api/nodes/delegated-runs/not-this-run", undefined, DELEGATED_HEADERS)).status).toBe(404);
      expect((await call("DELETE", "/api/nodes/delegated-runs/not-this-run", undefined, DELEGATED_HEADERS)).status).toBe(404);
      expect((await call("GET", "/api/nodes/delegated-runs/not-this-run/bundle", undefined, DELEGATED_HEADERS)).status).toBe(404);
    } finally {
      ctx.requestIdentity = original;
    }
  });

  test("mismatch di repository o identita viene negato prima di creare una card", async () => {
    const original = ctx.requestIdentity;
    const beforeTasks = (ctx.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const beforeBindings = (ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_runs").get() as { n: number }).n;
    ctx.requestIdentity = () => ({ role: "guest", deviceId: null, delegatedAuthorizationId: "node-auth-confined" });
    try {
      const wrongRepo = delegatedBody({
        originTaskId: "origin-wrong-repo",
        originUrl: "https://github.com/acme/other.git",
      });
      expect((await call("POST", "/api/nodes/delegated-runs", wrongRepo, DELEGATED_HEADERS)).status).toBe(403);

      const injectedPolicy = delegatedBody({
        originTaskId: "origin-wrong-device",
        model: "gpt-5",
      });
      expect((await call("POST", "/api/nodes/delegated-runs", injectedPolicy, DELEGATED_HEADERS)).status).toBe(400);
      expect((await call("POST", "/api/nodes/delegated-runs", delegatedBody({ originTaskId: "origin-wrong-capability" }), {
        ...DELEGATED_HEADERS, "x-topics-delegated-capability": "another-capability",
      })).status).toBe(403);
    } finally {
      ctx.requestIdentity = original;
    }
    expect((ctx.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(beforeTasks);
    expect((ctx.db.query("SELECT COUNT(*) AS n FROM delegated_node_runs").get() as { n: number }).n).toBe(beforeBindings);
  });

  test("il token owner resta valido solo sul percorso owner e non apre quello confinato", async () => {
    const original = ctx.requestIdentity;
    ctx.requestIdentity = () => ({ role: "owner", deviceId: "owner-device" });
    try {
      expect((await call("POST", "/api/nodes/delegated-runs", delegatedBody())).status).toBe(403);
      expect((await mirror("origin-owner-still-valid")).status).toBe(201);
    } finally {
      ctx.requestIdentity = original;
    }
  });

  test("revocation persists on the node run and a later read cannot revive it", async () => {
    const original = ctx.requestIdentity;
    ctx.requestIdentity = () => ({ role: "guest", deviceId: null, delegatedAuthorizationId: "node-auth-confined" });
    try {
      const created = await call("POST", "/api/nodes/delegated-runs", delegatedBody({ originTaskId: "origin-revoked" }), DELEGATED_HEADERS);
      expect(created.status).toBe(201);
      const { runId } = await created.json() as { runId: string };
      ctx.db.query("UPDATE delegated_node_authorizations SET revoked_at = ? WHERE id = 'node-auth-confined'").run(Date.now());

      expect((await call("GET", `/api/nodes/delegated-runs/${runId}`, undefined, DELEGATED_HEADERS)).status).toBe(404);
      const row = ctx.db.query("SELECT revoked_at FROM delegated_node_runs WHERE run_id = ?").get(runId) as
        { revoked_at: number | null };
      expect(row.revoked_at).not.toBeNull();
      expect((await call("GET", `/api/nodes/delegated-runs/${runId}`, undefined, DELEGATED_HEADERS)).status).toBe(404);
    } finally {
      ctx.requestIdentity = original;
    }
  });

  test("due installazioni sintetiche completano catalogo, approvazione, run e retry di revoca via endpoint", async () => {
    const originalIdentity = ctx.requestIdentity;
    let offlineDelete = false;
    const fetchNode = async (input: string, init: RequestInit = {}): Promise<Response> => {
      if (offlineDelete && init.method === "DELETE") throw new TypeError("node offline");
      const request = new Request(input, init);
      const url = new URL(input);
      const delegated = resolveDelegatedCredential(
        ctx.db,
        request.headers.get("cookie"),
        request.headers.get("x-topics-delegated-capability"),
      );
      ctx.requestIdentity = () => delegated ? {
        role: "guest", deviceId: null,
        delegatedAuthorizationId: delegated.authorizationId,
        delegatedCapabilityId: delegated.capabilityId,
      } : null;
      const response = await router(request, url, url.pathname, String(init.method ?? "GET"));
      if (!response) throw new Error(`node route missing: ${init.method} ${url.pathname}`);
      return response;
    };
    const remoteClient = createNodeClient({
      fetch: fetchNode, now: () => Date.now(), wait: async () => {}, version: "test", hostname: "origin-host",
    });
    const originNode = ctx.machineStore.upsertNode({
      hostname: "synthetic-node.invalid", name: "Synthetic node", baseUrl: "http://synthetic-node.invalid",
    });
    const originMachine = {
      ...ctx.machineStore.upsertLocal(), id: "origin-machine-distinct", hostname: "origin-host",
    };
    ctx.db.query(`INSERT OR IGNORE INTO machines
      (id,name,hostname,arch,platform,daemon_version,status,last_heartbeat_at,last_seen_at,created_at,updated_at)
      VALUES (?,?,?,'','','test','online',?,?,?,?)`).run(
      originMachine.id, "Origin", originMachine.hostname,
      originMachine.lastHeartbeatAt, originMachine.lastSeenAt, originMachine.createdAt, originMachine.updatedAt,
    );
    const originCtx = {
      ...ctx,
      nodeClient: remoteClient,
      requestIdentity: () => null,
      machineStore: { ...ctx.machineStore, upsertLocal: () => originMachine },
    } as AppContext;
    const { createMachinesRouter } = await import("../../server/routes/machines");
    const { createAuthRouter } = await import("../../server/routes/auth");
    const machines = createMachinesRouter(originCtx);
    const auth = createAuthRouter(originCtx, {
      repositoryKeyOf: async () => "github.com/acme/widgets",
      taskModels: () => ["gpt-5"],
    });
    const invoke = async (route: RouteHandler, method: string, path: string, body?: unknown) => {
      ctx.requestIdentity = originalIdentity;
      const url = new URL(`http://origin${path}`);
      const req = new Request(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const response = await route(req, url, url.pathname, method);
      if (!response) throw new Error(`origin route missing: ${method} ${path}`);
      return response;
    };

    try {
      const catalogOpened = await invoke(machines, "POST", "/api/machines/delegated-requests", {
        purpose: "catalog", machineId: originNode.id, projectId,
      });
      expect(catalogOpened.status).toBe(201);
      let catalogOrigin = (await catalogOpened.json()).request;
      const supersededCatalogNode = ctx.db.query(`SELECT id FROM delegated_node_requests
        WHERE direction='node' AND purpose='catalog' AND code=?`).get(catalogOrigin.code) as { id: string };
      const reissuedCatalog = await invoke(machines, "POST", `/api/machines/delegated-requests/${catalogOrigin.id}/reissue`);
      expect(reissuedCatalog.status).toBe(200);
      catalogOrigin = (await reissuedCatalog.json()).request;
      expect(ctx.db.query("SELECT state FROM delegated_node_requests WHERE id=?").get(supersededCatalogNode.id))
        .toEqual({ state: "revoked" });
      const catalogNode = ctx.db.query(`SELECT id FROM delegated_node_requests
        WHERE direction='node' AND purpose='catalog' AND code=?`).get(catalogOrigin.code) as { id: string };
      expect((await call("POST", `/api/nodes/delegated-requests/${catalogNode.id}/approve`, { projectId })).status).toBe(200);
      expect((await invoke(machines, "GET", `/api/machines/delegated-requests/${catalogOrigin.id}`)).status).toBe(200);
      const catalogRow = ctx.db.query(`SELECT models_json FROM machine_delegated_model_catalogs
        WHERE machine_id=? AND repository_key='github.com/acme/widgets'`).get(originNode.id) as { models_json: string };
      expect(JSON.parse(catalogRow.models_json)).toContain("gpt-5");

      const granted = await invoke(auth, "POST", "/api/auth/agent-start-capabilities", {
        projectId, subjectType: "person", subjectId: DELEGATED_PERSON,
        machineId: originNode.id, model: "gpt-5", effort: "medium", maxDurationMinutes: 10,
      });
      expect(granted.status).toBe(201);
      const capabilityId = (await granted.json()).capability.id as string;
      const authorizationOpened = await invoke(machines, "POST", "/api/machines/delegated-requests", {
        purpose: "authorization", machineId: originNode.id, capabilityId,
      });
      expect(authorizationOpened.status).toBe(201);
      const authorizationOrigin = (await authorizationOpened.json()).request;
      const authorizationNode = ctx.db.query(`SELECT id FROM delegated_node_requests
        WHERE direction='node' AND purpose='authorization' AND code=?`).get(authorizationOrigin.code) as { id: string };
      expect((await call("POST", `/api/nodes/delegated-requests/${authorizationNode.id}/approve`, { projectId })).status).toBe(200);
      expect(await (await invoke(machines, "GET", `/api/machines/delegated-requests/${authorizationOrigin.id}`)).json())
        .toMatchObject({ request: { state: "approved" } });
      expect(await (await invoke(machines, "GET", `/api/machines/delegated-requests/${authorizationOrigin.id}`)).json())
        .toMatchObject({ request: { state: "active" } });

      const token = readDelegatedNodeToken(ctx.STATE_DIR, originNode.id, capabilityId);
      expect(token).toBeString();
      const nodeAuthorization = ctx.db.query(`SELECT id,machine_id FROM delegated_node_authorizations
        WHERE capability_id=?`).get(capabilityId) as { id: string; machine_id: string };
      expect(nodeAuthorization.machine_id).toBe(delegatedMachineId);
      expect(nodeAuthorization.machine_id).not.toBe(originMachine.id);
      const delegation = { capabilityId, subjectPersonId: DELEGATED_PERSON, subjectDeviceId: `cap-${capabilityId}` };
      const created = await remoteClient.createRun({
        baseUrl: originNode.baseUrl!, token: token!, delegation,
        body: { originTaskId: "origin-two-installations", originUrl: ORIGIN_HTTPS, text: "remote real path", description: "", model: null, effort: null },
      });
      expect(created.runId).toBeString();

      offlineDelete = true;
      expect((await invoke(machines, "DELETE", `/api/machines/delegated-requests/${authorizationOrigin.id}`)).status).toBe(202);
      expect(ctx.db.query("SELECT revoke_pending FROM delegated_node_requests WHERE id=?").get(authorizationOrigin.id))
        .toEqual({ revoke_pending: 1 });
      offlineDelete = false;
      expect((await invoke(machines, "DELETE", `/api/machines/delegated-requests/${authorizationOrigin.id}`)).status).toBe(200);
      expect(ctx.db.query("SELECT revoked_at FROM delegated_node_authorizations WHERE id=?").get(nodeAuthorization.id))
        .toMatchObject({ revoked_at: expect.any(Number) });
    } finally {
      ctx.requestIdentity = originalIdentity;
    }
  });
});
