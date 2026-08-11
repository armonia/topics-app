/**
 * La DDL degli harness e la migration devono dire la STESSA cosa.
 *
 * Una copia libera di divergere è il modo in cui un test verde smette di
 * misurare la produzione: bastava che la migration guadagnasse un vincolo
 * (`CHECK` su `source`) e la copia no, e ogni test avrebbe accettato una riga
 * che il DB vero rifiuta. Qui il confronto è sul FILE `.sql`, normalizzato:
 * commenti via, spazi compattati.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_LABELS_DDL } from "./test-schema";

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

describe("la DDL di test non deriva dalla migration", () => {
  test("TASK_LABELS_DDL è la CREATE TABLE della 097, parola per parola", () => {
    // I commenti si tolgono PRIMA di spezzare sui `;`: la prosa dell'intestazione
    // ne contiene, e uno statement che comincia a metà di una frase non è uno
    // statement (ci ha già mentito una volta).
    const sql = readFileSync(join(import.meta.dir, "migrations", "097-task-labels.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const created = sql.split(/;\s*/).find((s) => /CREATE TABLE[\s\S]*task_labels/.test(s));
    expect(created).toBeDefined();
    expect(normalize(created!)).toBe(normalize(TASK_LABELS_DDL));
  });
});
