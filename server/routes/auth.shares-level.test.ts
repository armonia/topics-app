/**
 * POST /api/auth/shares now takes a `level`, not just an on/off grant, and a
 * guest can call it too, but only on a resource where its own device
 * already holds `manage` on it.
 *
 * @covers GUEST-09
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createAuthRouter } from "./auth";
import { putGrant } from "../lib/grants-query";

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

describe("POST/DELETE /api/auth/shares · un ospite con `manage`", () => {
  let db: Database;

  beforeEach(() => {
    db = dbFresco();
    putGrant(db, { kind: "device", id: "g1" }, "task", "t1", { level: "manage", grantedAt: Date.now() });
  });

  test("può condividere la STESSA risorsa con un terzo", async () => {
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g1" }));
    const res = await call(guest, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "g2", level: "comment",
    });
    expect(res?.status).toBe(200);
    const row = db.query("SELECT level FROM grants WHERE resource_id = 't1' AND subject_id = 'g2'").get() as { level: string };
    expect(row.level).toBe("comment");
  });

  test("non può toccare una risorsa dove non ha `manage`", async () => {
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g1" }));
    const res = await call(guest, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "altro-task", subjectType: "device", subjectId: "g2", level: "read",
    });
    expect(res?.status).toBe(403);
  });

  test("con solo `edit` (non `manage`) resta fuori", async () => {
    putGrant(db, { kind: "device", id: "g3" }, "task", "t2", { level: "edit", grantedAt: Date.now() });
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g3" }));
    const res = await call(guest, "POST", "/api/auth/shares", {
      resourceType: "task", resourceId: "t2", subjectType: "device", subjectId: "g4", level: "read",
    });
    expect(res?.status).toBe(403);
  });

  test("può anche revocare, sulla stessa risorsa", async () => {
    putGrant(db, { kind: "device", id: "g2" }, "task", "t1", { level: "read", grantedAt: Date.now() });
    const guest = createAuthRouter(creaCtx(db, { role: "guest", deviceId: "g1" }));
    const url = new URL("http://127.0.0.1:3333/api/auth/shares?resourceType=task&resourceId=t1&subjectType=device&subjectId=g2");
    const req = new Request(url, { method: "DELETE" });
    const res = await guest(req, url, url.pathname, "DELETE");
    expect(res?.status).toBe(200);
    const row = db.query("SELECT * FROM grants WHERE resource_id = 't1' AND subject_id = 'g2'").get();
    expect(row).toBeNull();
  });
});
