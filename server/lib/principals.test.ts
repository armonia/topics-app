/**
 * I principali di un dispositivo, contro lo schema vero (080 → 084).
 *
 * Il caso che vale più di tutti è quello che non si vede: OGNI ramo deve cadere
 * verso MENO poteri. Sbagliare verso qui non produce un errore — produce un
 * ospite che vede tutto, e nessuno se ne accorge finché non è tardi.
 *
 * Device to person to organizations: the chain that makes a grant written
 * for a PERSON confine exactly like one written for the device.
 *
 * @covers GUEST-06
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePrincipals, principalsRev } from "./principals";
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

function dispositivo(db: Database, id: string, personId: string | null) {
  db.query("INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES (?,?,?,?,?,?)")
    .run(id, id, `h-${id}`, 1, "owner", personId);
}

function persona(db: Database, id: string, revoked: number | null = null) {
  db.query("INSERT INTO people (id, display_name, created_at, revoked_at, origin, rev, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, id, 1, revoked, "local", 1, 1);
}

function proprietaria(db: Database, personId: string) {
  db.query("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES (?,?,0)").run(personId, 1);
}

function organizzazione(db: Database, id: string, revoked: number | null = null) {
  db.query("INSERT INTO orgs (id, name, created_at, revoked_at, origin, rev, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, id, 1, revoked, "local", 1, 1);
}

function membro(db: Database, orgId: string, personId: string, opts: { revoked?: number; blocked?: number } = {}) {
  db.query("INSERT INTO org_members (org_id, person_id, role, joined_at, revoked_at, local_blocked_at, rev, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(orgId, personId, "member", 1, opts.revoked ?? null, opts.blocked ?? null, 1, 1);
}

describe("principali · i due salti", () => {
  let db: Database;
  beforeEach(() => { db = db084(); });

  it("dispositivo → persona → sue organizzazioni", () => {
    persona(db, "p1"); proprietaria(db, "p1");
    organizzazione(db, "o1"); organizzazione(db, "o2");
    membro(db, "o1", "p1"); membro(db, "o2", "p1");
    dispositivo(db, "d1", "p1");

    const r = resolvePrincipals(db, "d1");
    expect(r.list.map((p) => `${p.kind}:${p.id}`).sort())
      .toEqual(["device:d1", "org:o1", "org:o2", "person:p1"]);
    expect(r.personId).toBe("p1");
    expect(r.confined).toBe(false);
  });

  it("e si ferma lì: non esiste un terzo salto", () => {
    // La profondità due è la condizione di validità del disegno, non un
    // default. Se un giorno comparisse `orgs.parent_id`, questo insieme
    // dovrebbe crescere — e l'argomento andrebbe rifatto da capo, non esteso.
    persona(db, "p1"); proprietaria(db, "p1");
    organizzazione(db, "o1"); membro(db, "o1", "p1");
    dispositivo(db, "d1", "p1");
    const kinds = new Set(resolvePrincipals(db, "d1").list.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(["device", "org", "person"]);
  });
});

describe("principali · ogni ramo cade verso MENO poteri", () => {
  let db: Database;
  beforeEach(() => { db = db084(); });

  it("un dispositivo sconosciuto è confinato", () => {
    expect(resolvePrincipals(db, "fantasma")).toEqual({
      list: [{ kind: "device", id: "fantasma" }], personId: null, confined: true,
    });
  });

  it("un dispositivo SENZA persona è confinato", () => {
    dispositivo(db, "d1", null);
    const r = resolvePrincipals(db, "d1");
    expect(r.confined).toBe(true);
    expect(r.personId).toBeNull();
  });

  it("una persona REVOCATA confina il suo dispositivo, e ne azzera i principali", () => {
    persona(db, "p1", 999); proprietaria(db, "p1");
    organizzazione(db, "o1"); membro(db, "o1", "p1");
    dispositivo(db, "d1", "p1");
    const r = resolvePrincipals(db, "d1");
    expect(r.confined).toBe(true);
    // E non deve portarsi dietro le organizzazioni: una persona revocata non
    // è più nessuno, quindi non eredita niente.
    expect(r.list).toEqual([{ kind: "device", id: "d1" }]);
  });

  it("una persona che NON è proprietaria è confinata, anche se è in un'organizzazione", () => {
    // È la decisione centrale del disegno: un collega dello stesso team che
    // apre la MIA installazione è un ospite. È il mio filesystem, i miei
    // terminali, il mio abbonamento.
    persona(db, "collega");
    organizzazione(db, "o1"); membro(db, "o1", "collega");
    dispositivo(db, "d9", "collega");
    const r = resolvePrincipals(db, "d9");
    expect(r.confined).toBe(true);
    // Ma i principali ci sono lo stesso: è confinato, non cieco. Ciò che gli è
    // stato condiviso tramite l'organizzazione lo vede.
    expect(r.list.map((p) => p.kind)).toContain("org");
  });
});

describe("principali · le quattro revoche si leggono tutte", () => {
  let db: Database;
  beforeEach(() => {
    db = db084();
    persona(db, "p1"); proprietaria(db, "p1");
    dispositivo(db, "d1", "p1");
  });

  it("un'appartenenza revocata non porta l'organizzazione", () => {
    organizzazione(db, "o1"); membro(db, "o1", "p1", { revoked: 999 });
    expect(resolvePrincipals(db, "d1").list.map((p) => p.kind)).not.toContain("org");
  });

  it("un'appartenenza BLOCCATA localmente non porta l'organizzazione", () => {
    // È la revoca che sopravvive al pull: `org_members` è replica ad autorità
    // remota, quindi una rimozione fatta qui verrebbe ripristinata dal primo
    // aggiornamento. Questa colonna è l'unico posto in cui una decisione presa
    // offline resta presa.
    organizzazione(db, "o1"); membro(db, "o1", "p1", { blocked: 999 });
    expect(resolvePrincipals(db, "d1").list.map((p) => p.kind)).not.toContain("org");
  });

  it("un'organizzazione revocata non conta", () => {
    organizzazione(db, "o1", 999); membro(db, "o1", "p1");
    expect(resolvePrincipals(db, "d1").list.map((p) => p.kind)).not.toContain("org");
  });

  it("una viva invece conta", () => {
    // Il controcanto: senza, i tre casi sopra passerebbero anche con una query
    // che non restituisce mai niente.
    organizzazione(db, "o1"); membro(db, "o1", "p1");
    expect(resolvePrincipals(db, "d1").list.map((p) => p.kind)).toContain("org");
  });
});

describe("principali · il contatore di revisione", () => {
  it("si muove quando cambia un'appartenenza", () => {
    const db = db084();
    persona(db, "p1"); organizzazione(db, "o1");
    const prima = principalsRev(db);
    membro(db, "o1", "p1");
    expect(principalsRev(db)).toBeGreaterThan(prima);
  });

  it("su uno schema senza la 084 vale zero invece di esplodere", () => {
    // Un server che gira su un database più vecchio deve degradare, non cadere.
    const db = new Database(":memory:");
    expect(principalsRev(db)).toBe(0);
  });
});

describe("principali · schema più vecchio della 084", () => {
  it("si degrada al comportamento di prima: il dispositivo è il soggetto", () => {
    const db = new Database(":memory:");
    db.run(readFileSync(join(RADICE, "server/db/migrations/080-devices.sql"), "utf8"));
    const r = resolvePrincipals(db, "d1");
    expect(r).toEqual({ list: [{ kind: "device", id: "d1" }], personId: null, confined: true });
  });
});
