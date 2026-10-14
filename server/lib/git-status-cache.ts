/**
 * La cache dello stato git, e il posto dove sta.
 *
 * PERCHÉ È UN MODULO A SÉ. Viveva dentro `routes/files.ts`, che la usa, ma a
 * invalidarla è `git-watcher.ts`, che sta un piano sopra. Per arrivarci
 * `git-watcher` importava `./routes/files` — e il risultato era un ciclo di
 * tre file, chiuso e reale:
 *
 *     file-watcher.ts → git-watcher.ts → routes/files.ts → file-watcher.ts
 *
 * Oggi non esplode perché ognuno dei tre usa gli altri solo DENTRO una
 * funzione, cioè a chiamata avvenuta, quando tutti i moduli sono già
 * inizializzati. È una proprietà del codice di adesso, non del disegno: basta
 * che uno dei tre legga un binding dell'altro a livello di modulo — una
 * costante, un `new`, un registro popolato all'import — perché la stessa
 * catena diventi un `Cannot access '…' before initialization` all'avvio del
 * server, e nel punto sbagliato: il file che si è limitato a spostare una
 * riga.
 *
 * La cache è la cosa CONDIVISA fra chi la riempie (la route) e chi la svuota
 * (il watcher). Messa qui, entrambi la importano e nessuno dei due importa
 * l'altro: il ciclo si apre nel punto in cui c'era davvero una dipendenza
 * comune, invece di essere tenuto insieme dall'ordine di caricamento.
 *
 * La FRESCHEZZA sta qui dentro e non presso il chiamante: leggere una voce e
 * decidere se è ancora buona sono la stessa domanda, e separarle vuol dire
 * avere due posti che possono dissentire sul TTL.
 */

/**
 * Validity of an entry, counted from its WRITE and never renewed by reads. With
 * both watchers live on the path (`.git` and the project files) an entry lasts
 * 60 seconds, a cap for the event a watcher loses; otherwise five seconds. The
 * route bench can set this to zero so each request pays for a git spawn; this
 * seam only takes effect on TOPICS_E2E.
 */
const TTL_MS = process.env.TOPICS_E2E === "1" && process.env.TOPICS_E2E_GIT_STATUS_TTL_MS === "0" ? 0 : 5000;
const WATCHED_MAX_AGE_MS = 60_000;

/**
 * Il tetto. La chiave è il `?path=` risolto e fornito da chi chiama (nessuna
 * allowlist), quindi la mappa cresce con ogni repo git mai interrogato e viene
 * svuotata solo per i path su cui scatta un watcher: senza un limite non
 * smette di crescere.
 */
const MAX_ENTRIES = 500;

export interface GitStatusFile {
  path: string;
  status: string;
}

export interface GitStatusResult {
  branch: string;
  lastCommit: { hash: string; message: string; author: string; ago: string };
  files: GitStatusFile[];
  ahead: number;
  behind: number;
  /** Presenti solo sulla risposta della route, che è anche ciò che si cachea:
   *  erano fuori dal tipo mentre l'oggetto scritto in cache li portava già. */
  folderUntracked?: boolean;
  repoName?: string;
}

const cache = new Map<string, { data: GitStatusResult; timestamp: number }>();
const gitWatchedPaths = new Set<string>();
const fileWatchedPaths = new Set<string>();

/** Tracks whether `.git` has an active watcher for this path. */
export function setGitStatusWatcher(projectPath: string, active: boolean): void {
  if (active) gitWatchedPaths.add(projectPath);
  else gitWatchedPaths.delete(projectPath);
}

/** Tracks whether the project file watcher is active for this path. */
export function setGitStatusFileWatcher(projectPath: string, active: boolean): void {
  if (active) fileWatchedPaths.add(projectPath);
  else fileWatchedPaths.delete(projectPath);
}

/** La voce se c'è ED è ancora fresca, altrimenti `null`. */
export function readGitStatusCache(projectPath: string, now: () => number = () => performance.now()): GitStatusResult | null {
  const hit = cache.get(projectPath);
  if (!hit) return null;
  const hasBothWatchers = gitWatchedPaths.has(projectPath) && fileWatchedPaths.has(projectPath);
  const maxAge = TTL_MS === 0 ? 0 : hasBothWatchers ? WATCHED_MAX_AGE_MS : TTL_MS;
  const timestamp = now();
  if (timestamp - hit.timestamp >= maxAge) return null;
  return hit.data;
}

/** Scrive la voce, sfrattando la più vecchia se si è al tetto. */
export function writeGitStatusCache(projectPath: string, data: GitStatusResult, now: () => number = () => performance.now()): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(projectPath)) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.timestamp < oldestTs) {
        oldestTs = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(projectPath, { data, timestamp: now() });
}

/** Butta la voce di questo progetto: la prossima lettura torna a chiedere a git. */
export function invalidateGitCache(projectPath: string): void {
  cache.delete(projectPath);
  // A round already in flight may have read the tree BEFORE the change that
  // caused this invalidation: whoever asks next must start a new one, not join
  // it (see `computeGitStatus`).
  roundsInFlight.delete(projectPath);
}

/**
 * The rounds of `computeGitStatus` currently running, per folder. Kept here,
 * next to the cache, so that the one door every writer already goes through
 * (`invalidateGitCache`, 23 call sites) also retires a round that can no
 * longer be trusted.
 */
export const roundsInFlight = new Map<string, Promise<unknown>>();
