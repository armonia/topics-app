/**
 * Due card in parallelo si prendono lo stesso numero di migration.
 *
 * È successo il 10/08: `089-retirements.sql` e `089-project-org-incognito.sql`,
 * scritte su due rami tagliati prima che l'altro atterrasse. Il registro
 * `schema_migrations` era indicizzato per NUMERO, quindi la seconda 089 non si
 * sarebbe applicata MAI, in silenzio, mentre il codice che presupponeva quelle
 * colonne landava lo stesso. Vedi scripts/check-migration-numbers.ts (il
 * cancello) e server/db.ts (il registro, ora per nome).
 *
 * Il primo test è la rete sul repo vero; gli altri provano che la rete morde
 * davvero — su un repo git di prova con due `089` costruito qui dentro.
  * @covers SCHEMA-05
 */
import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MIGRATIONS_DIR,
  branchMigrations,
  findNumberCollisions,
  legacyNumbered,
  migrationFileNames,
  resolveBase,
} from "../../scripts/check-migration-numbers";

const REPO_ROOT = join(import.meta.dir, "../..");
const GATE = join(REPO_ROOT, "scripts", "check-migration-numbers.ts");

/** Un repo git minimo con `main` + un branch, per provare il cancello per davvero. */
function repoDiProva(mainFiles: string[], branchFiles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-gate-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  const scrivi = (files: string[]) => {
    mkdirSync(join(dir, MIGRATIONS_DIR), { recursive: true });
    for (const f of files) writeFileSync(join(dir, MIGRATIONS_DIR, f), "SELECT 1;\n");
  };

  git("init", "-q", "-b", "main");
  scrivi(mainFiles);
  git("add", "-A");
  git("commit", "-qm", "main");

  git("checkout", "-q", "-b", "feature");
  scrivi(branchFiles);
  git("add", "-A");
  git("commit", "-qm", "feature");
  return dir;
}

/** Il cancello vero, eseguito come lo esegue la CI: exit code + stderr. */
function eseguiCancello(repoRoot: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", GATE], {
    cwd: repoRoot,
    env: { ...process.env, MIGRATION_BASE_REF: "main" },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

describe("numeri di migration", () => {
  it("questo repo non ne ha due uguali", () => {
    const base = resolveBase(REPO_ROOT, ["main", "origin/main", "refs/remotes/origin/main"]);
    // Se la base non si risolve il cancello esce 1: qui lo diciamo esplicito
    // invece di saltare il test, che sarebbe lo stesso verde non guadagnato.
    expect(base).not.toBeNull();
    const collisions = findNumberCollisions(branchMigrations(REPO_ROOT), base!.files);
    const dettaglio = collisions.map(c => `${c.version}: ${c.files.join(" + ")}`).join("\n");
    expect(dettaglio).toBe("");
  });

  it("un numero già su main è una collisione, il resto no", () => {
    const main = ["088-board-language.sql", "089-retirements.sql"];
    const branch = [...main, "089-project-org-incognito.sql"];
    const [c, ...altre] = findNumberCollisions(branch, main);
    expect(altre).toEqual([]);
    expect(c).toEqual({
      version: 89,
      files: ["089-project-org-incognito.sql", "089-retirements.sql"],
      introduced: ["089-project-org-incognito.sql"],
    });
  });

  it("numeri distinti: nessuna collisione, e il branch che non tocca nulla nemmeno", () => {
    const main = ["088-board-language.sql", "089-retirements.sql"];
    expect(findNumberCollisions([...main, "090-nuova.sql"], main)).toEqual([]);
    expect(findNumberCollisions(main, main)).toEqual([]);
  });

  it("due file NUOVI sullo stesso numero, entrambi assenti da main", () => {
    // Il caso in cui una sola card scrive due migration e sbaglia da sola.
    const [c] = findNumberCollisions(["001-a.sql", "090-x.sql", "090-y.sql"], ["001-a.sql"]);
    expect(c.introduced).toEqual(["090-x.sql", "090-y.sql"]);
  });

  it("ignora ciò che non è una migration e normalizza i path", () => {
    expect(migrationFileNames([
      `${MIGRATIONS_DIR}/089-retirements.sql`,
      `${MIGRATIONS_DIR}/README.md`,
      `${MIGRATIONS_DIR}/.gitkeep`,
      `${MIGRATIONS_DIR}/bozza.sql`,
    ])).toEqual(["089-retirements.sql"]);
  });

  it("una migration NUOVA col contatore è rifiutata; quelle già su main no", () => {
    const main = ["088-board-language.sql", "089-retirements.sql"];
    // Il branch non tocca niente: i contatori già sulla base restano legittimi.
    expect(legacyNumbered(main, main)).toEqual([]);
    // Un file nuovo col contatore è esattamente ciò che si vuole impedire.
    expect(legacyNumbered([...main, "090-nuova.sql"], main)).toEqual(["090-nuova.sql"]);
    // Con il timestamp passa.
    expect(legacyNumbered([...main, "20260812050317-nuova.sql"], main)).toEqual([]);
  });

  it("ROSSO su un repo di prova con due 089 — exit 1, e dice quale rinominare", () => {
    const dir = repoDiProva(
      ["088-board-language.sql", "089-retirements.sql"],
      ["088-board-language.sql", "089-retirements.sql", "089-project-org-incognito.sql"],
    );
    try {
      const { code, out } = eseguiCancello(dir);
      expect(code).toBe(1);
      expect(out).toContain("089-project-org-incognito.sql");
      expect(out).toContain("089-retirements.sql");
      expect(out).toContain("migration:new"); // come si rimedia
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VERDE sullo stesso repo appena il file nuovo ha il prefisso timestamp — exit 0", () => {
    const dir = repoDiProva(
      ["088-board-language.sql", "089-retirements.sql"],
      ["088-board-language.sql", "089-retirements.sql", "20260812050317-project-org-incognito.sql"],
    );
    try {
      expect(eseguiCancello(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROSSO se il file nuovo usa ancora un contatore, anche senza collisione — exit 1", () => {
    // 090 è libero su main: il vecchio cancello sarebbe stato verde, ed è
    // esattamente il verde che il 12/08 è diventato rosso tre volte all'atterraggio.
    const dir = repoDiProva(
      ["088-board-language.sql", "089-retirements.sql"],
      ["088-board-language.sql", "089-retirements.sql", "090-project-org-incognito.sql"],
    );
    try {
      const { code, out } = eseguiCancello(dir);
      expect(code).toBe(1);
      expect(out).toContain("090-project-org-incognito.sql");
      expect(out).toContain("CONTATORE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("base non risolvibile: esce 1, non verde a vuoto", () => {
    const dir = repoDiProva(["001-a.sql"], ["001-a.sql", "002-b.sql"]);
    try {
      const proc = Bun.spawnSync(["bun", "run", GATE], {
        cwd: dir,
        env: { ...process.env, MIGRATION_BASE_REF: "ref-che-non-esiste" },
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("base non risolvibile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
