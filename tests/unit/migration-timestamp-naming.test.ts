/**
 * Due agenti che scrivono una migration in parallelo non collidono più.
 *
 * Col contatore collidevano sempre: il numero si sceglie alla NASCITA della
 * migration e si verifica all'ATTERRAGGIO, e in mezzo passano ore in cui le
 * altre card atterrano. Nella notte dell'11-12/08 è successo tre volte (097,
 * 100, 101), dopo le due `089` del 10/08. Il prefisso ora è un timestamp UTC
 * (`bun run migration:new <slug>`, scripts/new-migration.ts).
 *
 * Qui si prova la catena intera, non il pezzo comodo:
 *   1. due checkout tagliati dallo STESSO main lanciano il generatore VERO —
 *      nessuno dei due vede il file dell'altro, che è tutto il punto;
 *   2. il cancello VERO dice verde su entrambi i rami e sul merge;
 *   3. il runner VERO (`initDatabase`) le applica entrambe, dopo le legacy,
 *      in ordine deterministico.
 *
 * Il caso stretto — stesso SECONDO — non è un'ipotesi: i due generatori qui
 * partono a millisecondi di distanza, quindi il timestamp condiviso è la norma
 * di questo test, non l'eccezione. È previsto: vedi `findNumberCollisions`.
  * @covers SCHEMA-05
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../../server/db";
import { MIGRATIONS_DIR, findNumberCollisions, legacyNumbered } from "../../scripts/check-migration-numbers";
import { STAMP_FILE, freeStamp, stampOf } from "../../scripts/new-migration";

const REPO_ROOT = join(import.meta.dir, "../..");
const daPulire: string[] = [];

afterEach(() => {
  closeDatabase();
  delete process.env.DATA_DIR;
  for (const d of daPulire.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Le migration già su main il 12/08: applicate sui DB vivi, non si toccano. */
const LEGACY = ["089-retirements.sql", "101-push-device-prefs.sql"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();
}

/**
 * Un repo con le legacy su `main` e gli script VERI copiati dentro.
 *
 * Copiati e non importati: il generatore si lancia come lo lancia un agente
 * (`bun run …`) e risolve la cartella dal proprio path, quindi vive nel repo su
 * cui deve scrivere. I byte sono quelli di `scripts/`, letti adesso: se il
 * generatore cambia, questo test misura la versione nuova.
 */
function repoConLegacy(): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-parallel-"));
  daPulire.push(dir);
  mkdirSync(join(dir, MIGRATIONS_DIR), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of LEGACY) writeFileSync(join(dir, MIGRATIONS_DIR, f), sqlDi(f));
  for (const s of ["new-migration.ts", "gen-migrations-manifest.ts"]) {
    copyFileSync(join(REPO_ROOT, "scripts", s), join(dir, "scripts", s));
  }
  // Il `.gitattributes` VERO: è lì che il manifest è marcato `merge=union`, ed
  // è metà del motivo per cui due card in parallelo si fondono senza conflitto.
  copyFileSync(join(REPO_ROOT, ".gitattributes"), join(dir, ".gitattributes"));
  git(dir, "init", "-q", "-b", "main");
  // Il manifest esiste già su main, come nel repo vero: le due card lo MODIFICANO.
  Bun.spawnSync(["bun", "run", join(dir, "scripts", "gen-migrations-manifest.ts")], { cwd: dir });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "main");
  return dir;
}

/** Una tabella per migration: applicata o no si vede da `sqlite_master`. */
function sqlDi(file: string): string {
  const tabella = "t_" + file.replace(/\.sql$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  return `CREATE TABLE IF NOT EXISTS ${tabella} (id INTEGER PRIMARY KEY);`;
}

/** Il generatore vero, dalla radice del repo di prova. Torna il file creato. */
function agenteScriveMigration(repo: string, slug: string): string {
  const prima = new Set(readdirSync(join(repo, MIGRATIONS_DIR)));
  const proc = Bun.spawnSync(["bun", "run", join(repo, "scripts", "new-migration.ts"), slug], { cwd: repo });
  expect(proc.stderr.toString() + proc.stdout.toString()).toContain(slug);
  expect(proc.exitCode).toBe(0);
  const creati = readdirSync(join(repo, MIGRATIONS_DIR)).filter(f => !prima.has(f));
  expect(creati).toHaveLength(1);
  // Il generatore lascia il file vuoto di SQL: ci mettiamo dentro qualcosa di
  // osservabile, che è quello che farebbe l'agente subito dopo.
  const file = creati[0]!;
  writeFileSync(join(repo, MIGRATIONS_DIR, file), sqlDi(file), { flag: "a" });
  return file;
}

/** Il cancello vero, come lo lancia la CI. */
function cancello(repo: string, base: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", join(REPO_ROOT, "scripts", "check-migration-numbers.ts")], {
    cwd: repo,
    env: { ...process.env, MIGRATION_BASE_REF: base },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** Il runner vero su una cartella di migration data. Torna il registro applicato. */
function applica(files: string[], contenuto: (f: string) => string): { name: string; version: number }[] {
  const baseDir = mkdtempSync(join(tmpdir(), "migration-run-"));
  daPulire.push(baseDir);
  const dir = join(baseDir, "server", "db", "migrations");
  mkdirSync(dir, { recursive: true });
  // `messages` deve esistere: dopo aver applicato qualcosa il runner chiama
  // backfillParentIds, che la interroga (stessa impalcatura di
  // tests/unit/migration-registry-by-name.test.ts).
  writeFileSync(join(dir, "000-base.sql"),
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_key TEXT, sort_order INTEGER, parent_id TEXT);");
  for (const f of files) writeFileSync(join(dir, f), contenuto(f));

  const dataDir = join(baseDir, "data");
  process.env.DATA_DIR = dataDir;
  initDatabase(baseDir);
  closeDatabase();

  const db = new Database(join(dataDir, "topics.db"));
  const rows = db.query("SELECT name, version FROM schema_migrations ORDER BY applied_at, rowid")
    .all() as { name: string; version: number }[];
  db.close();
  return rows.filter(r => r.name !== "000-base.sql");
}

/**
 * Il caso più grosso qui sotto fa girare git VERO e lancia il cancello come
 * sottoprocesso (`bun run`) tre volte. Sotto la suite intera i 5 secondi di
 * default non bastano, e il timeout uccide il `bun` a metà: `exitCode` torna
 * `null` e il rosso parla della macchina, non del cancello.
 */
const CON_SOTTOPROCESSI = 30_000;

describe("prefisso timestamp", () => {
  it("due agenti in parallelo: entrambe atterrano, nessuna collisione, ordine giusto", () => {
    const repo = repoConLegacy();

    // Ramo A, tagliato da main.
    git(repo, "checkout", "-q", "-b", "card-a");
    const a = agenteScriveMigration(repo, "notification-log");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "card-a");
    expect(cancello(repo, "main").code).toBe(0);

    // Ramo B, tagliato dallo STESSO main: non ha mai visto il file di A.
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "card-b");
    expect(readdirSync(join(repo, MIGRATIONS_DIR))).not.toContain(a);
    const b = agenteScriveMigration(repo, "push-device-prefs");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "card-b");
    expect(cancello(repo, "main").code).toBe(0);

    // Nomi diversi, entrambi col prefisso timestamp.
    expect(b).not.toBe(a);
    expect(a).toMatch(STAMP_FILE);
    expect(b).toMatch(STAMP_FILE);

    // Atterrano tutti e due, in qualunque ordine: nessun conflitto, gate verde.
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-edit", "card-a");
    git(repo, "merge", "-q", "--no-edit", "card-b");
    const suMain = readdirSync(join(repo, MIGRATIONS_DIR));
    expect(suMain).toContain(a);
    expect(suMain).toContain(b);
    expect(cancello(repo, "HEAD~2").code).toBe(0);

    // Il merge non è solo "senza conflitto": il manifest embedded — l'unico file
    // che ENTRAMBE le card toccano — deve contenere tutte e due le migration, o
    // il binario compilato partirebbe con lo schema di una sola.
    const manifest = readFileSync(join(repo, "server", "db", "migrations-embedded.ts"), "utf8");
    for (const f of [...LEGACY, a, b]) expect(manifest).toContain(`"${f}"`);
    expect(manifest).not.toContain("<<<<<<<");

    // E il runner le applica entrambe, dopo le legacy, in ordine deterministico.
    const registro = applica([...LEGACY, a, b], sqlDi);
    const applicate = registro.map(r => r.name);
    expect(applicate).toEqual([...LEGACY.slice().sort(), ...[a, b].sort()]);
    // L'ordine è il numero: i timestamp stanno DOPO i contatori a tre cifre.
    const versioni = registro.map(r => r.version);
    expect(versioni).toEqual(versioni.slice().sort((x, y) => x - y));
    expect(versioni[versioni.length - 1]).toBeGreaterThan(101);
  }, CON_SOTTOPROCESSI);

  it("stesso secondo, due worktree: non è una collisione, e l'ordine resta deciso dal nome", () => {
    // Il caso stretto, isolato dal timing: due file con lo STESSO stamp.
    const stamp = "20260812050317";
    const gemelle = [`${stamp}-notification-log.sql`, `${stamp}-push-device-prefs.sql`];
    expect(findNumberCollisions([...LEGACY, ...gemelle], LEGACY)).toEqual([]);
    expect(legacyNumbered([...LEGACY, ...gemelle], LEGACY)).toEqual([]);

    const registro = applica([...LEGACY, ...gemelle], sqlDi);
    expect(registro.map(r => r.name)).toEqual([...LEGACY.slice().sort(), ...gemelle.slice().sort()]);
    expect(registro.slice(-2).map(r => r.version)).toEqual([20260812050317, 20260812050317]);
  });

  it("lo stesso NUMERO con un contatore resta rosso: il cancello non si è ammorbidito", () => {
    // BARRA 2. Un duplicato scritto a mano è ancora un guasto.
    const [c] = findNumberCollisions([...LEGACY, "089-project-org-incognito.sql"], LEGACY);
    expect(c?.introduced).toEqual(["089-project-org-incognito.sql"]);
  });

  it("lo stamp è UTC, in secondi, e scansa solo i propri duplicati locali", () => {
    const t = new Date("2026-08-12T05:03:17.900Z");
    expect(stampOf(t)).toBe("20260812050317");
    // Cartella vuota: lo stamp è quello dell'istante.
    expect(freeStamp([], t)).toBe("20260812050317");
    // Stesso secondo già preso QUI: si scala di un secondo. Fra worktree
    // diversi questo non può succedere, ed è previsto (test qui sopra).
    expect(freeStamp(["20260812050317-altra.sql"], t)).toBe("20260812050318");
    expect(freeStamp(["089-retirements.sql"], t)).toBe("20260812050317");
  });
});
