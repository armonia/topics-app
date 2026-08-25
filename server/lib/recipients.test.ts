/**
 * `server/lib/recipients.ts` contro uno SQLite vero, con le migration vere.
 *
 * Il caso che conta è UNO, ed è quello che ha motivato il file: la persona
 * TOLTA da ogni gruppo. `GET /api/auth/subjects` la escludeva già dalla rubrica
 * — con un `NOT EXISTS` scritto lì dentro — mentre `POST /api/auth/shares`
 * sullo stesso id rispondeva `200`. Qui si fissa che la risposta è UNA, e
 * `tests/integration/auth-routes.test.ts` fissa che le due rotte la usano
 * entrambe.
 *
 * It is the same answer `GET /api/auth/subjects` gives, i.e. which subjects
 * the owner's address book may offer.
 *
 * @covers GUEST-06
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { subjectRejection, canReceive, personRemovedEverywhere } from "./recipients";
import { TASKS_DDL } from "../db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"];

function db084(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  return db;
}

const proprietario = (db: Database) =>
  (db.query("SELECT person_id AS id FROM installation_owners WHERE is_default = 1").get() as { id: string }).id;
const miaOrg = (db: Database) =>
  (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;

function persona(db: Database, id: string, nome = "Collega"): string {
  db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,1,'local',0,1)",
    [id, nome]);
  return id;
}

function metti(db: Database, orgId: string, personId: string, ruolo = "member"): void {
  db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,?,1,0,1)",
    [orgId, personId, ruolo]);
}

function dispositivo(db: Database, id: string, ruolo: string, revocato: number | null = null): void {
  db.run("INSERT INTO devices (id, name, token_hash, created_at, role, revoked_at) VALUES (?,?,?,1,?,?)",
    [id, id, `h-${id}`, ruolo, revocato]);
}

describe("recipients · la persona TOLTA da ogni gruppo", () => {
  test("chi non è MAI stato in un gruppo resta un destinatario", () => {
    // Il rovescio del caso principale, e serve a dimostrare che il canale di
    // osservazione funziona: senza questo, un `personRemovedEverywhere` che
    // rispondesse sempre `true` passerebbe il test qui sotto.
    const db = db084();
    persona(db, "mai-in-gruppo");
    expect(personRemovedEverywhere(db, "mai-in-gruppo")).toBe(false);
    expect(subjectRejection(db, "person", "mai-in-gruppo")).toBeNull();
    expect(canReceive(db, "person", "mai-in-gruppo")).toBe(true);
  });

  test("un membro VIVO resta un destinatario", () => {
    const db = db084();
    persona(db, "dentro");
    metti(db, miaOrg(db), "dentro");
    expect(personRemovedEverywhere(db, "dentro")).toBe(false);
    expect(subjectRejection(db, "person", "dentro")).toBeNull();
  });

  test("TOLTA localmente (`local_blocked_at`) non è più un destinatario", () => {
    const db = db084();
    persona(db, "tolta");
    metti(db, miaOrg(db), "tolta");
    db.run("UPDATE org_members SET local_blocked_at = 99 WHERE person_id = 'tolta'");

    expect(personRemovedEverywhere(db, "tolta")).toBe(true);
    expect(subjectRejection(db, "person", "tolta")).toEqual({ codice: "person_removed", status: 400 });
    expect(canReceive(db, "person", "tolta")).toBe(false);
  });

  test("revocata dal piano di controllo (`revoked_at`) conta uguale", () => {
    // Le due colonne sono diverse per chi le scrive, non per questa domanda:
    // scriverne una sola qui era il modo di far tornare in rubrica chi era
    // stato tolto dall'altra parte.
    const db = db084();
    persona(db, "revocata");
    metti(db, miaOrg(db), "revocata");
    db.run("UPDATE org_members SET revoked_at = 99 WHERE person_id = 'revocata'");
    expect(subjectRejection(db, "person", "revocata")).toEqual({ codice: "person_removed", status: 400 });
  });

  test("tolta da UN gruppo ma viva in un altro resta un destinatario", () => {
    const db = db084();
    persona(db, "doppia");
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('altra','Altra',2,'local',0,2)");
    metti(db, miaOrg(db), "doppia");
    metti(db, "altra", "doppia");
    db.run("UPDATE org_members SET local_blocked_at = 99 WHERE person_id = 'doppia' AND org_id = ?", [miaOrg(db)]);

    expect(personRemovedEverywhere(db, "doppia")).toBe(false);
    expect(subjectRejection(db, "person", "doppia")).toBeNull();
  });
});

describe("recipients · gli altri motivi di rifiuto", () => {
  test("persona sconosciuta, revocata, proprietaria", () => {
    const db = db084();
    expect(subjectRejection(db, "person", "non-esiste")).toEqual({ codice: "unknown_person", status: 404 });

    persona(db, "morta");
    db.run("UPDATE people SET revoked_at = 5 WHERE id = 'morta'");
    expect(subjectRejection(db, "person", "morta")).toEqual({ codice: "person_revoked", status: 400 });

    expect(subjectRejection(db, "person", proprietario(db)))
      .toEqual({ codice: "person_is_owner", status: 400 });
  });

  test("dispositivo: sconosciuto, revocato, non ospite, ospite", () => {
    const db = db084();
    expect(subjectRejection(db, "device", "boh")).toEqual({ codice: "unknown_device", status: 404 });

    dispositivo(db, "revocato", "guest", 7);
    expect(subjectRejection(db, "device", "revocato")).toEqual({ codice: "unknown_device", status: 404 });

    dispositivo(db, "mio", "owner");
    expect(subjectRejection(db, "device", "mio")).toEqual({ codice: "device_not_guest", status: 400 });

    dispositivo(db, "ospite", "guest");
    expect(subjectRejection(db, "device", "ospite")).toBeNull();
  });

  test("organizzazione: sconosciuta, revocata, viva", () => {
    const db = db084();
    expect(subjectRejection(db, "org", "boh")).toEqual({ codice: "unknown_org", status: 404 });

    db.run("INSERT INTO orgs (id, name, created_at, revoked_at, origin, rev, updated_at) VALUES ('morta','M',1,9,'local',0,1)");
    expect(subjectRejection(db, "org", "morta")).toEqual({ codice: "org_revoked", status: 400 });

    expect(subjectRejection(db, "org", miaOrg(db))).toBeNull();
  });

  test("schema più vecchio della 084: si RIFIUTA, non si concede", () => {
    // Le letture degradano, le scritture rifiutano. Concedere senza poter
    // sapere se il soggetto è confinato è la condivisione sbagliata.
    const db = new Database(":memory:");
    db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created_at INTEGER, role TEXT, revoked_at INTEGER)");
    expect(subjectRejection(db, "person", "x")).toEqual({ codice: "db_unavailable", status: 400 });
    expect(subjectRejection(db, "org", "x")).toEqual({ codice: "db_unavailable", status: 400 });
  });
});
