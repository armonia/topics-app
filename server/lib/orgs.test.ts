/**
 * `server/lib/orgs.ts` contro uno SQLite vero, con la migration vera.
 *
 * Perché la migration e non uno schema riscritto a mano: il CHECK su
 * `org_members.role` e il bootstrap del proprietario stanno LÌ, e un test che
 * ricostruisce le tabelle a memoria smette di accorgersi proprio della deriva
 * fra il CHECK e l'union TypeScript — in questo repo è già successo due volte.
 *
 * Il caso che questo file copre e che le rotte non possono raggiungere è il
 * RIPIEGO: `installation` che punta a un'organizzazione revocata. Da fuori non
 * lo si può produrre — `DELETE /api/auth/orgs/:id` rifiuta di revocare proprio
 * quella — ma una sincronizzazione sì, ed è il momento in cui «qual è la mia
 * organizzazione» non deve rispondere «nessuna» a un'installazione che ha un
 * proprietario e un gruppo vivo.
 *
 * @covers ORG-INST-01
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DDL } from "../db/test-schema";

import {
  installationOrgId, liveMemberCount, liveOwnerCount, orgRole,
  canAdministerOrg, actingPersonId, isOrgRole, orgAlive, ORG_ROLES,
} from "./orgs";

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

function creaOrg(db: Database, id: string, nome: string, creata = 1): void {
  db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',0,?)",
    [id, nome, creata, creata]);
}

function metti(db: Database, orgId: string, personId: string, ruolo = "member"): void {
  db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,?,1,0,1)",
    [orgId, personId, ruolo]);
}

describe("orgs · qual è l'organizzazione di questa installazione", () => {
  test("è quella di `installation`, NON la riga più vecchia della tabella", () => {
    // Il difetto che questa riga fissa: `ORDER BY created_at LIMIT 1` risponde
    // giusto per caso finché di organizzazioni ce n'è una, e alla seconda
    // cambia l'identità dell'installazione senza sollevare niente.
    const db = db084();
    const mia = (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;
    creaOrg(db, "piu-vecchia", "Arrivata prima", 1);

    expect(
      (db.query("SELECT id FROM orgs WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string }).id,
      "la trappola esiste davvero: la riga più vecchia NON è quella dell'installazione",
    ).toBe("piu-vecchia");
    expect(installationOrgId(db)).toBe(mia);
  });

  test("se il puntatore è morto, ripiega sul gruppo vivo del proprietario predefinito", () => {
    const db = db084();
    const mia = (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;
    creaOrg(db, "altra", "L'altra", 5);
    metti(db, "altra", proprietario(db), "owner");
    db.run("UPDATE orgs SET revoked_at = 99 WHERE id = ?", [mia]);

    expect(installationOrgId(db)).toBe("altra");
  });

  test("un gruppo di cui il proprietario NON è membro non è un ripiego", () => {
    // Altrimenti il ripiego consegnerebbe all'installazione l'identità di un
    // gruppo altrui — che è lo stesso guasto di prima con un altro `ORDER BY`.
    const db = db084();
    const mia = (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;
    creaOrg(db, "di-altri", "Di altri", 5);
    db.run("UPDATE orgs SET revoked_at = 99 WHERE id = ?", [mia]);

    expect(installationOrgId(db)).toBeNull();
  });

  test("su uno schema più vecchio della 084 non esplode: non c'è organizzazione", () => {
    expect(installationOrgId(new Database(":memory:"))).toBeNull();
  });
});

describe("orgs · esiste ancora questo gruppo", () => {
  test("tre esiti, e il terzo non è «non esiste»", () => {
    // Sono TRE e non due: «non c'è» e «questa macchina non è ancora migrata»
    // sono due cose diverse, e confonderle fa rispondere 404 a un database che
    // la tabella non ce l'ha proprio. Le rotte lo usano per distinguere il 404
    // dal 400.
    const db = db084();
    creaOrg(db, "viva", "Viva");
    creaOrg(db, "morta", "Morta");
    db.run("UPDATE orgs SET revoked_at = 99 WHERE id = 'morta'");

    expect(orgAlive(db, "viva")).toBe(true);
    expect(orgAlive(db, "morta"), "revocata = non c'è").toBe(false);
    expect(orgAlive(db, "mai-esistita")).toBe(false);

    const vecchio = new Database(":memory:");
    expect(orgAlive(vecchio, "viva"), "schema più vecchio della 084").toBeNull();
  });

  test("la revoca del GRUPPO non tocca le sue appartenenze — ed è perché il ruolo da solo non basta", () => {
    // La trappola in una riga: `canAdministerOrg` resta `true` su un gruppo
    // cancellato, perché guarda `org_members` e la revoca sta su `orgs`. Chi
    // controlla solo il ruolo crede di poter amministrare un morto — è così che
    // la PATCH che rinomina scriveva dentro una riga revocata.
    const db = db084();
    const io = proprietario(db);
    creaOrg(db, "morta", "Morta");
    metti(db, "morta", io, "owner");
    db.run("UPDATE orgs SET revoked_at = 99 WHERE id = 'morta'");

    expect(canAdministerOrg(db, "morta", io), "il ruolo sopravvive alla revoca del gruppo").toBe(true);
    expect(orgAlive(db, "morta"), "e non basta: la domanda giusta è un'altra").toBe(false);
  });
});

describe("orgs · quanti siete, e chi comanda", () => {
  test("il conteggio ignora ENTRAMBE le revoche", () => {
    const db = db084();
    const mia = installationOrgId(db)!;
    expect(liveMemberCount(db, mia)).toBe(1);

    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('a','A',1,'local',0,1)");
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('b','B',1,'local',0,1)");
    metti(db, mia, "a");
    metti(db, mia, "b");
    expect(liveMemberCount(db, mia), "tre membri vivi").toBe(3);

    db.run("UPDATE org_members SET revoked_at = 7 WHERE person_id = 'a'");
    db.run("UPDATE org_members SET local_blocked_at = 7 WHERE person_id = 'b'");
    expect(liveMemberCount(db, mia), "le due revoche pesano uguale su «quanti siete»").toBe(1);
  });

  test("un'appartenenza revocata non è un ruolo più debole: è assenza", () => {
    const db = db084();
    const mia = installationOrgId(db)!;
    const io = proprietario(db);
    expect(orgRole(db, mia, io)).toBe("owner");
    expect(canAdministerOrg(db, mia, io)).toBe(true);

    db.run("UPDATE org_members SET local_blocked_at = 7 WHERE person_id = ?", [io]);
    expect(orgRole(db, mia, io), "tolto non è `member`, è niente").toBeNull();
    expect(canAdministerOrg(db, mia, io)).toBe(false);
  });

  test("`admin` amministra, `member` no", () => {
    const db = db084();
    const mia = installationOrgId(db)!;
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('a','A',1,'local',0,1)");
    metti(db, mia, "a", "admin");
    expect(canAdministerOrg(db, mia, "a")).toBe(true);
    db.run("UPDATE org_members SET role = 'member' WHERE person_id = 'a'");
    expect(canAdministerOrg(db, mia, "a")).toBe(false);
  });

  test("nessuna persona non amministra niente", () => {
    const db = db084();
    expect(canAdministerOrg(db, installationOrgId(db)!, null)).toBe(false);
  });

  test("i proprietari vivi si contano, ed è ciò che impedisce di restare a zero", () => {
    const db = db084();
    const mia = installationOrgId(db)!;
    expect(liveOwnerCount(db, mia)).toBe(1);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('a','A',1,'local',0,1)");
    metti(db, mia, "a", "owner");
    expect(liveOwnerCount(db, mia)).toBe(2);
    db.run("UPDATE org_members SET local_blocked_at = 7 WHERE person_id = 'a'");
    expect(liveOwnerCount(db, mia), "un proprietario tolto non conta").toBe(1);
  });

  test("l'union dei ruoli e il CHECK della 084 dicono la stessa cosa", () => {
    // Il CHECK e l'union TS sono due dichiarazioni della stessa regola scritte
    // in due linguaggi: quando divergono, il codice accetta un valore che il
    // database rifiuta, e il rifiuto arriva a runtime.
    const db = db084();
    const mia = installationOrgId(db)!;
    for (const r of ORG_ROLES) {
      const pid = `p-${r}`;
      db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,1,'local',0,1)", [pid, r]);
      expect(() => metti(db, mia, pid, r), `il CHECK deve accettare ${r}`).not.toThrow();
    }
    expect(() => metti(db, mia, proprietario(db), "superuser")).toThrow();
    expect(isOrgRole("superuser")).toBe(false);
    expect(isOrgRole("admin")).toBe(true);
  });
});

describe("orgs · chi sta facendo questa richiesta", () => {
  test("il dispositivo porta alla sua persona", () => {
    const db = db084();
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('a','A',1,'local',0,1)");
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES ('d1','Telefono','h',1,'guest','a')");
    expect(actingPersonId(db, "d1")).toBe("a");
  });

  test("senza dispositivo — il loopback — è il proprietario predefinito", () => {
    const db = db084();
    expect(actingPersonId(db, null)).toBe(proprietario(db));
  });

  test("un dispositivo revocato non porta più a nessuno di suo", () => {
    const db = db084();
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('a','A',1,'local',0,1)");
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role, person_id, revoked_at) VALUES ('d1','Telefono','h',1,'guest','a',5)");
    expect(actingPersonId(db, "d1")).toBe(proprietario(db));
  });
});
