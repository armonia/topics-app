/**
 * POST /api/auth/shares now takes a `level`, not just an on/off grant - and
 * the route stays OWNER-ONLY: no guest reaches it, because the gate's path
 * allowlist does not name it.
 *
 * @covers GUEST-09, GUEST-10
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
