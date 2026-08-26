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
import { resolveStateDir } from "../../server/lib/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const START_TEST_SERVER = readFileSync(join(ROOT, "scripts/start-test-server.sh"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "server.ts"), "utf8");

describe("E2E-ISO-01 · il banco non scrive nella cartella viva", () => {
  test("resolveStateDir onora TOPICS_DATA_DIR invece della cartella del repo", () => {
    const previous = process.env.TOPICS_DATA_DIR;
    const dedicated = join("/tmp", `topics-iso-${process.pid}-${Date.now()}`);
    try {
      process.env.TOPICS_DATA_DIR = dedicated;
      expect(resolveStateDir(ROOT)).toBe(dedicated);
    } finally {
      if (previous === undefined) delete process.env.TOPICS_DATA_DIR;
      else process.env.TOPICS_DATA_DIR = previous;
    }
  });

  test("IL DIFETTO: senza quella variabile lo stato cade sul REPO — ecco perche' l'export porta carico", () => {
    const previous = process.env.TOPICS_DATA_DIR;
    try {
      delete process.env.TOPICS_DATA_DIR;
      expect(resolveStateDir(ROOT)).toBe(ROOT);
    } finally {
      if (previous !== undefined) process.env.TOPICS_DATA_DIR = previous;
    }
  });

  test("start-test-server.sh esporta TOPICS_DATA_DIR, e lo fa derivare da DATA_DIR", () => {
    const line = START_TEST_SERVER.split("\n").find((l) => l.trim().startsWith("export TOPICS_DATA_DIR="));
    expect(line, "l'export e' sparito: lo stato del banco tornerebbe nel repo").toBeDefined();
    expect(line!, "deve seguire DATA_DIR, o le due cartelle divergono").toContain("$DATA_DIR");
  });

  test("l'export sta DOPO la riga che definisce DATA_DIR, o eredita una variabile vuota", () => {
    const lines = START_TEST_SERVER.split("\n");
    const iData = lines.findIndex((l) => l.trim().startsWith("export DATA_DIR="));
    const iState = lines.findIndex((l) => l.trim().startsWith("export TOPICS_DATA_DIR="));
    expect(iData).toBeGreaterThanOrEqual(0);
    expect(iState).toBeGreaterThan(iData);
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
