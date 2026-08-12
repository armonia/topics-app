#!/usr/bin/env bun
/**
 * scripts/check-migration-numbers.ts — due cancelli sullo stesso file.
 *
 *   A. Nessun numero rivendicato da due NOMI diversi.
 *   B. Ogni migration NUOVA usa il prefisso timestamp, non un contatore.
 *
 * B è la cura, A è la rete. Il contatore ha fallito quattro volte in due
 * giorni: il 10/08 due `089` (`089-retirements.sql` e
 * `089-project-org-incognito.sql`), e nella notte dell'11-12/08 altre tre di
 * fila (097, 100, 101). Nessuno dei rami poteva accorgersene, perché il numero
 * si sceglie alla NASCITA della migration e si verifica all'ATTERRAGGIO, e in
 * mezzo passano ore in cui le altre card atterrano. Con sei agenti in parallelo
 * è l'esito normale, non la distrazione di qualcuno.
 *
 * Da qui in avanti il prefisso è un timestamp UTC `YYYYMMDDHHMMSS` che nessuno
 * deve contendere a nessuno (`bun run migration:new <slug>`, vedi
 * scripts/new-migration.ts per il perché delle sole cifre). A resta perché B
 * copre solo ciò che nasce da qui in avanti: un file scritto a mano, o due
 * timestamp nello stesso secondo, li prende ancora A.
 *
 * Il confronto è fra `server/db/migrations/` sul branch e la base (`main` di
 * default). Le migration già sulla base sono APPLICATE sui database vivi:
 * non si rinominano, e infatti nessuno dei due cancelli le guarda.
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
 *   bun run check:migrations                            # confronta con `main`
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

/**
 * Il prefisso delle migration NUOVE: 14 cifre, `YYYYMMDDHHMMSS` UTC.
 *
 * Sole cifre apposta: così `MIGRATION_FILE` qui sopra, il filtro di
 * server/db.ts e quello del manifest continuano a riconoscerle senza sapere
 * niente del cambio, e `parseInt` le ordina dopo i contatori a tre cifre.
 */
const STAMP_FILE = /^\d{14}-.+\.sql$/;

/** Chi usa ancora il contatore fra i file che questo branch AGGIUNGE. */
export function legacyNumbered(branchFiles: string[], baseFiles: string[]): string[] {
  const base = new Set(migrationFileNames(baseFiles));
  return migrationFileNames(branchFiles).filter(f => !base.has(f) && !STAMP_FILE.test(f));
}

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
 * Un CONTATORE rivendicato da due NOMI diversi è una collisione, comunque sia
 * distribuita fra branch e base:
 *   · due file nuovi sullo stesso branch      → entrambi in `introduced`
 *   · un file nuovo su un numero già su main  → uno solo in `introduced`
 * Lo stesso file presente su entrambi i lati (il caso normale) non è nulla.
 *
 * I file col prefisso TIMESTAMP sono fuori da questo conto, e non è una svista.
 * Due contatori uguali sono un guasto perché almeno uno dei due ha scelto quel
 * numero credendolo libero: l'intenzione di ordinamento di qualcuno è già
 * saltata. Due timestamp uguali dicono un'altra cosa — che le due migration
 * sono state scritte nello stesso SECONDO, in due worktree che non potevano
 * vedersi. Nessuna delle due può dipendere dall'altra, quindi l'ordine fra loro
 * non significa niente, e il runner le applica comunque entrambe con il nome a
 * rompere il pareggio (server/db.ts, `byVersionThenName`): deterministico su
 * ogni macchina. Chiamarlo errore vorrebbe dire riportare la contesa proprio
 * dove la si è tolta.
 */
export function findNumberCollisions(branchFiles: string[], baseFiles: string[]): Collision[] {
  const branch = migrationFileNames(branchFiles).filter(f => !STAMP_FILE.test(f));
  const base = migrationFileNames(baseFiles).filter(f => !STAMP_FILE.test(f));
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
  const contatori = legacyNumbered(branch, base.files);

  if (collisions.length === 0 && contatori.length === 0) {
    console.log(
      `✓ migration a posto ` +
        `(${migrationFileNames(branch).length} file sul branch vs ${base.ref})`,
    );
    process.exit(0);
  }

  // Come si rimedia è lo stesso in tutti e due i casi: il file è di questo
  // branch, quindi non è applicato da nessuna parte e si può ricreare.
  const rimedio =
    `Rifallo con il prefisso timestamp, che non può collidere:\n` +
    `  bun run migration:new <slug>            # crea il file e rigenera il manifest\n` +
    `  # sposta dentro il tuo SQL, poi cancella il vecchio file\n` +
    `  bun run scripts/gen-migrations-manifest.ts\n` +
    `Le migration già su ${base.ref} sono APPLICATE sui database vivi: non si rinominano.`;

  if (collisions.length > 0) {
    console.error(`✘ ${collisions.length} numero/i di migration rivendicato/i da più file:\n`);
    for (const c of collisions) {
      console.error(`  ${c.version}:`);
      for (const f of c.files) {
        const dove = c.introduced.includes(f) ? "questo branch" : base.ref;
        console.error(`      ${f}   (${dove})`);
      }
    }
    console.error("");
  }

  if (contatori.length > 0) {
    console.error(
      `✘ ${contatori.length} migration nuova/e usa/no ancora un CONTATORE:\n` +
        contatori.map(f => `      ${f}`).join("\n") +
        `\n\n  Il contatore si sceglie alla nascita e si verifica all'atterraggio: fra i due\n` +
        `  momenti atterrano le altre card, ed è così che si sono persi 097, 100 e 101\n` +
        `  in una notte sola. Il prefisso nuovo è un timestamp UTC YYYYMMDDHHMMSS.\n`,
    );
  }

  console.error(rimedio);
  process.exit(1);
}
