/**
 * I rami locali che NON sono su main, con il task a cui appartengono.
 *
 * PERCHÉ. La board sa dire «N task chiusi il cui lavoro non risulta su main»,
 * ma solo per i task CHIUSI: un ramo che appartiene a un task ancora in backlog
 * — o a nessun task — non compare da nessuna parte. È così che quattro rami con
 * lavoro fatto e verificato sono rimasti invisibili per settimane, mentre la
 * board riproponeva come «da fare» cose che erano già scritte lì dentro (task
 * `44e893f4`, scoperto il 04/08 implementando due volte la stessa cosa).
 *
 * E non è solo lavoro duplicato: quei commit vivono su un filo solo. Il
 * cleanup del dispatcher li cancellava quando un task tornava in coda — buco
 * tappato in `afbde262`, ma un ramo che nessuno vede resta un ramo che nessuno
 * salva.
 *
 * COME. Due domande a git (quali rami non sono su main, e quanti commit hanno)
 * e una al DB (di chi sono). L'abbinamento passa per tre strade, in ordine di
 * forza: il branch di consegna registrato sul task, il registro dei worktree, e
 * infine la convenzione del nome. Un ramo che non si abbina resta nell'elenco
 * SENZA task — è anzi il caso più interessante, perché è quello che nessuno
 * reclamerà.
 *
 * La parte pura è l'abbinamento; le due letture (git, DB) sono iniettate.
 */

import { existsSync } from "node:fs";
import type { GitRunner } from "./own-commits";

/**
 * THE SCAN, kept apart from the pairing so that both halves can be measured.
 *
 * `main` is not a law of nature. `--no-merged=main` EXITS NON-ZERO when the
 * repo has no branch by that name, and the route turned that into a 500 with a
 * message that collapsed two different situations into one sentence — "not a
 * repo, or main does not exist". Every e2e sandbox is a fresh repo without
 * `main`, so every run printed those 500s in the middle of the test output,
 * where a real failure has to be found (measured again 2026-09-09, and the card
 * that reported it, 32fa56d2, had been in the backlog since).
 *
 * The two situations get two answers, because the reader does different things
 * with them:
 *   `no-path`    — the folder is not there. THAT is the one that keeps the
 *                  alarm: a project configured on a path that has vanished has
 *                  branches nobody can see, and answering "none" would be a lie
 *                  of omission.
 *   `not-a-repo` — a real folder, no git in it. Topics allows a project that is
 *                  not a checkout; asking which of its branches are outside the
 *                  base is a question with an empty answer, not an error.
 *   `no-base`    — a checkout with no `main` and no `master`. Nothing is
 *                  "outside the base" when there is no base.
 *
 * Only the first is a failure. The other two are empty answers that SAY why,
 * because turning every one of them into an empty list would trade a noisy
 * alarm for a silent one.
 */
export type BranchScan =
  | { kind: "ok"; base: string; branches: BranchRow[] }
  | { kind: "no-base" }
  | { kind: "not-a-repo" }
  | { kind: "no-path" };

const BASE_CANDIDATES = ["main", "master"] as const;

async function run(cwd: string, args: string[], runGit?: GitRunner): Promise<{ code: number; stdout: string }> {
  if (runGit) {
    try { const r = await runGit(cwd, args); return { code: r.code, stdout: r.stdout }; }
    catch { return { code: 1, stdout: "" }; }
  }
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch { return { code: 1, stdout: "" }; }
}

/** Local branches that are not merged into the repo's base branch, and how far ahead. */
export async function scanBranchesOutsideBase(
  projectPath: string,
  runGit?: GitRunner,
  /** Injected by the tests; the real one is `existsSync`. */
  pathExists: (p: string) => boolean = existsSync,
): Promise<BranchScan> {
  if (!pathExists(projectPath)) return { kind: "no-path" };
  let base: string | null = null;
  for (const candidate of BASE_CANDIDATES) {
    if ((await run(projectPath, ["rev-parse", "--verify", "-q", `refs/heads/${candidate}`], runGit)).code === 0) {
      base = candidate;
      break;
    }
  }
  if (!base) {
    // The base is missing — but is there a repo at all? The answer decides
    // between an empty list and an error, so it is asked rather than guessed.
    const repo = await run(projectPath, ["rev-parse", "--git-dir"], runGit);
    return repo.code === 0 ? { kind: "no-base" } : { kind: "not-a-repo" };
  }
  const listed = await run(projectPath, ["for-each-ref", "--format=%(refname:short)", `--no-merged=${base}`, "refs/heads"], runGit);
  if (listed.code !== 0) return { kind: "not-a-repo" };
  const names = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const branches = await Promise.all(names.map(async (name) => {
    const counted = await run(projectPath, ["rev-list", "--count", `${base}..${name}`], runGit);
    const n = Number(counted.stdout.trim());
    return { name, ahead: Number.isFinite(n) ? n : 0 };
  }));
  return { kind: "ok", base, branches };
}

export interface BranchRow {
  /** Nome del ramo, es. `topics/gallant-plume`. */
  name: string;
  /** Commit che non sono su main. 0 ⇒ il ramo non porta niente di suo. */
  ahead: number;
}

export interface TaskBranchRef {
  taskId: string;
  taskText: string;
  taskStatus: string;
  /** `tasks.delivery_branch`, quando c'è: è la fonte più forte. */
  deliveryBranch?: string | null;
  /** Il ramo del worktree legato al task, se ne ha uno. */
  worktreeBranch?: string | null;
}

export interface InventoryEntry extends BranchRow {
  taskId: string | null;
  taskText: string | null;
  taskStatus: string | null;
  /** Come si è arrivati all'abbinamento — serve a fidarsi o no della riga. */
  matchedBy: "delivery" | "worktree" | "nessuno";
}

/**
 * Abbina i rami ai task. Puro.
 *
 * L'ordine delle fonti NON è arbitrario: `delivery_branch` è ciò che il task ha
 * DICHIARATO di aver consegnato, il worktree è dove stava lavorando. Il primo
 * sopravvive alla potatura del worktree, il secondo no — quindi quando dicono
 * cose diverse vince il primo.
 *
 * Non c'è un ripiego «sul nome che somiglia»: due rami possono chiamarsi in modo
 * simile per caso, e un abbinamento sbagliato è peggio di nessun abbinamento —
 * manderebbe qualcuno a cercare il lavoro nel task sbagliato.
 */
export function buildBranchInventory(
  branches: readonly BranchRow[],
  tasks: readonly TaskBranchRef[],
): InventoryEntry[] {
  const byDelivery = new Map<string, TaskBranchRef>();
  const byWorktree = new Map<string, TaskBranchRef>();
  for (const t of tasks) {
    if (t.deliveryBranch) byDelivery.set(t.deliveryBranch, t);
    if (t.worktreeBranch) byWorktree.set(t.worktreeBranch, t);
  }
  return branches.map((b) => {
    const t = byDelivery.get(b.name) ?? byWorktree.get(b.name) ?? null;
    const matchedBy: InventoryEntry["matchedBy"] =
      byDelivery.has(b.name) ? "delivery" : byWorktree.has(b.name) ? "worktree" : "nessuno";
    return {
      ...b,
      taskId: t?.taskId ?? null,
      taskText: t?.taskText ?? null,
      taskStatus: t?.taskStatus ?? null,
      matchedBy,
    };
  });
}

/**
 * Il riepilogo in una riga, ordinato per quanto è preoccupante.
 *
 * Un ramo ORFANO (nessun task) è il caso peggiore e va per primo: nessuno lo
 * reclamerà mai. Poi quelli di task ancora aperti — lavoro in corso che la board
 * mostra come «da fare» pur essendo già scritto. Per ultimi quelli dei task
 * chiusi, che il chip «non su main» già segnalava.
 */
export function summarizeInventory(entries: readonly InventoryEntry[]): {
  total: number;
  orphan: number;
  onOpenTasks: number;
  onClosedTasks: number;
} {
  let orphan = 0, onOpenTasks = 0, onClosedTasks = 0;
  for (const e of entries) {
    if (!e.taskId) orphan++;
    else if (e.taskStatus === "done") onClosedTasks++;
    else onOpenTasks++;
  }
  return { total: entries.length, orphan, onOpenTasks, onClosedTasks };
}
