/**
 * @covers E2E-ISO-01 @covers BOOT-NONFATAL-01
 *
 * DUE REGOLE NATE DALLO STESSO INCIDENTE (25/08/2026), e nessuna delle due
 * aveva una riga di copertura.
 *
 * Su quattro shard e2e, uno e' morto AL BOOT con un ENOENT sul rinomina di
 * `data/usage/summary.json.tmp.<pid>.<ts>`, e 253 test non sono mai partiti.
 * Dietro c'erano tre difetti in fila; qui stanno i due che riguardano
 * l'AVVIO e l'ISOLAMENTO (il terzo, la pulizia distruttiva, e' in
 * `server/usage/store-tmp-cleanup.test.ts`).
 *
 * PERCHE' UNA META' E' STRUTTURALE. Provare «il server parte anche se il
 * riassunto non si scrive» per davvero vuol dire accendere un server con il
 * disco rotto: e' il genere di banco che costa piu' di quanto difende. La casa
 * ha gia' questo compromesso in `scripts/start-prod-backoff.test.ts`, e la
 * regola per non renderlo vacuo e' la stessa: si asserisce la FORMA che rende
 * il difetto impossibile, e si pretende che il catch DICA qualcosa — un avvio
 * che ingoia in silenzio e' il modo in cui il difetto torna senza farsi vedere.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveStateDir } from "../../server/lib/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const START_TEST_SERVER = readFileSync(join(ROOT, "scripts/start-test-server.sh"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "server.ts"), "utf8");

describe("E2E-ISO-01 · il banco non scrive nella cartella viva", () => {
  test("resolveStateDir onora TOPICS_DATA_DIR invece della cartella del repo", () => {
    const prima = process.env.TOPICS_DATA_DIR;
    const dedicata = join("/tmp", `topics-iso-${process.pid}-${Date.now()}`);
    try {
      process.env.TOPICS_DATA_DIR = dedicata;
      expect(resolveStateDir(ROOT)).toBe(dedicata);
    } finally {
      if (prima === undefined) delete process.env.TOPICS_DATA_DIR;
      else process.env.TOPICS_DATA_DIR = prima;
    }
  });

  test("IL DIFETTO: senza quella variabile lo stato cade sul REPO — ecco perche' l'export porta carico", () => {
    const prima = process.env.TOPICS_DATA_DIR;
    try {
      delete process.env.TOPICS_DATA_DIR;
      expect(resolveStateDir(ROOT)).toBe(ROOT);
    } finally {
      if (prima !== undefined) process.env.TOPICS_DATA_DIR = prima;
    }
  });

  test("start-test-server.sh esporta TOPICS_DATA_DIR, e lo fa derivare da DATA_DIR", () => {
    const riga = START_TEST_SERVER.split("\n").find((l) => l.trim().startsWith("export TOPICS_DATA_DIR="));
    expect(riga, "l'export e' sparito: lo stato del banco tornerebbe nel repo").toBeDefined();
    expect(riga!, "deve seguire DATA_DIR, o le due cartelle divergono").toContain("$DATA_DIR");
  });

  test("l'export sta DOPO la riga che definisce DATA_DIR, o eredita una variabile vuota", () => {
    const righe = START_TEST_SERVER.split("\n");
    const iData = righe.findIndex((l) => l.trim().startsWith("export DATA_DIR="));
    const iState = righe.findIndex((l) => l.trim().startsWith("export TOPICS_DATA_DIR="));
    expect(iData).toBeGreaterThanOrEqual(0);
    expect(iState).toBeGreaterThan(iData);
  });
});

describe("BOOT-NONFATAL-01 · un file rigenerabile non decide se l'app parte", () => {
  test("rebuildSummary() all'avvio sta dentro un try", () => {
    const riga = SERVER_TS.split("\n").find((l) => l.includes("rebuildSummary()"));
    expect(riga, "la chiamata di avvio e' sparita o si e' spostata").toBeDefined();
    expect(riga!.trim(), "una chiamata nuda qui uccide il server sul disco pieno").toStartWith("try {");
  });

  test("e il catch DICE cosa non e' riuscito, invece di ingoiare", () => {
    const i = SERVER_TS.split("\n").findIndex((l) => l.includes("rebuildSummary()"));
    const catchLine = SERVER_TS.split("\n")[i + 1] ?? "";
    expect(catchLine, "manca il catch subito dopo").toContain("catch");
    expect(
      /console\.(error|warn|log)/.test(catchLine),
      "un catch muto e' come il difetto torna senza farsi vedere",
    ).toBe(true);
  });
});
