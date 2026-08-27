/**
 * @covers E2E-ISO-01 @covers BOOT-NONFATAL-01
 *
 * TWO RULES BORN OF THE SAME INCIDENT (25/08/2026), and neither of them had a
 * line of coverage.
 *
 * Out of four e2e shards, one died AT BOOT with an ENOENT on the rename of
 * `data/usage/summary.json.tmp.<pid>.<ts>`, and 253 tests never started. Behind
 * it were three defects in a row; the two kept here are the ones about STARTUP
 * and ISOLATION (the third, the destructive cleanup, lives in
 * `server/usage/store-tmp-cleanup.test.ts`).
 *
 * WHY ONE HALF IS STRUCTURAL. Proving "the server starts even if the summary
 * cannot be written" for real means booting a server on a broken disk: the kind
 * of rig that costs more than it defends. The house already carries this
 * compromise in `scripts/start-prod-backoff.test.ts`, and the rule that keeps it
 * from being vacuous is the same: what gets asserted is the SHAPE that makes the
 * defect impossible, and the catch is required to SAY something — a startup that
 * swallows in silence is how the defect comes back unseen.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveDataDir, resolveStateDir } from "../../server/lib/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const START_TEST_SERVER = readFileSync(join(ROOT, "scripts/start-test-server.sh"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "server.ts"), "utf8");

describe("E2E-ISO-01 · il banco non scrive nella cartella viva", () => {
  test("resolveStateDir onora TOPICS_DATA_DIR invece della cartella del repo", () => {
    const dedicated = join("/tmp", `topics-iso-${process.pid}-${Date.now()}`);
    expect(resolveStateDir(ROOT, { TOPICS_DATA_DIR: dedicated } as NodeJS.ProcessEnv)).toBe(dedicated);
  });

  test("e onora anche DATA_DIR: era l'altro nome, ora entra dalla stessa porta", () => {
    const dedicated = join("/tmp", `topics-iso-${process.pid}-${Date.now()}-vecchio`);
    expect(resolveStateDir(ROOT, { DATA_DIR: dedicated } as NodeJS.ProcessEnv)).toBe(dedicated);
  });

  test("IL DIFETTO: senza NESSUNA delle due lo stato cade sul REPO", () => {
    expect(resolveStateDir(ROOT, {} as NodeJS.ProcessEnv)).toBe(ROOT);
  });

  test("start-test-server.sh isola con una variabile sola, e non ha piu' bisogno del ponte", () => {
    const lines = START_TEST_SERVER.split("\n");
    const data = lines.find((l) => l.trim().startsWith("export DATA_DIR="));
    expect(data, "sparita la riga che isola i dati del banco").toBeDefined();
    const bridge = lines.find((l) => l.trim().startsWith("export TOPICS_DATA_DIR="));
    expect(
      bridge,
      "la riga-ponte e' tornata: se serve, l'unificazione in server/lib/data-dir.ts si e' rotta",
    ).toBeUndefined();
  });

  test("il banco resta isolato con il SOLO DATA_DIR, che e' la prova dell'unificazione", () => {
    // Nobody creates this directory: the string only goes into `resolveStateDir`
    // to check that it comes back unchanged.
    const dataDir = "/tmp/topics-test-data-13334"; // allow-shared-tmp: a value, not a directory
    const env = { DATA_DIR: dataDir } as NodeJS.ProcessEnv;
    expect(resolveStateDir(ROOT, env), "topics.json, uploads/, messages/ finirebbero nel repo vivo").toBe(dataDir);
    expect(resolveDataDir(resolveStateDir(ROOT, env), env), "data/usage/ condivisa fra shard").toBe(dataDir);
  });
});

describe("BOOT-NONFATAL-01 · un file rigenerabile non decide se l'app parte", () => {
  test("rebuildSummary() all'avvio sta dentro un try", () => {
    const line = SERVER_TS.split("\n").find((l) => l.includes("rebuildSummary()"));
    expect(line, "la chiamata di avvio e' sparita o si e' spostata").toBeDefined();
    expect(line!.trim(), "una chiamata nuda qui uccide il server sul disco pieno").toStartWith("try {");
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
