/**
 * Quando due migration si CONTENDONO un numero — la regola, pura, in un posto solo.
 *
 * La domanda se la fanno due cancelli diversi: quello di consegna
 * (`scripts/check-migration-numbers.ts`, che confronta il branch con la base) e
 * quello del land (`server/services/task-automerge.ts`, che confronta il ramo
 * con `main` un attimo prima di pubblicarlo). Finché erano due copie hanno
 * divergiuto, e la copia sbagliata era quella del land: prendeva il numero con
 * `file.slice(0, 3)`, cioè sui nomi nuovi a timestamp (`20260812094300-…`)
 * leggeva sempre «202». Risultato misurato la notte del 12/08 su `ddf66270`:
 * QUALUNQUE coppia di migration timestamp fra main e il ramo diventava una
 * collisione, il land rifiutava per sempre e l'unica uscita era fondere a mano.
 *
 * Il contratto vero, uguale per tutti:
 *   · un CONTATORE a tre cifre rivendicato da due NOMI diversi è un guasto —
 *     almeno uno dei due ha scelto quel numero credendolo libero;
 *   · due TIMESTAMP uguali non lo sono: vogliono dire «stesso secondo, due
 *     worktree che non si vedevano», nessuna delle due può dipendere
 *     dall'altra, e il runner le applica entrambe indicizzando per NOME
 *     (`server/db.ts`).
 */

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

export interface Collision {
  version: number;
  /** Tutti i nomi file distinti che rivendicano il numero, ordinati. */
  files: string[];
  /** Quelli che NON sono sulla base: è ciò che questo branch aggiunge. */
  introduced: string[];
}

/**
 * L'ultimo segmento di un path, senza `node:path`: questo modulo lo compila
 * anche il client (`shared/` sta dentro il suo tsconfig), che non ha i tipi di
 * node. I path arrivano da `git ls-tree`/`ls-files`, che usa sempre lo slash
 * avanti — la barra rovescia è accettata per non sorprendere nessuno su Windows.
 */
function lastSegment(path: string): string {
  const parts = path.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Nomi file migration validi, deduplicati e ordinati. Ignora path e non-migration. */
export function migrationFileNames(paths: string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const name = lastSegment(p);
    if (MIGRATION_FILE.test(name)) names.add(name);
  }
  return [...names].sort();
}

function versionOf(file: string): number {
  return parseInt(file.match(MIGRATION_FILE)![1], 10);
}

/** Chi usa ancora il contatore fra i file che questo branch AGGIUNGE. */
export function legacyNumbered(branchFiles: string[], baseFiles: string[]): string[] {
  const base = new Set(migrationFileNames(baseFiles));
  return migrationFileNames(branchFiles).filter(f => !base.has(f) && !STAMP_FILE.test(f));
}

/**
 * Un CONTATORE rivendicato da due NOMI diversi è una collisione, comunque sia
 * distribuita fra branch e base:
 *   · due file nuovi sullo stesso branch      → entrambi in `introduced`
 *   · un file nuovo su un numero già su main  → uno solo in `introduced`
 * Lo stesso file presente su entrambi i lati (il caso normale) non è nulla.
 *
 * I file col prefisso TIMESTAMP sono fuori da questo conto, e non è una svista:
 * il perché sta in cima al file.
 *
 * L'unione dei due lati è deliberata, e serve al land: quando il land riporta
 * main DENTRO il ramo prima di valutare i cancelli, il ramo si trova con
 * entrambi i file addosso. Guardare un lato per volta non vedrebbe più niente;
 * l'unione vede la contesa comunque i file si siano distribuiti.
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
