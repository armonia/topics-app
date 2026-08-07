/**
 * Il parse di `git status --porcelain`, fatto una volta sola e su `-z`.
 *
 * ── Perché `-z` non è un dettaglio ──────────────────────────────────────────
 * Senza, git CITA e ottalizza i path non-ASCII, e cambia forma sui rename:
 *
 *     $ git status --porcelain
 *      M "citt\303\240.md"
 *     R  old.md -> new.md
 *
 * Il vecchio parse (`line.substring(3)`) prendeva quelle stringhe alla lettera.
 * Conseguenze viste dall'utente: su `città.md` ogni azione — stage, unstage,
 * discard, diff — falliva con un toast generico, perché `git add -- "citt\303\240.md"`
 * risponde `fatal: pathspec`. E per un rename il "path" diventava l'intera
 * stringa con la freccia dentro, usata come chiave di selezione e come argomento
 * dei comandi: `git show HEAD:<quella roba>` esce non-zero, la rotta restituiva
 * stringa vuota, e il diff appariva VUOTO senza un errore.
 *
 * Con `-z` i record sono separati da NUL e i path sono grezzi:
 *
 *     " M città.md\0R  new.md\0old.md\0?? untracked.txt\0"
 *
 * Da notare: per un rename/copia il path ORIGINALE è un campo NUL a sé, SUBITO
 * DOPO, e l'ordine è **nuovo prima, vecchio dopo**.
 *
 * ── Il codice XY resta grezzo ───────────────────────────────────────────────
 * Due caratteri posizionali: `status[0]` = indice (staged), `status[1]` = albero
 * di lavoro. Non si fa trim — `"  M"` trimmato diventa `"M"` e un file NON
 * staged si presenta come staged. È un bug già pagato due volte in questo
 * repo, ed è il motivo per cui il contratto grezzo è documentato in entrambi i
 * punti che lo producono.
 */

import { realpathSync } from "fs";

export interface PorcelainEntry {
  /** Il path corrente (per un rename: quello NUOVO). */
  path: string;
  /** Il codice XY grezzo, due caratteri, mai trimmato. */
  status: string;
  /** Solo per rename/copie: il path di provenienza. */
  origPath?: string;
}

/**
 * Un comando git di SOLA LETTURA, che però non si limita a leggere.
 *
 * `git status` e `git diff` rinfrescano l'indice come effetto collaterale
 * (riscrivono la stat cache quando gli mtime non tornano) e per farlo prendono
 * `.git/index.lock`. È un lock *facoltativo*: serve a loro, non all'utente. Ma
 * mentre ce l'hanno, un `git commit` concorrente muore con
 * «Unable to create '.../index.lock': File exists».
 *
 * Qui lo status parte da solo — il watcher su `.git/index` lo lancia 500 ms
 * dopo ogni stage — quindi la finestra si apre esattamente sopra il commit che
 * l'utente sta per fare. `--no-optional-locks` toglie a ogni lettore il diritto
 * di prendere quel lock: legge quello che c'è e non riscrive niente.
 */
export function gitRead(...args: string[]): string[] {
  return ["git", "--no-optional-locks", ...args];
}

/** Gli argomenti da passare a `Bun.spawn` per uno status parsabile. */
export const STATUS_ARGS = gitRead("status", "--porcelain", "-z");

/** Un XY è un rename o una copia? Allora porta con sé un secondo path. */
function carriesOrigPath(status: string): boolean {
  return status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
}

/**
 * `git status --porcelain -z` → record.
 *
 * L'ultimo campo dopo l'ultimo NUL è vuoto e va scartato; un record più corto
 * di `XY ` (3 caratteri) è spazzatura e si salta invece di produrre un path
 * vuoto — che a valle diventerebbe un `git add -- ""`.
 */
export function parsePorcelainZ(text: string): PorcelainEntry[] {
  const fields = text.split("\0");
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec || rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const path = rec.slice(3);
    if (!path) continue;
    if (carriesOrigPath(status)) {
      const orig = fields[++i];
      out.push(orig ? { path, status, origPath: orig } : { path, status });
    } else {
      out.push({ path, status });
    }
  }
  return out;
}

/** Un file in conflitto di merge. */
export function isConflicted(status: string): boolean {
  // I codici di conflitto di `git status`: entrambi modificati, entrambi
  // aggiunti, entrambi cancellati, e i tre casi «uno dei due lati».
  // `DD AU UD UA DU AA UU` — cioè: una `U` da una parte o dall'altra, più le
  // due coppie senza `U`.
  return status === "AA" || status === "DD" || status[0] === "U" || status[1] === "U";
}

/**
 * Ristretto ai file sotto `prefix`, con il prefisso tolto.
 *
 * Serve quando la cartella aperta è una SOTTOcartella del repo: `git status`
 * risponde sempre in path relativi alla radice, e senza questo taglio i path
 * mostrati non combacerebbero con l'albero dei file.
 */
export function scopeToPrefix(entries: PorcelainEntry[], prefix: string): PorcelainEntry[] {
  if (!prefix) return entries;
  const out: PorcelainEntry[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    // La cartella APERTA, non un file dentro di essa.
    //
    // Quando l'intera cartella non è tracciata, git la collassa in un record
    // solo — `?? match-compass/` — e togliendo il prefisso resta la stringa
    // VUOTA. Quel record finiva nella lista come una riga senza nome, con la
    // sola pastiglia `U`: il pannello diceva «1 modifica» e non mostrava
    // niente. Non è un file: è una cosa da dire, non da elencare (vedi
    // `statusOfPrefix`).
    const scoped = e.path.slice(prefix.length);
    if (!scoped) continue;
    const next: PorcelainEntry = { path: scoped, status: e.status };
    // Un rename può venire da FUORI dalla sottocartella: in quel caso il path
    // di provenienza non si accorcia, si lascia intero — troncarlo produrrebbe
    // un path che non esiste da nessuna parte.
    if (e.origPath) next.origPath = e.origPath.startsWith(prefix) ? e.origPath.slice(prefix.length) : e.origPath;
    out.push(next);
  }
  return out;
}

/**
 * Lo stato della cartella APERTA, quando git parla di lei e non di ciò che
 * contiene.
 *
 * Succede aprendo come progetto una sottocartella non tracciata di un repo più
 * grande: git non elenca gli undicimila file dentro, collassa tutto in
 * `?? <cartella>/`. Quel record va tolto dalla lista (vedi `scopeToPrefix`) ma
 * NON buttato: è l'unica cosa vera da dire su quel progetto — «questa cartella
 * non è tracciata» — e senza, il pannello mostrerebbe «nessuna modifica», che è
 * una bugia diversa ma sempre una bugia.
 */
/**
 * Il pezzo di path della cartella aperta relativo alla radice del suo repo, e
 * il nome di quella radice.
 *
 * `git rev-parse --show-toplevel` risponde col path REALE, mentre la cartella
 * aperta può arrivare attraverso un link simbolico: su macOS `/tmp` è un link
 * a `/private/tmp`, quindi un confronto fra stringhe fallisce e lo scoping non
 * parte. Da lì in poi il pannello mostra i file di TUTTO il repo, e non si
 * accorge che la cartella aperta è a sua volta non tracciata. Si confrontano i
 * path risolti.
 *
 * Sta qui, e non nella rotta, perché il prefisso lo calcolano in DUE: la rotta
 * `/api/git/status` e il push del watcher. Il watcher lo faceva con un
 * `startsWith` fra stringhe grezze, quindi su un path con symlink i due
 * descrivevano lo stesso stato con path diversi — la lista cambiava a seconda
 * che l'aggiornamento fosse arrivato dal poll o dal watcher.
 */
export function repoPrefixOf(resolvedDir: string, gitRoot: string): { prefix: string; repoName: string } {
  if (!gitRoot) return { prefix: "", repoName: "" };
  let real = resolvedDir;
  try { real = realpathSync(resolvedDir); } catch {}
  let root = gitRoot;
  try { root = realpathSync(gitRoot); } catch {}
  if (real === root || !real.startsWith(root + "/")) return { prefix: "", repoName: "" };
  let prefix = real.slice(root.length + 1);
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { prefix, repoName: root.split("/").filter(Boolean).pop() ?? "" };
}

export function statusOfPrefix(entries: PorcelainEntry[], prefix: string): string | null {
  if (!prefix) return null;
  const dir = prefix.replace(/\/+$/, "");
  for (const e of entries) {
    const p = e.path.replace(/\/+$/, "");
    if (p === dir) return e.status;
  }
  return null;
}
