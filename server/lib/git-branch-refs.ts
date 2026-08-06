/**
 * Classificazione delle ref di `git branch -a`.
 *
 * Sta in un modulo suo perché è il punto in cui si sono nascosti due bug che
 * dalla UI si vedevano solo come conseguenze lontane, e perché la sola cosa
 * che li smaschera è guardare l'output VERO di git:
 *
 *     refs/remotes/origin/HEAD|origin| |
 *     refs/remotes/origin/feat|origin/feat| |
 *
 * 1. Il nome corto di `refs/remotes/origin/HEAD` è **`origin`**, secco. Lo
 *    scarto era scritto `name === "origin/HEAD"` e quindi non scartava niente;
 *    e la classificazione era `name.startsWith("origin/")`, che su `origin`
 *    è falsa — così il puntatore al ramo di default compariva fra i rami
 *    LOCALI, come una voce che si sposta da sola.
 * 2. Il nome corto di un ramo remoto è `origin/foo`, non `remotes/origin/foo`.
 *    Il client tirava via il prefisso sbagliato, restava con `origin/foo` in
 *    mano e ci faceva `git checkout` sopra: HEAD staccato, uscita 0, nessun
 *    messaggio. Ogni commit fatto da lì è orfano.
 *
 * La verità sta nel nome COMPLETO (`refs/heads/…` vs `refs/remotes/…`), che è
 * anche l'unico modo di trattare bene un remote che non si chiama `origin`.
 */

export interface BranchRef {
  /** Nome corto, come lo mostra la UI: `main`, `origin/feat`. */
  name: string;
  current: boolean;
  isRemote: boolean;
  /** Solo per i remoti: il remote di provenienza (`origin`, `upstream`). */
  remote?: string;
  /** Solo per i remoti: il nome SENZA il remote — quello su cui si fa switch. */
  shortName?: string;
  /** Upstream configurato, solo per i locali. */
  upstream?: string;
}

/** Il formato da passare a `git branch -a --format=…`. */
export const BRANCH_FORMAT = "%(refname)|%(refname:short)|%(HEAD)|%(upstream:short)";

/**
 * Una riga di `git branch -a --format=BRANCH_FORMAT` → la sua ref, oppure
 * `null` se va ignorata (riga vuota, o il puntatore `…/HEAD` di un remote).
 */
export function parseBranchLine(line: string): BranchRef | null {
  if (!line.trim()) return null;
  const [refname, name, head, upstream] = line.split("|");
  if (!refname || !name) return null;
  // Vale per ogni remote, non solo `origin`.
  if (refname.endsWith("/HEAD")) return null;

  const isRemote = refname.startsWith("refs/remotes/");
  const ref: BranchRef = { name, current: head === "*", isRemote };
  if (isRemote) {
    const slash = name.indexOf("/");
    if (slash > 0) {
      ref.remote = name.slice(0, slash);
      ref.shortName = name.slice(slash + 1);
    } else {
      ref.shortName = name;
    }
  } else if (upstream) {
    ref.upstream = upstream;
  }
  return ref;
}

/** Tutte le righe, scartate quelle da ignorare. */
export function parseBranchLines(text: string): BranchRef[] {
  return text.split("\n").map(parseBranchLine).filter((b): b is BranchRef => b !== null);
}
