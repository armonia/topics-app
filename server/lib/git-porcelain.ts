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

export interface PorcelainEntry {
  /** Il path corrente (per un rename: quello NUOVO). */
  path: string;
  /** Il codice XY grezzo, due caratteri, mai trimmato. */
  status: string;
  /** Solo per rename/copie: il path di provenienza. */
  origPath?: string;
}

/** Gli argomenti da passare a `Bun.spawn` per uno status parsabile. */
export const STATUS_ARGS = ["git", "status", "--porcelain", "-z"];

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
    const next: PorcelainEntry = { path: e.path.slice(prefix.length), status: e.status };
    // Un rename può venire da FUORI dalla sottocartella: in quel caso il path
    // di provenienza non si accorcia, si lascia intero — troncarlo produrrebbe
    // un path che non esiste da nessuna parte.
    if (e.origPath) next.origPath = e.origPath.startsWith(prefix) ? e.origPath.slice(prefix.length) : e.origPath;
    out.push(next);
  }
  return out;
}
