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
 *   F. migration ROTTA senza DATA_DIR nell'env → exit 1 (percorso default corretto)
 *
 * Il cancello NON tocca il DB vivo: tutte le prove usano una copia.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
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

/**
 * Lancia il cancello vero nel dir fornito.
 *
 * Per default NON inietta DATA_DIR: il cancello deve trovare il DB dal percorso
 * di default (<APP_DIR>/data/topics.db), identico a quello di server/db.ts.
 * Passa `env.DATA_DIR` esplicitamente solo se vuoi sovrascrivere il default
 * (es. test D che punta a una dir vuota per simulare il primo avvio).
 */
function eseguiCancello(appDir: string, env?: Record<string, string>): { code: number; out: string } {
  // Rimuoviamo DATA_DIR dall'ambiente ereditato: non deve influenzare il default.
  const baseEnv = { ...process.env };
  delete baseEnv["DATA_DIR"];
  delete baseEnv["TOPICS_DATA_DIR"];

  const proc = Bun.spawnSync(["bash", GATE, appDir], {
    env: {
      ...baseEnv,
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

    /* IL PATH VERO, MENO `sqlite3`. Uno specchio, non una lista scritta a mano.
     *
     * Due versioni precedenti hanno sbagliato lo stesso bersaglio in due modi, e
     * il test passava comunque:
     *  1. togliere `/usr/bin` e tenere `/bin`. Su macOS nasconde `sqlite3`; su
     *     Ubuntu no, perche' con usrmerge `/bin` E' `/usr/bin`. Verde qui, rosso
     *     solo su Linux, ed e' il rosso che questo commit chiude.
     *  2. elencare i comandi che il cancello usa. La lista dimenticava `cp`, e
     *     il cancello moriva su «impossibile copiare il DB» PRIMA di arrivare a
     *     `sqlite3`: usciva 0 per il motivo sbagliato, cioe' il test verde non
     *     provava piu' niente.
     *
     * Specchiare tutto il PATH e togliere una sola cosa non ha nessuna delle due
     * debolezze: non si puo' dimenticare un comando, e non dipende da come una
     * distribuzione dispone le sue cartelle. */
    const fakeBin = mkdtempSync(join(tmpdir(), "fake-bin-"));
    daPulire.push(fakeBin);
    for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      let voci: string[];
      try { voci = readdirSync(d); } catch { continue; }
      for (const nome of voci) {
        if (nome === "sqlite3") continue;
        try { symlinkSync(join(d, nome), join(fakeBin, nome)); } catch { /* prima occorrenza vince, come il PATH */ }
      }
    }
    // La precondizione E' il test: senza, un `sqlite3` sfuggito lo renderebbe
    // verde senza provare nulla, che e' gia' successo due volte.
    expect(Bun.which("sqlite3", { PATH: fakeBin })).toBeNull();
    expect(Bun.which("cp", { PATH: fakeBin })).not.toBeNull();

    const fakePath = fakeBin;

    const { code } = eseguiCancello(dir, { PATH: fakePath });
    // Il cancello non può verificare: non blocca (exit 0)
    expect(code).toBe(0);
  });

  it("F: migration ROTTA senza DATA_DIR → exit 1 (percorso default = APP_DIR/data)", () => {
    // Questo è il caso che falsificava il cancello:
    //   $ echo "CREATE TABEL rotta(" > server/db/migrations/29990101000000-prova-rotta.sql
    //   $ bash scripts/server-reload-gate.sh <appdir>
    //   exit=0   ← SBAGLIATO, doveva essere 1
    //
    // La causa: lo script cercava ~/.openclaw/data/topics.db (non esistente),
    // trovava `if [ ! -f "$DB_PATH" ] → exit 0` e usciva verde senza guardare niente.
    // La correzione: se DATA_DIR non è nell'env, il default è <APP_DIR>/data,
    // identico a server/db.ts:17 — così il cancello guarda dove guarda il server.
    const dir = appDirFinto({
      migrations: [
        { name: "20260817120000-ok.sql", sql: "SELECT 1;", applied: true },
        { name: "20260817120001-broken.sql", sql: "CREATE TABEL rotta(", applied: false },
      ],
    });
    daPulire.push(dir);

    // Nessun DATA_DIR: il cancello deve trovare il DB da <APP_DIR>/data/topics.db
    const { code, out } = eseguiCancello(dir);

    expect(code).toBe(1);
    expect(out).toContain("20260817120001-broken.sql");
    expect(out).toContain("server vecchio resta su");
  });
});
