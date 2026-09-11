/**
 * La porta unica su `grants`, contro uno SQLite vero.
 *
 * Due cose si provano qui e non altrove: la PRECEDENZA di `deny` su `read` — che
 * vive nell'ORDER BY e non nei chiamanti, perché una precedenza sparsa fra i
 * chiamanti è una precedenza che il secondo implementa al contrario — e il PIANO
 * della query, che non è una fisima: questa domanda gira dentro il ciclo dei
 * broadcast, per ogni socket e per ogni frame. Una scansione lì non è lenta, è
 * un'altra categoria di programma.
 *
 * The single door every grant check goes through: a resource is readable by
 * id when one of the asking device's principals holds a grant on it, or on
 * the project that contains it.
 *
 * @covers GUEST-01, GUEST-06, GUEST-09, GUEST-11
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DDL } from "../db/test-schema";
import {
  hasGrant, grantedResourceIds, grantedByType, reasonsFor, subjectsOf,
  holdsGrantOnTaskPreview, escapeLike, putGrant, dropGrant, deviceP,
  levelFor, meetsLevel, subjectsViaContainer, readableTaskIds,
} from "./grants-query";

const RADICE = join(import.meta.dir, "..", "..");

function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created_at INTEGER, revoked_at INTEGER)");
  db.run(readFileSync(join(RADICE, "server/db/migrations/083-grants.sql"), "utf8").replace(
    // La 083 travasa da `task_shares`, che qui non esiste: si tiene lo schema e
    // si lascia fuori il travaso.
    /INSERT OR IGNORE INTO grants[\s\S]*$/,
    "",
  ));
  return db;
}

/**
 * Lo schema che la 084 creerà: soggetto a tre valori, livello a due.
 *
 * Il modulo è già plurale sul soggetto e conosce già `deny` — la 083 no, e non
 * è una svista: SQLite non altera un CHECK in posto, quindi allargarlo vuol dire
 * ricreare la tabella, e lo si fa una volta sola. Qui si prova la LOGICA del
 * modulo contro lo schema in cui vivrà; il fatto che lo schema di oggi non ci
 * sia ancora arrivato è pinnato dal caso «il CHECK di oggi rifiuta una persona».
 */
function conSchema084(db: Database): Database {
  db.run("DROP TABLE grants");
  db.run(`CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('device','person','org')),
    subject_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('task','topic')),
    resource_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'read' CHECK (level IN ('read','deny')),
    via_type TEXT, via_id TEXT, granted_at INTEGER NOT NULL,
    granted_by_person_id TEXT,
    UNIQUE (subject_type, subject_id, resource_type, resource_id))`);
  db.run("CREATE INDEX idx_grants_resource ON grants(resource_type, resource_id)");
  return db;
}

/**
 * THE SCHEMA THIS MODULE ACTUALLY LIVES IN, replayed from the real migration
 * files instead of retyped here.
 *
 * It used to be a hand-written CREATE TABLE carrying
 * `CHECK (level IN ('read','deny'))`, and that is not a cosmetic difference:
 * a fixture with the OLD check cannot hold a `comment` or an `edit` row at
 * all (SQLite answers "CHECK constraint failed"), so every test about the
 * three-level scale was impossible to write in this file and none was. The
 * scale shipped with its ordering rule - the HIGHEST row wins, not the first
 * - proven by nothing.
 *
 * Reading the two migrations means the CHECK cannot drift from the database
 * again by retyping: whatever the file says is what the fixture enforces.
 * `people` is a stub because the level migration declares an FK towards it
 * and ends with `foreign_keys = ON`, so without the parent table every INSERT
 * into `grants` would fail.
 */
const MIGRATIONS_LEVELS = [
  "20260816230500-grants-project.sql",
  "20260909180634-grant-levels-write-scope.sql",
];

function withProjects(db: Database): Database {
  conSchema084(db);
  // The parents the real files point at: `people` for the grant's FK, and the
  // three `TASKS_DDL` declares. They are needed because the migrations end
  // with `foreign_keys = ON` - which is what the live database runs with, so
  // leaving it off here would be a fixture easier to satisfy than production.
  for (const t of ["people", "machines", "agent_profiles", "topics"]) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY)`);
  }
  for (const m of MIGRATIONS_LEVELS) {
    db.run(readFileSync(join(RADICE, "server/db/migrations", m), "utf8"));
  }
  return db;
}

/** Un task dentro un progetto: l'unico contenitore che oggi esiste. */
function taskInProject(db: Database, taskId: string, projectId: string): void {
  db.run(
    "INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at)"
    + " VALUES (?, ?, 'x', 'todo', 2, 0, '2026-01-01', '2026-01-01')",
    [taskId, projectId],
  );
}

describe("condividere un PROGETTO apre i suoi task", () => {
  let db: Database;
  beforeEach(() => { db = withProjects(dbFresco()); });

  it("il task si vede attraverso il progetto che lo contiene", () => {
    // È il punto della card: la condivisione resta UNA riga sul progetto, e i
    // task la ereditano in lettura. Nessuna riga derivata da mantenere quando
    // un task nasce, si sposta o viene archiviato.
    taskInProject(db, "t1", "p1");
    expect(hasGrant(db, deviceP("d1"), "task", "t1"), "prima: niente").toBe(false);
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "t1"), "dopo: il progetto apre il task").toBe(true);
  });

  it("un task di un ALTRO progetto resta chiuso", () => {
    // Il caso che conta: un cancello che non nega non è un cancello.
    taskInProject(db, "t1", "p1");
    taskInProject(db, "t2", "p2");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "t2")).toBe(false);
  });

  it("il DENY sul singolo task vince sul progetto condiviso", () => {
    // «Questo progetto è condiviso, TRANNE questo task» dev'essere dicibile, o
    // condividere un progetto diventa una porta che non si può più chiudere su
    // un pezzo solo.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 2, level: "deny" });
    expect(hasGrant(db, deviceP("d1"), "task", "t1")).toBe(false);
  });

  it("un task SENZA progetto non eredita niente", () => {
    // Nessun contenitore, nessuna espansione: la domanda torna quella di prima
    // invece di cadere o di aprirsi.
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "sconosciuto")).toBe(false);
  });

  it("la RAGIONE nomina il progetto, non lascia indovinare", () => {
    // Un elenco di ragioni che non nomina il contenitore lascerebbe chi guarda
    // a togliere un accesso che non è lì - e l'accesso resterebbe in piedi.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "org", id: "o1" }, "project", "p1", { grantedAt: 1 });
    const ragioni = reasonsFor(db, [{ kind: "org", id: "o1" }], "task", "t1");
    expect(ragioni).toHaveLength(1);
    expect(ragioni[0].subjectId).toBe("o1");
    expect(ragioni[0].viaType, "la ragione dev'essere attribuita al progetto").toBe("project");
    expect(ragioni[0].viaId).toBe("p1");
  });

  it("una riga DIRETTA sul task non viene attribuita al progetto", () => {
    // Il `via` esiste solo quando l'accesso arriva davvero da un contenitore:
    // marcarlo sempre renderebbe impossibile distinguere le due situazioni, che
    // si tolgono in due modi diversi.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    const ragioni = reasonsFor(db, deviceP("d1"), "task", "t1");
    expect(ragioni).toHaveLength(1);
    expect(ragioni[0].viaType).toBeUndefined();
  });

  it("il livello del PROGETTO non diventa il livello del task", () => {
    // The whole point of the cap. A project shared "can edit" would otherwise
    // hand the guest the text of every card it holds - and that text becomes
    // the prompt of an agent running in the owner's repository at the next
    // dispatch. One click, a set whose membership moves on its own, and no
    // row on the card for the owner to see or take back.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { level: "edit", grantedAt: 1 });
    const level = levelFor(db, deviceP("d1"), "task", "t1")!;
    expect(level, "il contenitore apre la porta, non consegna la penna").toBe("read");
    expect(meetsLevel(level, "read")).toBe(true);
    expect(meetsLevel(level, "comment")).toBe(false);
    expect(meetsLevel(level, "edit")).toBe(false);
  });

  it("un task creato DOPO la condivisione del progetto eredita lo stesso tetto", () => {
    // The membership of a container moves without anybody touching the grant:
    // if the cap were applied at write time it would miss exactly the rows
    // nobody ever looked at again.
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { level: "edit", grantedAt: 1 });
    taskInProject(db, "t-dopo", "p1");
    expect(levelFor(db, deviceP("d1"), "task", "t-dopo")).toBe("read");
  });

  it("una riga DIRETTA sul task porta il suo livello per intero", () => {
    // The cap is about the container, not about the scale: writing needs a row
    // on the resource itself, and that row is worth exactly what it says.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { level: "read", grantedAt: 1 });
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { level: "edit", grantedAt: 2 });
    expect(levelFor(db, deviceP("d1"), "task", "t1")).toBe("edit");
  });

  it("il DENY sul task vince anche sul livello del progetto", () => {
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { level: "edit", grantedAt: 1 });
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { level: "deny", grantedAt: 2 });
    expect(levelFor(db, deviceP("d1"), "task", "t1")).toBe("deny");
  });

  it("il pannello della SCHEDA nomina chi arriva dal progetto, col livello in vigore", () => {
    // `subjectsOf` answers with the rows written ON the resource, so a card
    // reached through its project reported "shared with nobody" while somebody
    // was reading it: an access with no surface to see it on has no surface to
    // revoke it from either.
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "org", id: "o1" }, "project", "p1", { level: "edit", grantedAt: 1 });
    expect(subjectsOf(db, "task", "t1"), "sulla scheda non c'e' nessuna riga").toEqual([]);
    const inherited = subjectsViaContainer(db, "task", "t1");
    expect(inherited).toHaveLength(1);
    expect(inherited[0].subjectId).toBe("o1");
    expect(inherited[0].viaType).toBe("project");
    expect(inherited[0].viaId).toBe("p1");
    expect(inherited[0].level, "il livello mostrato e' quello che il cancello applica").toBe("read");
  });

  it("un DENY sul progetto non compare come accesso ereditato", () => {
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "org", id: "o1" }, "project", "p1", { level: "deny", grantedAt: 1 });
    expect(subjectsViaContainer(db, "task", "t1")).toEqual([]);
  });

  it("l'ELENCO nomina i task del progetto, non solo quelli concessi uno a uno", () => {
    // The gate has followed the container since 20260816230500 and the two
    // inventories did not: a card inside a shared project was openable by id
    // and absent from every list a guest has. That is "I shared it with you"
    // against "I see nothing" - the divergence GUEST-06 forbids.
    taskInProject(db, "t1", "p1");
    taskInProject(db, "t2", "p1");
    taskInProject(db, "altrove", "p2");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(readableTaskIds(db, deviceP("d1")).sort()).toEqual(["t1", "t2"]);
  });

  it("e un DENY sul singolo task lo toglie dall'elenco, non solo dal cancello", () => {
    // A list that showed a card the gate then refuses is the worst shape of
    // all: visible and not openable.
    taskInProject(db, "t1", "p1");
    taskInProject(db, "t2", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    putGrant(db, { kind: "device", id: "d1" }, "task", "t2", { level: "deny", grantedAt: 2 });
    expect(readableTaskIds(db, deviceP("d1"))).toEqual(["t1"]);
    expect(hasGrant(db, deviceP("d1"), "task", "t2"), "l'elenco e il cancello dicono la stessa cosa").toBe(false);
  });

  it("senza progetti concessi l'elenco resta quello delle righe dirette", () => {
    taskInProject(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    expect(readableTaskIds(db, deviceP("d1"))).toEqual(["t1"]);
    expect(readableTaskIds(db, deviceP("d2"))).toEqual([]);
  });
});

/**
 * THE RULE THAT MAKES A THREE-STEP SCALE DIFFERENT FROM A TWO-STEP ONE: among
 * several rows the HIGHEST wins, not the first one written.
 *
 * The comment above `effectiveLevel` declared it and no test held it:
 * replacing the max loop with `rows[0].level` left 327 tests green across
 * eleven files. The case is reachable today - the panel shares the same card
 * with a person AND with their organisation, each at its own level - and it
 * fails in both directions depending on the order the rows went in: access
 * refused to somebody who has it, or granted to somebody who should not.
 *
 * Which is why BOTH orders are asserted: with one order only, "take the
 * first" would pass half the time.
 */
describe("il livello EFFICACE fra piu' righe", () => {
  let db: Database;
  beforeEach(() => { db = withProjects(dbFresco()); });

  const bothOrders = [
    { first: "read", second: "edit" },
    { first: "edit", second: "read" },
  ] as const;

  for (const { first, second } of bothOrders) {
    it(`vince il piu' alto: dispositivo ${first}, organizzazione ${second}`, () => {
      putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { level: first, grantedAt: 1 });
      putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { level: second, grantedAt: 2 });
      const principali = [{ kind: "device" as const, id: "d1" }, { kind: "org" as const, id: "o1" }];
      expect(levelFor(db, principali, "task", "t1")).toBe("edit");
    });

    it(`e un DENY li batte comunque: ${first} poi ${second} poi deny`, () => {
      putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { level: first, grantedAt: 1 });
      putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { level: second, grantedAt: 2 });
      putGrant(db, { kind: "person", id: "pp" }, "task", "t1", { level: "deny", grantedAt: 3 });
      const principali = [
        { kind: "device" as const, id: "d1" },
        { kind: "org" as const, id: "o1" },
        { kind: "person" as const, id: "pp" },
      ];
      expect(levelFor(db, principali, "task", "t1")).toBe("deny");
    });
  }

  it("`comment` non si perde fra due `read`", () => {
    // THE MIDDLE RUNG: a maximum written as "edit or else read" would pass
    // this case too, and the scale would go binary again in silence.
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { level: "read", grantedAt: 1 });
    putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { level: "comment", grantedAt: 2 });
    putGrant(db, { kind: "person", id: "pp" }, "task", "t1", { level: "read", grantedAt: 3 });
    const principali = [
      { kind: "device" as const, id: "d1" },
      { kind: "org" as const, id: "o1" },
      { kind: "person" as const, id: "pp" },
    ];
    expect(levelFor(db, principali, "task", "t1")).toBe("comment");
  });

  it("nessuna riga = `null`, che non e' `deny`", () => {
    // "never shared" and "shared, then denied" are two different answers and
    // the caller tells them apart: one is a 403 "not shared", the other an
    // access that was taken away.
    expect(levelFor(db, deviceP("d1"), "task", "mai-vista")).toBeNull();
  });
});

describe("porta unica · leggere una concessione", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  it("senza righe non si vede niente", () => {
    expect(hasGrant(db, deviceP("d1"), "task", "t1")).toBe(false);
  });

  it("con una riga si vede", () => {
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "t1")).toBe(true);
    // E solo quella: la concessione è puntuale, non un lasciapassare sul tipo.
    expect(hasGrant(db, deviceP("d1"), "task", "t2")).toBe(false);
    expect(hasGrant(db, deviceP("d2"), "task", "t1")).toBe(false);
  });

  it("un insieme VUOTO di principali non vede niente — non tutto", () => {
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    // Il verso conta: costruire la query senza rami produrrebbe un WHERE vero.
    expect(hasGrant(db, [], "task", "t1")).toBe(false);
    expect(grantedResourceIds(db, [], "task")).toEqual([]);
  });

  it("più principali di tipi diversi: basta che uno regga", () => {
    db = conSchema084(db);
    putGrant(db, { kind: "person", id: "p1" }, "task", "t1", { grantedAt: 1 });
    const principali = [
      { kind: "device" as const, id: "d1" },
      { kind: "person" as const, id: "p1" },
      { kind: "org" as const, id: "o1" },
    ];
    expect(hasGrant(db, principali, "task", "t1")).toBe(true);
  });

  it("togliere una concessione la toglie davvero", () => {
    putGrant(db, { kind: "device", id: "d1" }, "topic", "c1", { grantedAt: 1 });
    dropGrant(db, { kind: "device", id: "d1" }, "topic", "c1");
    expect(hasGrant(db, deviceP("d1"), "topic", "c1")).toBe(false);
  });
});

describe("porta unica · `deny` prevale", () => {
  let db: Database;
  beforeEach(() => { db = conSchema084(dbFresco()); });

  it("un divieto batte un permesso, comunque sia arrivato", () => {
    putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { grantedAt: 1 });
    putGrant(db, { kind: "person", id: "p1" }, "task", "t1", { level: "deny", grantedAt: 2 });
    const principali = [{ kind: "org" as const, id: "o1" }, { kind: "person" as const, id: "p1" }];
    expect(hasGrant(db, principali, "task", "t1")).toBe(false);
  });

  it("e batte anche quando è arrivato PRIMA", () => {
    // La precedenza è sul livello, non sull'ordine di scrittura: se dipendesse
    // dal tempo, riconcedere basterebbe a scavalcare un divieto.
    putGrant(db, { kind: "person", id: "p1" }, "task", "t1", { level: "deny", grantedAt: 1 });
    putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { grantedAt: 99 });
    const principali = [{ kind: "org" as const, id: "o1" }, { kind: "person" as const, id: "p1" }];
    expect(hasGrant(db, principali, "task", "t1")).toBe(false);
  });

  it("un elenco non mostra ciò che è negato", () => {
    // Altrimenti si ottiene la forma peggiore: visibile e non apribile.
    putGrant(db, { kind: "org", id: "o1" }, "task", "t1", { grantedAt: 1 });
    putGrant(db, { kind: "org", id: "o1" }, "task", "t2", { grantedAt: 1 });
    putGrant(db, { kind: "person", id: "p1" }, "task", "t2", { level: "deny", grantedAt: 2 });
    const principali = [{ kind: "org" as const, id: "o1" }, { kind: "person" as const, id: "p1" }];
    expect(grantedResourceIds(db, principali, "task")).toEqual(["t1"]);
  });
});

describe("porta unica · tutte le ragioni, non la prima", () => {
  it("chi vede una cosa per due strade le vede elencate entrambe", () => {
    // Toglierne una lascerebbe l'accesso in piedi per l'altra, e un elenco che
    // si ferma alla prima non lo direbbe.
    const db = conSchema084(dbFresco());
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    putGrant(db, { kind: "person", id: "p1" }, "task", "t1", { grantedAt: 2 });
    const ragioni = reasonsFor(db, [{ kind: "device", id: "d1" }, { kind: "person", id: "p1" }], "task", "t1");
    expect(ragioni).toHaveLength(2);
    // E la ragione è il SOGGETTO: sono due righe diverse con due revoche
    // diverse, non la stessa concessione contata due volte.
    expect(ragioni.map((r) => `${r.subjectType}:${r.subjectId}`).sort())
      .toEqual(["device:d1", "person:p1"]);
  });

  it("`subjectsOf` dice CHI è stato messo, indipendentemente da chi chiede", () => {
    const db = conSchema084(dbFresco());
    putGrant(db, { kind: "device", id: "d1" }, "topic", "c1", { grantedAt: 1 });
    putGrant(db, { kind: "person", id: "p1" }, "topic", "c1", { grantedAt: 2 });
    const s = subjectsOf(db, "topic", "c1");
    expect(s.map((r) => `${r.subjectType}:${r.subjectId}`)).toEqual(["device:d1", "person:p1"]);
  });
});

describe("porta unica · l'anteprima di un task", () => {
  it("passa solo l'anteprima di un task concesso", () => {
    const db = dbFresco();
    db.run("INSERT INTO tasks (id, preview_image, project_id, text, created_at, updated_at) VALUES ('t1','/Users/x/.topics/media/mio.png', 'p-test', 'x', '2026-01-01', '2026-01-01')");
    db.run("INSERT INTO tasks (id, preview_image, project_id, text, created_at, updated_at) VALUES ('t2','/Users/x/.topics/media/altrui.png', 'p-test', 'x', '2026-01-01', '2026-01-01')");
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    expect(holdsGrantOnTaskPreview(db, deviceP("d1"), "/mio.png")).toBe(true);
    expect(holdsGrantOnTaskPreview(db, deviceP("d1"), "/altrui.png")).toBe(false);
  });

  it("un metacarattere non diventa un passe-partout", () => {
    // Senza l'escape, `%` nel percorso richiesto trasformerebbe «questa
    // anteprima» in «una qualunque anteprima».
    const db = dbFresco();
    db.run("INSERT INTO tasks (id, preview_image, project_id, text, created_at, updated_at) VALUES ('t2','/Users/x/.topics/media/segreta.png', 'p-test', 'x', '2026-01-01', '2026-01-01')");
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    db.run("INSERT INTO tasks (id, preview_image, project_id, text, created_at, updated_at) VALUES ('t1','/Users/x/.topics/media/mia.png', 'p-test', 'x', '2026-01-01', '2026-01-01')");
    expect(holdsGrantOnTaskPreview(db, deviceP("d1"), "%")).toBe(false);
    expect(holdsGrantOnTaskPreview(db, deviceP("d1"), "%.png")).toBe(false);
  });

  it("escapeLike neutralizza i tre caratteri che contano", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});

describe("porta unica · il PIANO della query", () => {
  it("usa l'indice di risorsa e non scandisce", () => {
    // Questa domanda gira dentro il ciclo dei broadcast, per ogni socket e per
    // ogni frame. Il motivo per cui la query è un OR di uguaglianze per tipo e
    // non `(subject_type, subject_id) IN (...)` su tuple è esattamente qui:
    // con le tuple SQLite rinuncia all'indice.
    const db = dbFresco();
    for (let i = 0; i < 200; i++) {
      putGrant(db, { kind: "device", id: `d${i}` }, "task", `t${i}`, { grantedAt: i });
    }
    const piano = (db.query(
      `EXPLAIN QUERY PLAN
       SELECT subject_type FROM grants
        WHERE resource_type = ? AND resource_id = ?
          AND ((subject_type = ? AND subject_id IN (?)))`,
    ).all("task", "t5", "device", "d5") as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | ");

    // Si asserisce cio' che CONTA — nessuna scansione — e non il nome di un
    // indice: qui SQLite sceglie l'indice UNIQUE come COVERING, che e' un seek
    // migliore. Pinnare il nome avrebbe fatto fallire il test su un piano
    // superiore al previsto, che e' il modo piu' stupido di perdere tempo.
    expect(piano).toMatch(/SEARCH grants USING (COVERING )?INDEX/);
    expect(piano).not.toContain("SCAN grants");
  });
});

describe("porta unica · per tipo", () => {
  it("grantedByType separa schede e chat", () => {
    const db = dbFresco();
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    putGrant(db, { kind: "device", id: "d1" }, "topic", "c1", { grantedAt: 1 });
    expect(grantedByType(db, deviceP("d1"))).toEqual({ task: ["t1"], topic: ["c1"] });
  });
});

describe("porta unica · il CHECK di oggi e la sua trappola", () => {
  it("lo schema ATTUALE (083) rifiuta un soggetto che non sia un dispositivo", () => {
    // È il fatto che rende necessaria la 084, e va pinnato: finché questo test
    // passa, `person` e `org` sono un vocabolario del codice e non dello schema.
    const db = dbFresco();
    let esploso = false;
    try {
      db.query(
        "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person','p1','task','t1','read',1)",
      ).run();
    } catch { esploso = true; }
    expect(esploso).toBe(true);
  });

  it("ma `putGrant` NON esplode: inghiotte in silenzio", () => {
    // `INSERT OR IGNORE` ignora anche le violazioni di CHECK. Quindi oggi
    // concedere a una persona non fallisce: non fa NIENTE, e chi ha condiviso
    // resta convinto di aver condiviso. È il difetto peggiore che questo
    // modulo possa avere, ed è la ragione per cui la 084 deve arrivare PRIMA
    // di qualunque interfaccia che offra persone e organizzazioni.
    const db = dbFresco();
    putGrant(db, { kind: "person", id: "p1" }, "task", "t1", { grantedAt: 1 });
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 0 });
    expect(hasGrant(db, [{ kind: "person", id: "p1" }], "task", "t1")).toBe(false);
  });
});
