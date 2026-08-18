/**
 * Il cancello del hot-reload rifiuta una migration SQL rotta.
 *
 * Il bun build prova l'albero JS, ma le migration SQL non passano di lì.
 * server/db.ts le applica all'avvio, e una .sql con un errore di sintassi fa
 * morire il boot. Il 17/08: 506 boot falliti in 10 minuti e 38 secondi
 * (01:00:48 → 01:11:26), un tentativo al secondo, senza nessun freno.
 *
 * Questo test lancia il cancello VERO su un repo sintetico con:
 *   A. una migration ROTTA pending → exit 1 (il server vecchio resta su)
 *   B. nessuna migration pending → exit 0
 *   C. una migration VALIDA pending → exit 0
 *   D. nessun DB sul disco → exit 0 (primo avvio, sicuro per definizione)
 *   E. sqlite3 assente → exit 0 (degradazione silenziosa, meglio un reload)
 *
 * Il cancello NON tocca il DB vivo: tutte le prove usano una copia.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATE = join(REPO_ROOT, "scripts", "server-reload-gate.sh");

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Struttura minima di APP_DIR che soddisfa il cancello. */
function appDirFinto(opts: {
  migrations?: Array<{ name: string; sql: string; applied?: boolean }>;
  withDb?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));

  // server/db/migrations/
  const migsDir = join(dir, "server", "db", "migrations");
  mkdirSync(migsDir, { recursive: true });

  // server.ts finto che bun build risolve (albero JS minimale).
  writeFileSync(join(dir, "server.ts"), "export const x = 1;\n");

  // DB finto con schema_migrations.
  if (opts.withDb !== false) {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, "topics.db"));
    db.run(`CREATE TABLE schema_migrations (
      version INTEGER NOT NULL,
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);

    for (const m of opts.migrations ?? []) {
      writeFileSync(join(migsDir, m.name), m.sql);
      if (m.applied) {
        db.run("INSERT INTO schema_migrations VALUES (1, ?, ?)", [m.name, new Date().toISOString()]);
      }
    }
    db.close();
  } else {
    // Nessun DB: scrivi solo le migration.
    for (const m of opts.migrations ?? []) {
      writeFileSync(join(migsDir, m.name), m.sql);
    }
  }

  return dir;
}

/** Lancia il cancello vero nel dir fornito. */
function eseguiCancello(appDir: string, env?: Record<string, string>): { code: number; out: string } {
  const proc = Bun.spawnSync(["bash", GATE, appDir], {
    env: {
      ...process.env,
      DATA_DIR: join(appDir, "data"),
      ...(env ?? {}),
    },
  });
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

const daPulire: string[] = [];
afterEach(() => {
  for (const d of daPulire.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─── test ────────────────────────────────────────────────────────────────────

describe("server-reload-gate.sh — cancello migration SQL", () => {
  it("A: migration pending ROTTA → exit 1, non tocca il DB vivo", () => {
    const dir = appDirFinto({
      migrations: [
        { name: "20260817120000-ok.sql", sql: "SELECT 1;", applied: true },
        { name: "20260817120001-broken.sql", sql: "THIS IS NOT SQL!!!", applied: false },
      ],
    });
    daPulire.push(dir);

    const { code, out } = eseguiCancello(dir);

    expect(code).toBe(1);
    // dice il nome della migration che ha fallito
    expect(out).toContain("20260817120001-broken.sql");
    // dice che il server vecchio resta su
    expect(out).toContain("server vecchio resta su");
    // il DB vivo NON è stato modificato (la migration rotta non è nel registro)
    const db = new Database(join(dir, "data", "topics.db"), { readonly: true });
    const row = db.query("SELECT name FROM schema_migrations WHERE name = '20260817120001-broken.sql'").get();
    db.close();
    expect(row).toBeNull();
  });

  it("B: nessuna migration pending → exit 0", () => {
    const dir = appDirFinto({
      migrations: [
        { name: "20260817120000-ok.sql", sql: "SELECT 1;", applied: true },
      ],
    });
    daPulire.push(dir);
    expect(eseguiCancello(dir).code).toBe(0);
  });

  it("C: migration pending VALIDA → exit 0", () => {
    const dir = appDirFinto({
      migrations: [
        { name: "20260817120000-ok.sql", sql: "SELECT 1;", applied: true },
        { name: "20260817120001-valid.sql", sql: "CREATE TABLE IF NOT EXISTS _gate_probe (id INTEGER PRIMARY KEY);", applied: false },
      ],
    });
    daPulire.push(dir);
    expect(eseguiCancello(dir).code).toBe(0);
  });

  it("D: DB non ancora creato → exit 0 (primo avvio)", () => {
    const dir = appDirFinto({
      withDb: false,
      migrations: [
        { name: "20260817120001-broken.sql", sql: "THIS IS NOT SQL!!!", applied: false },
      ],
    });
    daPulire.push(dir);
    // DATA_DIR punta a una dir vuota
    const { code } = eseguiCancello(dir, { DATA_DIR: join(dir, "data") });
    expect(code).toBe(0);
  });

  it("E: sqlite3 non trovato → exit 0 (degradazione silenziosa)", () => {
    const dir = appDirFinto({
      migrations: [
        { name: "20260817120001-broken.sql", sql: "THIS IS NOT SQL!!!", applied: false },
      ],
    });
    daPulire.push(dir);

    // Creiamo una dir fake-bin con uno stub sqlite3 che NON ESISTE,
    // e un bun reale ri-esportato. In cima al PATH ci mette solo questa dir +
    // la dir di bun, escludendo /usr/bin dove sqlite3 e' installato.
    const fakeBin = mkdtempSync(join(tmpdir(), "fake-bin-"));
    daPulire.push(fakeBin);
    // nessun sqlite3 in fake-bin: lo omettiamo deliberatamente

    // Copia il bun reale in fake-bin cosi' e' disponibile senza /usr/bin.
    const bunReal = Bun.which("bun") ?? "";
    if (bunReal) {
      try { symlinkSync(bunReal, join(fakeBin, "bun")); } catch {}
    }

    // PATH: solo fake-bin + /bin (shell comandi base), NO /usr/bin → no sqlite3.
    const fakePath = [fakeBin, "/bin"].join(":");

    const { code } = eseguiCancello(dir, { PATH: fakePath });
    // Il cancello non può verificare: non blocca (exit 0)
    expect(code).toBe(0);
  });
});
