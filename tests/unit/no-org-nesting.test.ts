/**
 * Le organizzazioni non si annidano.
 *
 * Questo test è l'UNICO allarme che quella decisione avrà, ed è il motivo per
 * cui esiste come file separato invece che come commento nella migration.
 *
 * La profondità fissa a due — dispositivo → persona → organizzazioni — non è un
 * default prudente: è la CONDIZIONE DI VALIDITÀ del disegno intero. Risolvere i
 * principali a tempo di lettura invece di materializzarli in righe si regge
 * sull'essere un cammino di lunghezza nota, cioè una JOIN. Con `orgs.parent_id`
 * diventa un grafo da girare, e a quel punto tre cose cambiano insieme: il costo
 * per richiesta smette di essere limitato, la domanda inversa («chi vede questa
 * cosa?») smette di avere una risposta esatta, e la ciclicità diventa un
 * controllo a runtime invece di una conseguenza dei tipi.
 *
 * Il punto è che nessuna di quelle tre cose fa rumore il giorno in cui si
 * aggiunge la colonna. Si aggiunge, tutto continua a funzionare, e l'argomento
 * che regge il modello è caduto senza che nessuno lo sappia. Quando questo test
 * fallisce, la risposta giusta non è cancellarlo: è rifare il conto da capo.
 *
 * @covers GUEST-06
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRAZIONI = join(import.meta.dir, "..", "..", "server", "db", "migrations");

describe("le organizzazioni non si annidano", () => {
  it("nessuna migration introduce un genitore su `orgs`", () => {
    const colpevoli: string[] = [];
    for (const f of readdirSync(MIGRAZIONI)) {
      if (!f.endsWith(".sql")) continue;
      const sql = readFileSync(join(MIGRAZIONI, f), "utf8");
      // Righe di commento fuori: la parola può comparire in una spiegazione.
      const codice = sql.split("\n").filter((r) => !r.trim().startsWith("--")).join("\n");
      if (/\borgs\b[\s\S]{0,400}?\bparent_id\b/i.test(codice) || /ALTER\s+TABLE\s+orgs\b[\s\S]{0,200}?\bparent/i.test(codice)) {
        colpevoli.push(f);
      }
    }
    expect(colpevoli).toEqual([]);
  });

  it("il setaccio riconosce ciò che cerca — cioè non è vacuo", () => {
    // Senza questo, una regex sbagliata renderebbe il guardiano cieco e
    // silenzioso, che è il modo peggiore per un allarme di fallire.
    const finto = "CREATE TABLE orgs (\n  id TEXT PRIMARY KEY,\n  parent_id TEXT REFERENCES orgs(id)\n);";
    const codice = finto.split("\n").filter((r) => !r.trim().startsWith("--")).join("\n");
    expect(/\borgs\b[\s\S]{0,400}?\bparent_id\b/i.test(codice)).toBe(true);
  });

  it("e la 084 dichiara `orgs` senza genitore", () => {
    const sql = readFileSync(join(MIGRAZIONI, "084-people-orgs.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS orgs");
    const corpo = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS orgs"));
    const fine = corpo.indexOf(");");
    expect(corpo.slice(0, fine)).not.toMatch(/parent/i);
  });
});
