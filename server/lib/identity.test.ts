/**
 * La traduzione cookie → chi sei, che ora è UNA.
 *
 * Il valore di questo file non è coprire dei rami: è che il cancello HTTP,
 * l'upgrade del WebSocket e `/api/auth/session` chiamino la stessa funzione e
 * quindi non possano più rispondere cose diverse. Divergevano davvero, due
 * volte, e in entrambi i casi la strada sbagliata era quella che nessuno
 * guarda — il WebSocket e il tunnel.
 *
 * No cookie is nobody and stays confined; a cookie matching no device opens
 * nothing.
 *
 * @covers GUEST-03
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveIdentity, confinamentoDerivato } from "./identity";
import { hashToken, buildSessionCookie } from "./device-auth";
import { TASKS_DDL } from "../db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");

function db084(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
  for (const m of ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"]) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

function aggiungi(db: Database, opts: {
  id: string; token: string; role?: "owner" | "guest"; revoked?: number | null; personId?: string | null;
}) {
  db.query("INSERT INTO devices (id, name, token_hash, created_at, role, revoked_at, person_id) VALUES (?,?,?,?,?,?,?)")
    .run(opts.id, opts.id, hashToken(opts.token), 1, opts.role ?? "owner", opts.revoked ?? null, opts.personId ?? null);
}

/** L'header `Cookie` come lo manderebbe un browser. */
function cookie(token: string): string {
  return buildSessionCookie(token, { secure: false }).split(";")[0];
}

describe("identità · il percorso locale non tocca il database", () => {
  it("locale = la macchina, senza cookie e senza query", () => {
    const db = db084();
    const io = resolveIdentity(db, null, true);
    expect(io).toEqual({ locale: true, device: null, principals: [], confined: false, personId: null });
  });

  it("e vale anche se un cookie c'è: sul locale non lo si legge nemmeno", () => {
    // È la rete anti-lockout della 080: una tabella di identità corrotta non
    // deve poter chiudere fuori il proprietario da casa sua.
    const db = db084();
    aggiungi(db, { id: "d1", token: "t1", role: "guest" });
    const io = resolveIdentity(db, cookie("t1"), true);
    expect(io.locale).toBe(true);
    expect(io.confined).toBe(false);
  });
});

describe("identità · da remoto", () => {
  let db: Database;
  beforeEach(() => { db = db084(); });

  it("senza cookie non sei nessuno, e sei confinato", () => {
    const io = resolveIdentity(db, null, false);
    expect(io.device).toBeNull();
    expect(io.confined).toBe(true);
  });

  it("un cookie che non corrisponde a niente non apre nulla", () => {
    aggiungi(db, { id: "d1", token: "vero" });
    const io = resolveIdentity(db, cookie("falso"), false);
    expect(io.device).toBeNull();
    expect(io.confined).toBe(true);
  });

  it("un dispositivo REVOCATO si riconosce, e non porta poteri", () => {
    // La riga si restituisce apposta: serve a dire «ti è stato tolto l'accesso»
    // invece di «non ti conosco», che per chi legge sono due cose diverse.
    aggiungi(db, { id: "d1", token: "t1", revoked: 999 });
    const io = resolveIdentity(db, cookie("t1"), false);
    expect(io.device?.id).toBe("d1");
    expect(io.principals).toEqual([]);
    expect(io.confined).toBe(true);
  });

  it("un proprietario porta i suoi principali e non è confinato", () => {
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p1','Io',1,'local',1,1)").run();
    db.query("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('p1',1,0)").run();
    aggiungi(db, { id: "d1", token: "t1", role: "owner", personId: "p1" });

    const io = resolveIdentity(db, cookie("t1"), false);
    expect(io.confined).toBe(false);
    expect(io.personId).toBe("p1");
    expect(io.principals.map((p) => `${p.kind}:${p.id}`).sort()).toEqual(["device:d1", "person:p1"]);
  });

  it("un ospite è confinato e porta comunque i suoi principali", () => {
    // Confinato non vuol dire cieco: ciò che gli è stato condiviso lo vede, e
    // per vederlo servono i principali.
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p9','Ospite',1,'local',1,1)").run();
    aggiungi(db, { id: "d9", token: "t9", role: "guest", personId: "p9" });

    const io = resolveIdentity(db, cookie("t9"), false);
    expect(io.confined).toBe(true);
    expect(io.principals.map((p) => p.kind)).toContain("person");
  });
});

describe("identità · il confinamento derivato, che un giorno comanderà", () => {
  it("coincide col ruolo quando la persona è proprietaria", () => {
    const db = db084();
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p1','Io',1,'local',1,1)").run();
    db.query("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('p1',1,0)").run();
    aggiungi(db, { id: "d1", token: "t1", role: "owner", personId: "p1" });
    expect(confinamentoDerivato(db, "d1")).toBe(false);
  });

  it("e quando NON lo è: un collega resta ospite anche se è nella tua organizzazione", () => {
    const db = db084();
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('c1','Collega',1,'local',1,1)").run();
    db.query("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('o1','Team',1,'local',1,1)").run();
    db.query("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('o1','c1','member',1,1,1)").run();
    aggiungi(db, { id: "d9", token: "t9", role: "guest", personId: "c1" });
    expect(confinamentoDerivato(db, "d9")).toBe(true);
  });
});
