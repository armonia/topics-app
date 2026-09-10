/**
 * POST /api/auth/shares now takes a `level`, not just an on/off grant - and
 * the route stays OWNER-ONLY: no guest reaches it, because the gate's path
 * allowlist does not name it.
 *
 * @covers GUEST-09, GUEST-10, GUEST-11, GUEST-12
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createAuthRouter } from "./auth";
import { isGuestAllowedPath, isGuestAllowedMethod } from "../lib/grants";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS = [
  "080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql",
  "20260816230500-grants-project.sql", "20260909180634-grant-levels-write-scope.sql",
];

function dbFresco(): Database {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.run(readFileSync(join(ROOT, "server/db/migrations", m), "utf8"));
  // subjectRejection needs a real, non-revoked device row to accept the
  // share, or it reads the subject as unknown and 404s.
  for (const id of ["o1", "g1", "g2", "g3", "g4"]) {
    db.run(
      "INSERT INTO devices (id, name, token_hash, role, created_at) VALUES (?, ?, ?, 'guest', ?)",
      [id, id, `hash-${id}`, Date.now()],
    );
  }
  return db;
}

/** The two columns the inventory and the container lookup read. A full
 *  `TASKS_DDL` would drag in three FK parents for two SELECTs. */
function conTasks(db: Database): Database {
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL,
    project_id TEXT, preview_image TEXT)`);
  return db;
}

function task(db: Database, id: string, projectId: string | null): void {
  db.run("INSERT INTO tasks (id, text, status, project_id, preview_image) VALUES (?,?, 'todo', ?, NULL)",
    [id, `card ${id}`, projectId]);
}

function creaCtx(db: Database, identity: { role: "owner" | "guest"; deviceId: string } | null): AppContext {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    requestIdentity: () => identity,
    sendToDevice: () => {},
  } as unknown as AppContext;
}

function call(rotta: ReturnType<typeof createAuthRouter>, method: string, percorso: string, corpo?: unknown) {
  const url = new URL(`http://127.0.0.1:3333${percorso}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return rotta(req, url, url.pathname, method) as Promise<Response | null>;
}

describe("POST /api/auth/shares · il livello", () => {
  let db: Database;

  beforeEach(() => {
    db = dbFresco();
  });

  test("il default resta `read`, come prima di questo cambio", async () => {
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    const res = await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1",
    });
    expect(res?.status).toBe(200);
    const row = db.query("SELECT level FROM grants WHERE resource_id = 't1'").get() as { level: string };
    expect(row.level).toBe("read");
  });

  test("un livello esplicito viene registrato", async () => {
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    const res = await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level: "edit",
    });
    expect(res?.status).toBe(200);
    const row = db.query("SELECT level FROM grants WHERE resource_id = 't1'").get() as { level: string };
    expect(row.level).toBe("edit");
  });

  test("un livello inventato è rifiutato, 400", async () => {
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    const res = await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level: "publish",
    });
    expect(res?.status).toBe(400);
  });
});

describe("un livello che questa scala non conosce", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  // `run` and `manage` existed on this branch for a day, so a database can
  // hold a row that says so. Neither may be ASSIGNED any more: the refusal is
  // the same `unknown_level` as an invented word, because for this scale they
  // are the same thing.
  for (const level of ["run", "manage"]) {
    test(`\`${level}\` non e' piu' assegnabile: 400`, async () => {
      const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
      const res = await call(owner, "POST", "/api/auth/shares", {
        resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level,
      });
      expect(res?.status).toBe(400);
      expect((await res!.json()).error).toBe("unknown_level");
      expect(db.query("SELECT level FROM grants WHERE resource_id = 't1'").get()).toBeNull();
    });
  }
});

/**
 * THE ROUTE IS CLOSED AT THE GATE, and this is the test that says so.
 *
 * It asks the gate's own predicates rather than the router, because that is
 * where the refusal happens: the router below never sees a guest's request,
 * and a test that called it directly would be asking the wrong question - the
 * one the previous version of this file asked, stubbing `requestIdentity` so
 * the real chain was never crossed. The end-to-end half lives in
 * `tests/e2e/guest-confinement.spec.ts` (GUEST-10), which comes in from the
 * tunnel port with a real guest cookie.
 */
describe("GET/POST/DELETE /api/auth/shares · nessun ospite passa", () => {
  test("il percorso non e' nell'allowlist degli ospiti", () => {
    expect(isGuestAllowedPath("/api/auth/shares")).toBe(false);
    // The neighbours a guest DOES need stay open: the closure is this one
    // path, not the whole auth surface.
    expect(isGuestAllowedPath("/api/auth/shared")).toBe(true);
    expect(isGuestAllowedPath("/api/auth/session")).toBe(true);
    expect(isGuestAllowedPath("/api/auth/logout")).toBe(true);
  });

  test("nemmeno in lettura: era il ramo senza alcun controllo di livello", () => {
    // GET is the branch that had no level check of its own, and the gate
    // matches ids in the PATH while this route names its resource in the
    // QUERY. Closed as a path, the query cannot be reached at all.
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(isGuestAllowedMethod("/api/auth/shares", method) && isGuestAllowedPath("/api/auth/shares")).toBe(false);
    }
  });
});

/**
 * THE INVENTORY CARRIES THE LEVEL, because it is the only door a guest's
 * application has.
 *
 * `/api/auth/shared` answered `{ tasks, topics }` with no `level` in it, so a
 * device granted `comment` or `edit` had no way to know: the guest screen
 * printed "read only" at everybody and offered no way to write, while the
 * server enforced a scale of three. Two sentences on the two sides of one
 * permission, saying opposite things.
 */
describe("GET /api/auth/shared · il livello viaggia con la riga", () => {
  let db: Database;
  beforeEach(() => { db = conTasks(dbFresco()); });

  test("una scheda condivisa a `edit` si legge `edit`, non `read`", async () => {
    task(db, "t1", null);
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level: "edit",
    });
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g1" }));
    const body = await (await call(guest, "GET", "/api/auth/shared"))!.json() as
      { tasks: Array<{ id: string; level: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].level).toBe("edit");
  });

  test("e una condivisa a `read` resta `read`: il campo non e' decorativo", async () => {
    task(db, "t1", null);
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level: "read",
    });
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g1" }));
    const body = await (await call(guest, "GET", "/api/auth/shared"))!.json() as
      { tasks: Array<{ level: string }> };
    expect(body.tasks[0].level).toBe("read");
  });
});

/**
 * A CARD REACHED THROUGH ITS PROJECT IS NOT "SHARED WITH NOBODY".
 *
 * `subjectsOf` answers with the rows written ON the resource, and that was the
 * whole panel: the card of a shared project carried no row of its own, so the
 * owner was told nobody could see it while somebody was reading it. An access
 * with no surface to see it on has no surface to revoke it from either.
 */
describe("GET /api/auth/shares · chi arriva dal progetto", () => {
  let db: Database;
  beforeEach(() => { db = conTasks(dbFresco()); });

  test("la riga del progetto compare sulla scheda, e dice DA DOVE arriva", async () => {
    task(db, "t1", "P");
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    await call(owner, "POST", "/api/auth/shares", {
      resourceType: "project", resourceId: "P", subjectType: "device", subjectId: "g1", level: "edit",
    });
    const body = await (await call(owner, "GET", "/api/auth/shares?resourceType=task&resourceId=t1"))!.json() as
      { shares: Array<{ subjectId: string; level: string; viaType?: string; viaId?: string }> };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].subjectId).toBe("g1");
    expect(body.shares[0].viaType).toBe("project");
    expect(body.shares[0].viaId).toBe("P");
    // The level the GATE applies, not the word in the project's row: a
    // container conveys `read` and no more.
    expect(body.shares[0].level).toBe("read");
  });

  test("una riga DIRETTA sulla scheda vince, e il soggetto compare una volta sola", async () => {
    task(db, "t1", "P");
    const owner = createAuthRouter(creaCtx(db, { role: "owner", deviceId: "o1" }));
    await call(owner, "POST", "/api/auth/shares", {
      resourceType: "project", resourceId: "P", subjectType: "device", subjectId: "g1", level: "read",
    });
    await call(owner, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g1", level: "edit",
    });
    const body = await (await call(owner, "GET", "/api/auth/shares?resourceType=task&resourceId=t1"))!.json() as
      { shares: Array<{ subjectId: string; level: string; viaType?: string }> };
    expect(body.shares, "due livelli per un accesso solo sarebbero due risposte alla stessa domanda").toHaveLength(1);
    expect(body.shares[0].level).toBe("edit");
    expect(body.shares[0].viaType).toBeUndefined();
  });
});
