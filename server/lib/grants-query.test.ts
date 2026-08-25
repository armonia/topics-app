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
 * @covers GUEST-01, GUEST-06
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DDL } from "../db/test-schema";
import {
  hasGrant, grantedResourceIds, grantedByType, reasonsFor, subjectsOf,
  holdsGrantOnTaskPreview, escapeLike, putGrant, dropGrant, deviceP,
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
    UNIQUE (subject_type, subject_id, resource_type, resource_id))`);
  db.run("CREATE INDEX idx_grants_resource ON grants(resource_type, resource_id)");
  return db;
}

/**
 * Lo schema dopo 20260816230500: `project` è una risorsa condivisibile.
 *
 * Serve una tabella a parte perché SQLite non altera un CHECK in posto, ed è la
 * stessa ragione per cui `conSchema084` esiste sopra.
 */
function conProgetti(db: Database): Database {
  db.run("DROP TABLE grants");
  db.run(`CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('device','person','org')),
    subject_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('task','topic','project')),
    resource_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'read' CHECK (level IN ('read','deny')),
    via_type TEXT, via_id TEXT, granted_at INTEGER NOT NULL,
    UNIQUE (subject_type, subject_id, resource_type, resource_id))`);
  db.run("CREATE INDEX idx_grants_resource ON grants(resource_type, resource_id)");
  return db;
}

/** Un task dentro un progetto: l'unico contenitore che oggi esiste. */
function taskNelProgetto(db: Database, taskId: string, projectId: string): void {
  db.run(
    "INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at)"
    + " VALUES (?, ?, 'x', 'todo', 2, 0, '2026-01-01', '2026-01-01')",
    [taskId, projectId],
  );
}

describe("condividere un PROGETTO apre i suoi task", () => {
  let db: Database;
  beforeEach(() => { db = conProgetti(dbFresco()); });

  it("il task si vede attraverso il progetto che lo contiene", () => {
    // È il punto della card: la condivisione resta UNA riga sul progetto, e i
    // task la ereditano in lettura. Nessuna riga derivata da mantenere quando
    // un task nasce, si sposta o viene archiviato.
    taskNelProgetto(db, "t1", "p1");
    expect(hasGrant(db, deviceP("d1"), "task", "t1"), "prima: niente").toBe(false);
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "t1"), "dopo: il progetto apre il task").toBe(true);
  });

  it("un task di un ALTRO progetto resta chiuso", () => {
    // Il caso che conta: un cancello che non nega non è un cancello.
    taskNelProgetto(db, "t1", "p1");
    taskNelProgetto(db, "t2", "p2");
    putGrant(db, { kind: "device", id: "d1" }, "project", "p1", { grantedAt: 1 });
    expect(hasGrant(db, deviceP("d1"), "task", "t2")).toBe(false);
  });

  it("il DENY sul singolo task vince sul progetto condiviso", () => {
    // «Questo progetto è condiviso, TRANNE questo task» dev'essere dicibile, o
    // condividere un progetto diventa una porta che non si può più chiudere su
    // un pezzo solo.
    taskNelProgetto(db, "t1", "p1");
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
    taskNelProgetto(db, "t1", "p1");
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
    taskNelProgetto(db, "t1", "p1");
    putGrant(db, { kind: "device", id: "d1" }, "task", "t1", { grantedAt: 1 });
    const ragioni = reasonsFor(db, deviceP("d1"), "task", "t1");
    expect(ragioni).toHaveLength(1);
    expect(ragioni[0].viaType).toBeUndefined();
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
