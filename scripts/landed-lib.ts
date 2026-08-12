/**
 * «Il contenuto di questo ramo è già su main?» — la sola domanda che autorizza
 * a cancellare qualcosa.
 *
 * Vive qui, e non dentro uno dei due script che la usano, perché `disk-report`
 * (worktree) e `branch-audit` (rami) devono rispondere alla STESSA domanda: due
 * copie della regola divergono, e il giorno che divergono una delle due cancella
 * qualcosa che l'altra teneva. È la versione sincrona, per script, di
 * `server/services/branch-status.ts` — se NOISE_RE cambia lì, cambia qui.
 *
 * Perché non `merge-base`: la consegna atterra in squash, quindi il ramo di un
 * task landato NON è mai antenato di main. Chiedere la discendenza risponde
 * "vivo" a rami che non hanno più niente di loro, e il mucchio non cala mai.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Generated/lockfile/version paths — mai lavoro unico. */
export const NOISE_RE =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|package\.json|tauri\.conf\.json|Cargo\.toml)$|(^|\/)(public|dist|node_modules)\//;

/** Toglie i path generati: resta solo ciò la cui differenza sarebbe lavoro vero. */
export function filterUniqueSourceFiles(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter((p) => p.length > 0 && !NOISE_RE.test(p));
}

export type Landed =
  /** Il tip è antenato di main: caso classico, nessun dubbio. */
  | "antenato"
  /** Ogni file unico che tocca è byte-identico su main: niente da perdere. */
  | "identico"
  /** Il suo diff si toglie da main senza conflitti, ma main ci ha scritto sopra. */
  | "riassorbito"
  /** Ha roba sua che su main non c'è. */
  | "vivo";

function out(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Come `out`, ma SENZA trim. Un patch va passato a `git apply` byte per byte:
 * togliergli la newline finale lo fa rifiutare con "corrupt patch", e il caso
 * "riassorbito" non scatterebbe mai — un falso "vivo" che tiene in piedi rami
 * già atterrati (preso dal test, non dalla lettura).
 */
function raw(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function ok(repo: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd: repo, stdio: "ignore" }).status === 0;
}

/**
 * Un indice temporaneo con l'albero di main dentro. Serve a `git apply --cached`,
 * che lavora sull'INDICE e non sul working tree: è ciò che permette di provare
 * `--reverse --check` contro main da una worktree qualsiasi, senza fare da
 * nessuna parte il checkout di main.
 */
export function makeMainIndex(repo: string, mainRef = "main"): string | null {
  const path = join(tmpdir(), `landed-index-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const r = spawnSync("git", ["read-tree", mainRef], {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, GIT_INDEX_FILE: path },
  });
  return r.status === 0 ? path : null;
}

/** Il diff si toglie da main senza conflitti? `--check` non scrive niente. */
export function reverseApplies(repo: string, indexPath: string, patch: string): boolean {
  if (!patch.trim()) return true;
  const r = spawnSync("git", ["apply", "--cached", "--reverse", "--check", "-"], {
    cwd: repo,
    input: patch,
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
  return r.status === 0;
}

/** I file-sorgente unici che il ramo tocca rispetto al suo punto di fork. */
export function uniqueSourceFiles(repo: string, branch: string, mainRef = "main"): string[] {
  return filterUniqueSourceFiles(out(repo, ["diff", "--name-only", `${mainRef}...${branch}`]).split("\n"));
}

/**
 * Il verdetto. `indexPath` assente ⇒ il caso "riassorbito" non viene nemmeno
 * cercato e il ramo resta "vivo": meglio tenere qualcosa in più che dichiarare
 * riassorbito ciò che non si è potuto provare.
 */
export function landedVerdict(
  repo: string,
  branch: string,
  mainRef = "main",
  indexPath: string | null = null,
): Landed {
  if (ok(repo, ["merge-base", "--is-ancestor", branch, mainRef])) return "antenato";
  // Senza storia condivisa il confronto per contenuto non significa niente.
  if (!ok(repo, ["merge-base", branch, mainRef])) return "vivo";

  const files = uniqueSourceFiles(repo, branch, mainRef);
  // Solo rumore generato: il ramo non ha niente di suo da perdere.
  if (files.length === 0) return "identico";
  // `--quiet` esce 0 quando NON c'è differenza sui path dati.
  if (ok(repo, ["diff", "--quiet", branch, mainRef, "--", ...files])) return "identico";

  if (indexPath) {
    const patch = raw(repo, ["diff", `${mainRef}...${branch}`, "--", ...files]);
    if (patch && reverseApplies(repo, indexPath, patch)) return "riassorbito";
  }
  return "vivo";
}

/** Solo questi due autorizzano a cancellare: il ramo non ha contenuto proprio. */
export function isSafeToDelete(v: Landed): boolean {
  return v === "antenato" || v === "identico";
}

/**
 * I rami usa-e-getta: quelli che il sistema CREA da solo per un task o una
 * worktree, e che nessuno cita per nome.
 *
 * Esiste perché il contenuto non è tutta la domanda. `electron-archive` è
 * antenato di main — verdetto "cancellabile", e infatti il primo giro del 12/08
 * lo ha cancellato — ma il README lo cita per NOME in tre punti come la via per
 * riavere la shell Electron. Il contenuto era salvo; il nome, che era la cosa
 * che serviva, no. Un ramo che qualcuno ha battezzato a mano si elenca e lo
 * chiama l'umano: la cancellazione automatica vale solo per i nomi che ha
 * generato la macchina.
 */
export function isDisposableBranchName(branch: string): boolean {
  return /^(topics\/|task\/|worktree-|wf_)/.test(branch);
}
