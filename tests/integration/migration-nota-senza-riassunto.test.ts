/**
 * `20260820235900-nota-senza-riassunto-visibile.sql` — le note già scritte
 * diventano visibili, e diventano l'ultima parola.
 *
 * IL CODICE NUOVO NON BASTA, ed è la lezione di questa migration.
 * `deliverToReviewBySystem` ora scrive «Consegna senza riassunto…» come
 * `kind: 'comment'` e dopo la chiusura del fan-out, così la card la mostra. Ma
 * quel cambio vale per le consegne FUTURE: le righe già in database restano
 * invisibili e fuori posto.
 *
 * Verificato a schermo il 20/08: cambiato il codice, ricostruito il bundle e
 * ricaricata l'app, la card `235afe11` mostrava ancora «Fan-out chiuso: 3
 * tentativi». Un fix che riguarda solo il futuro, su dati che qualcuno sta
 * guardando adesso, è mezzo fix.
 *
 * Il test gira il FILE della migration, non una sua copia riscritta qui, e su
 * dati che riproducono i tre casi veri trovati in database.
 *
 * @covers KANBAN-05
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260820235900-nota-senza-riassunto-visibile.sql"),
  "utf-8",
);

const NOTA = "Consegna senza riassunto: il turno e' finito prima che l'agente commentasse.";

function db(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT, author TEXT, content TEXT,
    kind TEXT DEFAULT 'comment', created_at TEXT)`);
  return d;
}
const ins = (d: Database, id: string, task: string, author: string, kind: string, content: string, ts: string) =>
  d.run("INSERT INTO task_comments VALUES (?,?,?,?,?,?)", [id, task, author, content, kind, ts]);

describe("la nota «senza riassunto» storica", () => {
  test("diventa visibile alla card (service → comment)", () => {
    const d = db();
    ins(d, '1', 't1', 'system', 'service', NOTA, '2026-08-20T19:18:15.403Z');
    d.run(SQL);
    expect(d.query("SELECT kind FROM task_comments WHERE id='1'").get()).toEqual({ kind: 'comment' });
    d.close();
  });

  /**
   * IL CASO `235afe11`: le due righe nascono nello stesso secondo con
   * millisecondi diversi (…15.403Z e …15.422Z) e rowid consecutivi. Anche
   * promossa, la nota resterebbe SOTTO il fan-out e la card mostrerebbe ancora
   * la contabilità.
   */
  test("e diventa l'ULTIMA parola, scavalcando la chiusura del fan-out", () => {
    const d = db();
    ins(d, '1', 't1', 'system', 'service', NOTA, '2026-08-20T19:18:15.403Z');
    ins(d, '2', 't1', 'system', 'comment', 'Fan-out chiuso: 3 tentativi, 1 con modifiche.', '2026-08-20T19:18:15.422Z');
    d.run(SQL);
    const ordinati = d.query(
      "SELECT content FROM task_comments WHERE task_id='t1' ORDER BY created_at ASC, rowid ASC",
    ).all() as Array<{ content: string }>;
    d.close();
    expect(ordinati[ordinati.length - 1]!.content).toContain("senza riassunto");
  });

  /**
   * L'ALTRA PORTA resta com'era, di proposito: quando dopo la nota arriva una
   * DOMANDA con i suoi bottoni, promuoverla le ruberebbe la cima della card —
   * cioè l'unica cosa che tiene ferma la review.
   */
  test("non tocca le note seguite da una domanda", () => {
    const d = db();
    ins(d, '1', 't1', 'system', 'service', NOTA, '2026-08-20T19:18:15.403Z');
    ins(d, '2', 't1', 'system', 'comment', '```question\nChe faccio?\n- Vai\n```', '2026-08-20T19:20:00.000Z');
    d.run(SQL);
    expect(d.query("SELECT kind FROM task_comments WHERE id='1'").get()).toEqual({ kind: 'service' });
    d.close();
  });

  /** Ri-eseguibile: una migration può girare due volte su database diversi. */
  test("girata due volte non cambia niente la seconda", () => {
    const d = db();
    ins(d, '1', 't1', 'system', 'service', NOTA, '2026-08-20T19:18:15.403Z');
    ins(d, '2', 't1', 'system', 'comment', 'Fan-out chiuso: 3 tentativi.', '2026-08-20T19:18:15.422Z');
    d.run(SQL);
    const dopoUna = d.query("SELECT created_at FROM task_comments WHERE id='1'").get() as { created_at: string };
    d.run(SQL);
    const dopoDue = d.query("SELECT created_at FROM task_comments WHERE id='1'").get() as { created_at: string };
    d.close();
    // Il secondo giro non sposta di un altro secondo: il `WHERE` non trova più
    // un fan-out nello stesso secondo, perché la nota si è già spostata.
    expect(dopoDue.created_at).toBe(dopoUna.created_at);
  });

  /** Un commento umano non finisce mai in questo insieme. */
  test("non tocca quello che ha scritto una persona", () => {
    const d = db();
    ins(d, '1', 't1', 'user', 'comment', NOTA, '2026-08-20T19:18:15.403Z');
    d.run(SQL);
    expect(d.query("SELECT kind FROM task_comments WHERE id='1'").get()).toEqual({ kind: 'comment' });
    d.close();
  });
});

/**
 * `20260821000500-nota-senza-riassunto-ordine.sql` — il completamento.
 *
 * La migration precedente e' stata applicata su questo database mentre
 * conteneva ancora la sola prima UPDATE (un test l'ha eseguita prima che
 * finissi di scriverla). `schema_migrations` la da' per applicata, quindi non
 * rigirera' mai: la seconda parte serve a se' stante.
 *
 * Deve valere per ENTRAMBI i casi — chi ha preso la versione parziale e chi ha
 * preso quella intera — e il secondo e' provato qui perche' e' quello che si
 * rompe in silenzio: se non fosse idempotente, sposterebbe di un altro secondo
 * righe gia' a posto.
 */
describe("il completamento dell'ordine", () => {
  const ORDINE = fs.readFileSync(
    path.join(PROJECT_ROOT, "server/db/migrations/20260821000500-nota-senza-riassunto-ordine.sql"),
    "utf-8",
  );

  test("chi ha preso la versione PARZIALE viene completato", () => {
    const d = db();
    // Stato dopo la sola prima UPDATE: kind promosso, ordine ancora sbagliato.
    ins(d, '1', 't1', 'system', 'comment', NOTA, '2026-08-20T19:18:15.403Z');
    ins(d, '2', 't1', 'system', 'comment', 'Fan-out chiuso: 3 tentativi.', '2026-08-20T19:18:15.422Z');
    d.run(ORDINE);
    const o = d.query("SELECT content FROM task_comments WHERE task_id='t1' ORDER BY created_at ASC, rowid ASC")
      .all() as Array<{ content: string }>;
    d.close();
    expect(o[o.length - 1]!.content).toContain("senza riassunto");
  });

  test("chi ha preso la versione INTERA non cambia di un millisecondo", () => {
    const d = db();
    // Stato dopo entrambe le UPDATE: la nota e' gia' dopo il fan-out.
    ins(d, '1', 't1', 'system', 'comment', NOTA, '2026-08-20T19:18:16.403Z');
    ins(d, '2', 't1', 'system', 'comment', 'Fan-out chiuso: 3 tentativi.', '2026-08-20T19:18:15.422Z');
    d.run(ORDINE);
    const ts = (d.query("SELECT created_at FROM task_comments WHERE id='1'").get() as { created_at: string }).created_at;
    d.close();
    expect(ts).toBe('2026-08-20T19:18:16.403Z');
  });
});
