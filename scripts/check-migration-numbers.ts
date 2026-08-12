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
 * La REGOLA (quali nomi si contendono un numero) non vive qui: sta in
 * shared/migration-numbers.ts, perché la stessa domanda se la fa anche il land
 * un attimo prima di pubblicare un ramo. Qui restano la lettura dal repo e il
 * modo di dirlo a chi legge. Due copie della regola hanno già divergiuto una
 * volta, e la copia sbagliata rifiutava ogni land.
 *
 * Uso:
 *   bun run check:migrations                            # confronta con `main`
 *   MIGRATION_BASE_REF=origin/main bun run scripts/…    # base esplicita
 *
 * Esce 1 anche se la base non è risolvibile: un cancello che non trova niente
 * da confrontare deve dirlo, non passare in verde (b8092abe).
 */
import { execFileSync } from "child_process";
import { MIGRATIONS_DIR, findNumberCollisions, legacyNumbered, migrationFileNames } from "../shared/migration-numbers";

// La regola sta in shared/, i suoi nomi restano importabili da qui: i test del
// cancello (tests/unit/migration-*.test.ts) chiedono la regola allo stesso
// modulo che la ESEGUE, così una divergenza fra i due non può passare verde.
export { MIGRATIONS_DIR, findNumberCollisions, legacyNumbered, migrationFileNames };

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
