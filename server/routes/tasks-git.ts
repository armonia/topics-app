/**
 * Bounded git helpers of the tasks routes: the capture runner and the files a task's own commits touched.
 */
import { SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import { listOwnCommits, mergeNameStatus } from "../services/own-commits";
import { type TaskFile } from "../../shared/task-labels";

/**
 * Run git in `cwd`, capturing stdout/stderr/exit. Never throws (code 1 on spawn
 * failure) and disables the credential prompt so a push that needs auth fails
 * fast instead of hanging the request.
 */
export async function runGitCap(cwd: string, args: string[], timeoutMs: number = SPAWN_TIMEOUT.write): Promise<{ code: number; out: string; err: string }> {
  const r = await runGit(cwd, args, { timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

/**
 * The files whose OWN change differs between two deliveries of the same card.
 * Not `git diff from to`: after the rebase a conflict asks for, that diff also
 * carries everything main received in between, other cards' files included, and
 * every fix would look like a new change to look at. Here each delivery is read
 * against its own merge base with origin/main, and a file counts when the card's
 * patch on it is not the same (hunk positions and blob ids ignored).
 */
export async function ownChangesBetween(repo: string, from: string, to: string): Promise<string[] | null> {
  const base = async (c: string) => (await runGitCap(repo, ["merge-base", c, "origin/main"])).out.trim();
  const [b1, b2] = [await base(from), await base(to)];
  if (!b1 || !b2) return null;
  const names = async (b: string, c: string) => {
    const r = await runGitCap(repo, ["diff", "--name-only", b, c]);
    return r.code === 0 ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : null;
  };
  const [n1, n2] = [await names(b1, from), await names(b2, to)];
  if (!n1 || !n2) return null;
  const patch = async (b: string, c: string, f: string) =>
    (await runGitCap(repo, ["diff", b, c, "--", f])).out.split("\n").filter((l) => !l.startsWith("index ") && !l.startsWith("@@")).join("\n");
  const out: string[] = [];
  for (const f of new Set([...n1, ...n2])) {
    if (!n1.includes(f) || !n2.includes(f) || (await patch(b1, from, f)) !== (await patch(b2, to, f))) out.push(f);
  }
  return out;
}

/**
 * I file che i commit PROPRI del task hanno toccato — la base su cui si derivano
 * `visibile`/`invisibile` e il GENERE della card.
 *
 * PROPRI e non `main...HEAD`: un ramo nato dall'HEAD di un checkout condiviso
 * eredita i commit di chi ci stava sopra, e su quei file la regola risponde alla
 * domanda di un'altra card. Ricostruendo a mano la coda dell'11/08, le due basi
 * davano risposte diverse su 6 card su 29 — fra cui una ricerca che aveva
 * prodotto un solo `.md` e che, letta sul ramo intero, sembrava toccare 83 file
 * di client.
 *
 * `--name-status` e non `--name-only`: il path dice DOVE sta il file, non se è
 * nato qui, e senza quel flag `deriveKind` non può separare una funzionalità
 * nuova da una modifica a codice che esisteva già.
 *
 * `null` = non contabile (niente worktree, git muto): chi chiama non scrive
 * niente. `[]` = verificato, nessun file — che NON è invisibilità (vedi
 * `deriveCloser`): una card senza codice è una DECISIONE, e la chiude un umano.
 */
export async function ownCommitFiles(cwd: string, mainRef = "main"): Promise<TaskFile[] | null> {
  const head = await runGitCap(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.code === 0 ? head.out.trim() : "";
  if (!branch || branch === "HEAD") return null; // detached: non c'è un ramo di cui dire "suo"
  return ownBranchFiles(cwd, branch, mainRef);
}

/**
 * The same files, for a branch named from outside: the repo's checkout answers,
 * the branch need not be checked out anywhere (a branch planted from another
 * machine's run is only a ref).
 */
export async function ownBranchFiles(cwd: string, branch: string, mainRef = "main"): Promise<TaskFile[] | null> {
  const commits = await listOwnCommits(cwd, branch, { mainRef, runGit: gitRunner });
  if (commits === null) return null;
  const outputs: string[] = [];
  for (const sha of commits) {
    const r = await runGitCap(cwd, ["show", "--name-status", "--format=", "--no-renames", sha]);
    if (r.code !== 0) return null;
    outputs.push(r.out);
  }
  return mergeNameStatus(outputs);
}

/** Adattatore fra `runGitCap` e la firma del runner di `own-commits.ts`. */
export const gitRunner = async (cwd: string, args: string[]) => {
  const r = await runGitCap(cwd, args);
  return { code: r.code, stdout: r.out, stderr: r.err };
};

