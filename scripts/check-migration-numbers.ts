#!/usr/bin/env bun
/**
 * scripts/check-migration-numbers.ts — nessun numero di migration usato due volte.
 *
 * Il 10/08 due card sviluppate in parallelo hanno prodotto entrambe una `089`
 * (`089-retirements.sql` e `089-project-org-incognito.sql`). Nessuno dei due
 * rami poteva accorgersene: il secondo era stato tagliato PRIMA che il primo
 * atterrasse. Con la board che lavora N card in parallelo sullo stesso repo,
 * due migration scritte lo stesso giorno che si prendono lo stesso numero non
 * sono un caso raro: sono l'esito normale.
 *
 * Questo è il cancello che chiude il buco al momento della consegna: confronta
 * i numeri di `server/db/migrations/` sul branch con quelli già presenti sulla
 * base (`main` di default) ed esce 1 se lo stesso numero è rivendicato da due
 * NOMI diversi — sia fra branch e base, sia fra due file dello stesso albero.
 * È un controllo di un secondo e non chiede nessuna decisione: il numero libero
 * lo dice il messaggio d'errore.
 *
 * La seconda rete sta a valle, nel runner (`server/db.ts`): il registro
 * `schema_migrations` è indicizzato per NOME file, quindi due migration con lo
 * stesso numero si applicano comunque entrambe, in ordine (numero, nome). Prima
 * il registro era indicizzato per numero e la seconda `089` sarebbe stata
 * saltata in SILENZIO — il codice che presupponeva quelle colonne landava lo
 * stesso e si rompeva in produzione. Questo cancello e quel registro sono due
 * strati dello stesso problema: qui si evita l'ambiguità, lì si evita il danno.
 *
 * Uso:
 *   bun run scripts/check-migration-numbers.ts          # confronta con `main`
 *   MIGRATION_BASE_REF=origin/main bun run scripts/…    # base esplicita
 *
 * Esce 1 anche se la base non è risolvibile: un cancello che non trova niente
 * da confrontare deve dirlo, non passare in verde (b8092abe).
 */
import { execFileSync } from "child_process";
import { basename } from "path";

/** Dove vivono le migration, relativo alla radice del repo. */
export const MIGRATIONS_DIR = "server/db/migrations";

/** `089-retirements.sql` → sì; `README.md`, `.gitkeep`, `draft.sql` → no. */
const MIGRATION_FILE = /^(\d+)-.+\.sql$/;

export interface Collision {
  version: number;
  /** Tutti i nomi file distinti che rivendicano il numero, ordinati. */
  files: string[];
  /** Quelli che NON sono sulla base: è ciò che questo branch aggiunge. */
  introduced: string[];
}

/** Nomi file migration validi, deduplicati e ordinati. Ignora path e non-migration. */
export function migrationFileNames(paths: string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const name = basename(p.trim());
    if (MIGRATION_FILE.test(name)) names.add(name);
  }
  return [...names].sort();
}

export function versionOf(file: string): number {
  return parseInt(file.match(MIGRATION_FILE)![1], 10);
}

/**
 * Un numero rivendicato da due NOMI diversi è una collisione, comunque sia
 * distribuita fra branch e base:
 *   · due file nuovi sullo stesso branch      → entrambi in `introduced`
 *   · un file nuovo su un numero già su main  → uno solo in `introduced`
 * Lo stesso file presente su entrambi i lati (il caso normale) non è nulla.
 */
export function findNumberCollisions(branchFiles: string[], baseFiles: string[]): Collision[] {
  const branch = migrationFileNames(branchFiles);
  const base = migrationFileNames(baseFiles);
  const baseSet = new Set(base);

  const byVersion = new Map<number, Set<string>>();
  for (const file of [...branch, ...base]) {
    const v = versionOf(file);
    let set = byVersion.get(v);
    if (!set) byVersion.set(v, (set = new Set()));
    set.add(file);
  }

  const collisions: Collision[] = [];
  for (const [version, set] of byVersion) {
    if (set.size < 2) continue;
    const files = [...set].sort();
    collisions.push({ version, files, introduced: files.filter(f => !baseSet.has(f)) });
  }
  return collisions.sort((a, b) => a.version - b.version);
}

/** Il primo numero libero sopra a tutti quelli visti — quello da suggerire. */
export function nextFreeVersion(branchFiles: string[], baseFiles: string[]): number {
  const all = migrationFileNames([...branchFiles, ...baseFiles]);
  return all.reduce((max, f) => Math.max(max, versionOf(f)), 0) + 1;
}

// ── Lettura dal repo ────────────────────────────────────────────────────────

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

/** I file migration TRACCIATI nel working tree (gli scratch non tracciati non contano). */
export function branchMigrations(repoRoot: string): string[] {
  return git(repoRoot, ["ls-files", "-z", "--", MIGRATIONS_DIR]).split("\0").filter(Boolean);
}

/** I file migration su un ref. Torna null se il ref non esiste. */
export function baseMigrations(repoRoot: string, ref: string): string[] | null {
  try {
    return git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", ref, "--", MIGRATIONS_DIR])
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Il primo ref della lista che esiste, con i suoi file. */
export function resolveBase(repoRoot: string, candidates: string[]): { ref: string; files: string[] } | null {
  for (const ref of candidates) {
    const files = baseMigrations(repoRoot, ref);
    if (files) return { ref, files };
  }
  return null;
}

/**
 * La radice del repo in cui il cancello sta GIRANDO, non quella in cui vive lo
 * script: sono cose diverse in un worktree, e in un repo di prova sono due
 * repo diversi. Senza questo il gate misurerebbe sempre e solo il repo di casa.
 */
export function repoRootFromCwd(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return cwd;
  }
}

if (import.meta.main) {
  const repoRoot = repoRootFromCwd(process.cwd());
  const explicit = process.env.MIGRATION_BASE_REF;
  const candidates = explicit ? [explicit] : ["main", "origin/main", "refs/remotes/origin/main"];

  const base = resolveBase(repoRoot, candidates);
  if (!base) {
    console.error(
      `✘ base non risolvibile: nessuno di [${candidates.join(", ")}] esiste in questo checkout.\n` +
        `  Senza base non posso dire se un numero è già preso, e un cancello che non\n` +
        `  controlla niente NON deve uscire verde.\n` +
        `  In CI: \`git fetch --no-tags --depth=1 origin main:refs/remotes/origin/main\`.\n` +
        `  In locale: passa MIGRATION_BASE_REF=<ref>.`,
    );
    process.exit(1);
  }

  const branch = branchMigrations(repoRoot);
  const collisions = findNumberCollisions(branch, base.files);

  if (collisions.length === 0) {
    console.log(
      `✓ nessun numero di migration duplicato ` +
        `(${migrationFileNames(branch).length} file sul branch vs ${base.ref})`,
    );
    process.exit(0);
  }

  const free = nextFreeVersion(branch, base.files);
  console.error(`✘ ${collisions.length} numero/i di migration rivendicato/i da più file:\n`);
  for (const c of collisions) {
    console.error(`  ${String(c.version).padStart(3, "0")}:`);
    for (const f of c.files) {
      const dove = c.introduced.includes(f) ? "questo branch" : base.ref;
      console.error(`      ${f}   (${dove})`);
    }
  }
  const daRinominare = collisions.flatMap(c => c.introduced);
  console.error(
    `\nLe migration già su ${base.ref} sono APPLICATE sui database vivi e non si toccano.\n` +
      `Rinomina ${daRinominare.length === 1 ? "il file" : "i file"} di questo branch ` +
      `(${daRinominare.join(", ") || "—"}) a partire da ${String(free).padStart(3, "0")}, poi:\n` +
      `  bun run scripts/gen-migrations-manifest.ts`,
  );
  process.exit(1);
}
