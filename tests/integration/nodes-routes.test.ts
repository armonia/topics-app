/**
 * The ingress of a mirrored card on a NODE: `/api/nodes/runs`.
 *
 * A real temporary git repository stands in for the node's checkout, with a
 * delivery branch one commit ahead of `main`, so the bundle that comes back
 * is verified by git itself and planted into a second clone: the round trip
 * of KANBAN-76 "il ramo torna come bundle", not a stub of it.
 *
 * @covers KANBAN-76
 * @covers MACHINE-02
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
import type { AppContext, RouteHandler } from "../../server/types";
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

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const resp = await router(req, url, url.pathname, method);
  if (!resp) throw new Error(`no route for ${method} ${path}`);
  return resp;
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
  projectId = ctx.projectStore.create({ name: "widgets", slug: "widgets", path: REPO }).id;

  const { createNodesRouter } = await import("../../server/routes/nodes");
  const { createTasksRouter } = await import("../../server/routes/tasks");
  const tasksRouter = createTasksRouter(ctx);
  router = createNodesRouter(ctx, {
    deleteBoardTask: (pid, taskId) => {
      const url = new URL(`http://h/api/boards/${pid}/tasks/${taskId}`);
      return tasksRouter(new Request(url, { method: "DELETE" }), url, url.pathname, "DELETE");
    },
  });
});

afterAll(async () => {
  await cleanupTestDataDir(ROOT);
});

describe("nodes routes: ingress of a mirrored card", () => {
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
});
