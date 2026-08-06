/**
 * I file toccati da UN commit, con quante righe ciascuno.
 *
 * `/api/git/log` esisteva da sempre e `gitApi.log` pure, ma non li chiamava
 * nessuno: il pannello mostrava l'ULTIMO commit e basta, e per vedere cosa
 * conteneva quello prima bisognava uscire dall'app. Questo modulo è il pezzo
 * che mancava fra «ecco la lista dei commit» e «ecco cosa c'è dentro».
 *
 * ── `--name-status -z` NON è `--porcelain -z` ───────────────────────────────
 * Sembrano lo stesso formato e non lo sono. In porcelain il codice sta INCOLLATO
 * al path dentro lo stesso campo (`" M città.md"`); qui la lettera è un campo
 * NUL a sé:
 *
 *     status --porcelain -z:  " M città.md\0"
 *     show --name-status -z:  "M\0t.md\0"   e   "R100\0vecchio.md\0nuovo.md\0"
 *
 * Chi riusa `parsePorcelainZ` su questo output legge «M» come record troppo
 * corto e lo salta, e la lista dei file di ogni commit esce VUOTA senza un
 * errore. Da qui il parser separato, con l'output vero come fixture.
 *
 * Da notare anche il punteggio attaccato ai rename (`R100`, `C75`): la lettera
 * è la prima, il resto è quanto si somigliano.
 *
 * ── L'ordine dei rename ─────────────────────────────────────────────────────
 * Come in `git-numstat.ts` e al contrario di porcelain: prima il VECCHIO path,
 * poi il NUOVO. La chiave resta il nuovo, così combacia con i conteggi.
 */
import { parseNumstatZ, type Numstat } from "./git-numstat";

export interface CommitFile {
  path: string;
  /** Una lettera sola: A, M, D, R, C, T. Il punteggio dei rename è tolto. */
  status: string;
  /** Solo per rename e copie: da dove veniva. */
  origPath?: string;
  added: number;
  removed: number;
  binary?: boolean;
}

/** `git show` per i file di un commit: niente intestazione, solo i record. */
export const NAME_STATUS_ARGS = (hash: string) => ["git", "show", "--name-status", "-z", "--format=", hash];
export const SHOW_NUMSTAT_ARGS = (hash: string) => ["git", "show", "--numstat", "-z", "--format=", hash];
/** I metadati, su una riga sola. */
export const COMMIT_META_ARGS = (hash: string) => ["git", "show", "-s", "--format=%H|%h|%s|%an|%ar|%aI", hash];

/** Un rename o una copia porta con sé un secondo path. */
function carriesOrigPath(status: string): boolean {
  return status[0] === "R" || status[0] === "C";
}

/**
 * `git show --name-status -z` → voci, senza conteggi.
 *
 * I record sono a coppie (stato, path), e a terne quando c'è un rename.
 */
export function parseNameStatusZ(text: string): { path: string; status: string; origPath?: string }[] {
  const fields = text.split("\0");
  const out: { path: string; status: string; origPath?: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i];
    if (!raw) continue;
    // Un campo di stato è corto e comincia per lettera maiuscola. Tutto il
    // resto è un path rimasto orfano: si salta invece di prenderlo per uno
    // stato, che produrrebbe voci senza nome.
    if (!/^[A-Z]\d*$/.test(raw)) continue;
    const status = raw[0];
    if (carriesOrigPath(status)) {
      const orig = fields[++i];
      const path = fields[++i];
      if (!path) continue;
      out.push({ path, status, origPath: orig || undefined });
    } else {
      const path = fields[++i];
      if (!path) continue;
      out.push({ path, status });
    }
  }
  return out;
}

/**
 * Le due uscite di `git show` messe insieme.
 *
 * Servono entrambe: `--name-status` dice COSA è successo al file (aggiunto,
 * cancellato, rinominato) e `--numstat` dice QUANTO. Nessuna delle due da sola
 * basta a fare una riga di lista, e chiedere due volte lo stesso commit è
 * comunque più economico che chiedere un diff intero.
 */
export function mergeCommitFiles(nameStatus: string, numstat: string): CommitFile[] {
  const conteggi = parseNumstatZ(numstat);
  return parseNameStatusZ(nameStatus).map(v => {
    const n: Numstat | undefined = conteggi.get(v.path);
    return {
      path: v.path,
      status: v.status,
      ...(v.origPath ? { origPath: v.origPath } : {}),
      added: n?.added ?? 0,
      removed: n?.removed ?? 0,
      ...(n?.binary ? { binary: true } : {}),
    };
  });
}

/**
 * I file di un commit, ristretti a una sottocartella.
 *
 * Stessa ragione di `scopeToPrefix`: aprendo come progetto una sottocartella,
 * `git show` risponde comunque in path relativi alla RADICE, e senza il taglio
 * la cronologia mostrerebbe i commit di tutto il repo con dentro file che in
 * questo progetto non esistono.
 */
export function scopeCommitFiles(files: CommitFile[], prefix: string): CommitFile[] {
  if (!prefix) return files;
  const out: CommitFile[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const scoped = f.path.slice(prefix.length);
    if (!scoped) continue;
    const next: CommitFile = { ...f, path: scoped };
    // Un rename può venire da fuori dalla sottocartella: in quel caso il path
    // di provenienza si lascia intero, troncarlo darebbe un path inesistente.
    if (f.origPath) next.origPath = f.origPath.startsWith(prefix) ? f.origPath.slice(prefix.length) : f.origPath;
    out.push(next);
  }
  return out;
}
