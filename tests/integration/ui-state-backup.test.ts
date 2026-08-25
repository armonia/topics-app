/**
 * Integration test for the ui-state backup service (post-mortem fix).
 * Verifies the snapshot+retention contract that protects pane-store-v2
 * from being wiped by buggy client PUTs.
  * @covers RUNTIME-14
 */
import { describe, expect, test, beforeAll, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, testTmpDir } from "./helpers";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


const TEST_HOME = testTmpDir("ui-backup-home");
const TEST_DATA = testTmpDir("ui-backup-data");

beforeAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  process.env.TOPICS_HOME = TEST_HOME;
  process.env.DATA_DIR = TEST_DATA;
});

afterEach(() => {
  // Clear backups dir between tests so retention logic stays predictable.
  fs.rmSync(join(TEST_HOME, "ui-state-backups"), { recursive: true, force: true });
});

async function loadModules() {
  const { createAppContext } = await import("../../server/utils");
  const ctx = createAppContext(PROJECT_ROOT);
  // Seed a row so the backup has content.
  ctx.db.run(
    `INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq, updated_at)
     VALUES ('test:backup', '{"hello":"world"}', 2, 99, datetime('now'))`,
  );
  const backup = await import("../../server/services/ui-state-backup");
  return { ctx, backup };
}

describe("ui-state-backup", () => {

  test("snapshotUiStateNow writes a JSON file with the current ui_state rows", async () => {
    const { ctx, backup } = await loadModules();
    backup.snapshotUiStateNow(ctx.db);
    const dir = join(TEST_HOME, "ui-state-backups");
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const parsed = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf-8"));
    expect(parsed.rows.find((r: any) => r.key === "test:backup")).toBeDefined();
    expect(parsed.rows.find((r: any) => r.key === "test:backup").server_seq).toBe(99);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("backups are atomic — no .tmp file remains after snapshotUiStateNow", async () => {
    const { ctx, backup } = await loadModules();
    backup.snapshotUiStateNow(ctx.db);
    const files = fs.readdirSync(join(TEST_HOME, "ui-state-backups"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("retention sweep keeps the newest 24 and unlinks older", async () => {
    const { ctx, backup } = await loadModules();
    // Make 30 snapshots back-to-back. Each adds a file with a unique
    // timestamp; the retention sweep then drops the 6 oldest.
    for (let i = 0; i < 30; i++) {
      backup.snapshotUiStateNow(ctx.db);
      // Tiny delay so the ISO timestamp differs per snapshot.
      await new Promise((r) => setTimeout(r, 8));
    }
    const dir = join(TEST_HOME, "ui-state-backups");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(24);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("listUiStateBackups returns paths sorted newest-first", async () => {
    const { ctx, backup } = await loadModules();
    for (let i = 0; i < 3; i++) {
      backup.snapshotUiStateNow(ctx.db);
      await new Promise((r) => setTimeout(r, 8));
    }
    const list = backup.listUiStateBackups();
    expect(list.length).toBe(3);
    // Newest first: each entry's mtime > the next.
    for (let i = 0; i < list.length - 1; i++) {
      const a = fs.statSync(list[i]).mtimeMs;
      const b = fs.statSync(list[i + 1]).mtimeMs;
      expect(a).toBeGreaterThanOrEqual(b);
    }

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("snapshot file is mode 0600 (sensitive payload may include tokens)", async () => {
    const { ctx, backup } = await loadModules();
    backup.snapshotUiStateNow(ctx.db);
    const file = backup.listUiStateBackups()[0];
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
