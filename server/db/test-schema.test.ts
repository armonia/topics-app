/**
 * La DDL degli harness e la migration devono dire la STESSA cosa.
 *
 * Una copia libera di divergere è il modo in cui un test verde smette di
 * misurare la produzione: bastava che la migration guadagnasse un vincolo
 * (`CHECK` su `source`) e la copia no, e ogni test avrebbe accettato una riga
 * che il DB vero rifiuta. Qui il confronto è sul FILE `.sql`, normalizzato:
 * commenti via, spazi compattati.
 *
 * Per `tasks` il confronto non è su UNA migration ma sulla CATENA: la
 * `CREATE TABLE` della 001 più ogni `ALTER TABLE tasks ADD COLUMN` arrivato
 * dopo. È l'unico confronto che regge il caso normale con N agenti in
 * parallelo, cioè «main guadagna una colonna mentre il tuo ramo aspetta la
 * review»: chi la aggiunge trova UN test rosso che NOMINA la colonna, invece
 * di quattordici harness con `no such column` al momento della fusione.
  * @covers SCHEMA-03
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_LABELS_DDL, TASKS_DDL, TASKS_FK_STUBS_DDL } from "./test-schema";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Statement SQL confrontabile: niente commenti `--`, spazi normalizzati, niente `;`. */
function normalize(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim();
}

/** Il testo di una migration senza le righe di commento (la prosa contiene `;`). */
function sqlOf(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * L'ordine di applicazione, identico a `byVersionThenName` in server/db.ts:
 * prima il numero in testa, poi il nome. Il numero non è un'identità (due rami
 * paralleli possono produrre la stessa `089`), quindi da solo non è un ordine.
 */
function migrationsInOrder(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+-.+\.sql$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/^(\d+)-/)![1], 10);
      const vb = parseInt(b.match(/^(\d+)-/)![1], 10);
      return va - vb || (a < b ? -1 : a > b ? 1 : 0);
    });
}

/** Spezza sulle virgole di primo livello: quelle dentro `CHECK(... IN (...))` non contano. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

interface Column {
  /** Nome della colonna. */
  name: string;
  /** Tipo e vincoli, normalizzati: tutto quello che segue il nome. */
  def: string;
  /** Il file che la introduce, così il rosso dice anche DOVE guardare. */
  from: string;
}

/** Vincoli di TABELLA (non colonne): `PRIMARY KEY (a, b)`, `UNIQUE (...)`, `CHECK (...)`. */
const TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;

function parseColumnList(list: string, from: string): Column[] {
  const cols: Column[] = [];
  for (const raw of splitTopLevel(list)) {
    const c = raw.trim().replace(/\s+/g, " ");
    if (!c || TABLE_CONSTRAINT.test(c)) continue;
    const name = c.split(" ")[0]!;
    cols.push({ name, def: c.slice(name.length).trim(), from });
  }
  return cols;
}

/**
 * Le colonne che il database VERO ha dopo tutte le migration: la `CREATE TABLE`
 * più gli `ADD COLUMN`, meno gli eventuali `DROP COLUMN`. Nessuna migration
 * toglie oggi una colonna a `tasks`, ma su `topics` è già successo (067): un
 * `DROP` non gestito qui renderebbe questo test verde su uno schema che non
 * esiste più.
 */
function tasksColumnChain(): Column[] {
  const cols: Column[] = [];
  for (const file of migrationsInOrder()) {
    for (const stmt of sqlOf(file).split(/;\s*/)) {
      const created = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+tasks\s*\(([\s\S]*)\)\s*$/i);
      if (created) {
        cols.push(...parseColumnList(created[1]!, file));
        continue;
      }
      const added = stmt.match(/ALTER TABLE\s+tasks\s+ADD COLUMN\s+([\s\S]+)$/i);
      if (added) {
        cols.push(...parseColumnList(added[1]!, file));
        continue;
      }
      const dropped = stmt.match(/ALTER TABLE\s+tasks\s+DROP COLUMN\s+(\w+)/i);
      if (dropped) {
        const i = cols.findIndex((c) => c.name === dropped[1]);
        if (i >= 0) cols.splice(i, 1);
      }
    }
  }
  return cols;
}

/** Le colonne dichiarate in `TASKS_DDL`. */
function ddlColumns(): Column[] {
  const body = normalize(TASKS_DDL).match(/^CREATE TABLE IF NOT EXISTS tasks \(([\s\S]*)\)$/i);
  expect(body).not.toBeNull();
  return parseColumnList(body![1]!, "test-schema.ts");
}

describe("la DDL di test non deriva dalla migration", () => {
  test("TASK_LABELS_DDL è la CREATE TABLE della migration, parola per parola", () => {
    // La migration si cerca per NOME, non per numero: il numero si sposta ogni
    // volta che main se ne prende uno mentre il ramo è in volo (097 → 100, il
    // 12/08), e un `097-task-labels.sql` scritto qui dentro si è già rotto una
    // volta per quel motivo. Il nome invece è stabile, e se sparisse il test
    // fallirebbe — che è quello che deve fare.
    const matches = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+-task-labels\.sql$/.test(f));
    expect(matches).toHaveLength(1);
    // I commenti si tolgono PRIMA di spezzare sui `;`: la prosa dell'intestazione
    // ne contiene, e uno statement che comincia a metà di una frase non è uno
    // statement (ci ha già mentito una volta).
    const created = sqlOf(matches[0]!)
      .split(/;\s*/)
      .find((s) => /CREATE TABLE[\s\S]*task_labels/.test(s));
    expect(created).toBeDefined();
    expect(normalize(created!)).toBe(normalize(TASK_LABELS_DDL));
  });
});

describe("TASKS_DDL è la catena delle migration di `tasks`", () => {
  // Il test che si legge per primo quando è rosso: dice il NOME della colonna e
  // il file che l'ha portata. Chi aggiunge una migration la incolla in
  // TASKS_DDL, in fondo, e torna verde.
  test("nessuna colonna manca e nessuna è di troppo", () => {
    const chain = tasksColumnChain();
    expect(chain.length).toBeGreaterThan(50); // la catena si è davvero letta
    const dichiarate = new Set(ddlColumns().map((c) => c.name));
    const inCatena = new Set(chain.map((c) => c.name));
    expect({
      mancanti_in_TASKS_DDL: chain.filter((c) => !dichiarate.has(c.name)).map((c) => `${c.name} (${c.from})`),
      di_troppo_in_TASKS_DDL: [...dichiarate].filter((n) => !inCatena.has(n)),
    }).toEqual({ mancanti_in_TASKS_DDL: [], di_troppo_in_TASKS_DDL: [] });
  });

  test("ogni colonna ha tipo e vincoli della migration, parola per parola", () => {
    // Il nome uguale non basta: una copia senza il `NOT NULL` o senza il
    // `DEFAULT` accetta righe che il database vero rifiuta, ed è esattamente
    // il modo in cui un test verde smette di misurare la produzione.
    const attese = new Map(tasksColumnChain().map((c) => [c.name, c.def]));
    const diverse = ddlColumns()
      .filter((c) => attese.has(c.name) && attese.get(c.name) !== c.def)
      .map((c) => `${c.name}: TASKS_DDL "${c.def}" vs migration "${attese.get(c.name)}"`);
    expect(diverse).toEqual([]);
  });

  test("l'ordine è quello di applicazione, come nel database vero", () => {
    // Un `INSERT ... VALUES` posizionale scritto contro la produzione deve
    // funzionare anche negli harness, quindi l'ordine non è cosmetico.
    expect(ddlColumns().map((c) => c.name)).toEqual(tasksColumnChain().map((c) => c.name));
  });

  test("con le FK accese, TASKS_DDL + TASKS_FK_STUBS_DDL regge un insert", () => {
    // Il contratto degli stub, misurato. Con `foreign_keys = ON` una tabella
    // genitore assente non è un vincolo che non si applica: è un
    // `no such table` su OGNI insert, anche con la colonna a NULL.
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.run(TASKS_DDL);
    db.run(TASKS_FK_STUBS_DDL);
    db.run(TASK_LABELS_DDL);
    db.run(
      "INSERT INTO tasks (id, project_id, text, created_at, updated_at) VALUES ('t1', 'p', 'x', '2026-08-12', '2026-08-12')",
    );
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    db.close();
  });
});
