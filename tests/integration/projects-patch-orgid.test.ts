/**
 * `PATCH /api/projects/:id` gains `orgId`: an owner can pull a legacy
 * (pre-092, `org_id` NULL) project into the installation's own organisation,
 * or take a shared one back to personal — the same lever `incognito` already
 * has, but for the column that decides who is a candidate at all.
 * @covers PROJECT-13
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectsRouter } from "../../server/routes/projects";
import { createProjectStore } from "../../server/services/project-store";
import type { RouteHandler } from "../../server/types";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS = [
  "016-projects.sql", "080-devices.sql", "082-task-shares.sql", "083-grants.sql",
  "084-people-orgs.sql", "092-project-org-incognito.sql",
];

function realDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT)");
  for (const m of MIGRATIONS) db.run(readFileSync(join(ROOT, "server", "db", "migrations", m), "utf8"));
  return db;
}

function bootstrap(db: Database) {
  const org = (db.query("SELECT org_id FROM installation WHERE singleton = 1").get() as { org_id: string });
  const owner = (db.query("SELECT person_id FROM installation_owners WHERE is_default = 1").get() as
    { person_id: string });
  return { orgId: org.org_id, ownerPersonId: owner.person_id };
}

function addMember(db: Database, id: string, orgId: string): string {
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [id, id]);
  db.run(
    "INSERT INTO org_members (org_id, person_id, role, joined_at, updated_at) VALUES (?, ?, 'member', 0, 0)",
    [orgId, id],
  );
  const dev = `dev-${id}`;
  db.run(
    `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, role, person_id)
     VALUES (?, ?, ?, 0, 0, 'owner', ?)`,
    [dev, `machine-${id}`, `hash-${id}`, id],
  );
  return dev;
}

function makeCtx(db: Database, deviceId: string | null): never {
  return {
    db,
    projectStore: createProjectStore(db),
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    errorResponse: (status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }),
    matchRoute: (pathname: string, pattern: string) => {
      const p = pattern.split("/"), a = pathname.split("/");
      if (p.length !== a.length) return null;
      const out: Record<string, string> = {};
      for (let i = 0; i < p.length; i++) {
        if (p[i]!.startsWith(":")) out[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
        else if (p[i] !== a[i]) return null;
      }
      return out;
    },
    broadcastToAll: () => {},
    broadcastProject: () => {},
    requestIdentity: () => (deviceId ? { role: "owner", deviceId } : null),
  } as never;
}

function call(router: RouteHandler, path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

describe("PATCH /api/projects/:id accepts orgId, owner-only", () => {
  let db: Database;
  let orgId: string;
  let ownerPersonId: string;
  let devMate: string;

  beforeEach(() => {
    db = realDb();
    ({ orgId, ownerPersonId } = bootstrap(db));
    devMate = addMember(db, "mate", orgId);
  });

  test("the owner pulls a legacy project into the org", async () => {
    const store = createProjectStore(db);
    const legacy = store.create({ name: "Legacy", slug: "legacy", path: "/tmp/legacy", ownerPersonId });
    expect(legacy.orgId).toBeNull();

    const router = createProjectsRouter(makeCtx(db, null));
    const r = await call(router, `/api/projects/${legacy.id}`, "PATCH", { orgId });
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { orgId: string | null }).orgId).toBe(orgId);
    expect(store.get(legacy.id)!.orgId).toBe(orgId);
  });

  test("a project with NO recorded owner cannot be handed to the org, by anybody", async () => {
    // THE CASE EVERY OTHER TEST HERE MISSES. All of them create the project
    // WITH an `ownerPersonId`, so none of them ever reached the branch where
    // the owner is unknown - and that branch used to let the write through for
    // any caller, because the guard read `if (owner && owner !== acting)`.
    // Projects created before migration 092 have no owner recorded: they are
    // the population this lever is for, so the permissive branch was the main
    // case and not an edge.
    const store = createProjectStore(db);
    const orphan = store.create({ name: "Orphan", slug: "orphan-org", path: "/tmp/orphan-org" });
    expect(orphan.ownerPersonId ?? null).toBeNull();

    // Not even the person who bootstrapped the installation: the refusal is
    // about what can be PROVEN, not about who is asking.
    const router = createProjectsRouter(makeCtx(db, null));
    const r = await call(router, `/api/projects/${orphan.id}`, "PATCH", { orgId });
    expect(r!.status).toBe(403);
    expect(await r!.text()).toContain("no recorded owner");
    expect(store.get(orphan.id)!.orgId).toBeNull();

    // And the same body without `orgId` still works: the refusal is scoped to
    // the sharing lever, it does not freeze the whole project.
    const rename = await call(router, `/api/projects/${orphan.id}`, "PATCH", { name: "Orphan renamed" });
    expect(rename!.status).toBe(200);
    expect(store.get(orphan.id)!.name).toBe("Orphan renamed");
  });

  test("the owner takes a shared project back to personal", async () => {
    const store = createProjectStore(db);
    const shared = store.create({ name: "Shared", slug: "shared", path: "/tmp/shared", orgId, ownerPersonId });
    const router = createProjectsRouter(makeCtx(db, null));
    const r = await call(router, `/api/projects/${shared.id}`, "PATCH", { orgId: null });
    expect(r!.status).toBe(200);
    expect(store.get(shared.id)!.orgId).toBeNull();
  });

  test("a non-owner's PATCH with orgId is refused, row untouched", async () => {
    const store = createProjectStore(db);
    // Shared already, so the teammate can even SEE the row — the refusal has
    // to come from ownership, not from visibility hiding it as a 404.
    const shared = store.create({ name: "Shared", slug: "shared2", path: "/tmp/shared2", orgId, ownerPersonId });
    const router = createProjectsRouter(makeCtx(db, devMate));
    const r = await call(router, `/api/projects/${shared.id}`, "PATCH", { orgId: null });
    expect(r!.status).toBe(403);
    expect(store.get(shared.id)!.orgId).toBe(orgId);
  });

  test("an org id that is not this installation's own is rejected", async () => {
    db.run("INSERT INTO orgs (id, name, created_at, updated_at) VALUES ('other-org', 'Other', 0, 0)");
    const store = createProjectStore(db);
    const legacy = store.create({ name: "Legacy", slug: "legacy3", path: "/tmp/legacy3", ownerPersonId });
    const router = createProjectsRouter(makeCtx(db, null));
    const r = await call(router, `/api/projects/${legacy.id}`, "PATCH", { orgId: "other-org" });
    expect(r!.status).toBe(400);
    expect(store.get(legacy.id)!.orgId).toBeNull();
  });
});
