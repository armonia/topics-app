/**
 * `free-checkout` su GIT VERO.
 *
 * Il contratto è puro e collaudato altrove (`worktree-gc.test.ts`), ma la sua
 * promessa non è una stringa: è che dopo la passata la CARTELLA non ci sia più e
 * il BRANCH sia ancora risolvibile. Quella si verifica solo con `git rev-parse`
 * su un repo che esiste — un mock che restituisce `true` avrebbe superato anche
 * la versione che cancella il branch.
 *
 * Tre casi, che sono le tre righe da non sbagliare:
 *   • task `done`, albero pulito, branch conservato → cartella via, commit vivi;
 *   • task `in_progress` → cartella INTATTA anche se pulita;
 *   • modifiche non committate → cartella INTATTA, e il GC dice perché.
 *
 * Il land è forzato a `skipped`: è il caso NORMALE da `03ca44c3` (il land rifiuta
 * un branch che porta commit di un'altra sessione) ed è esattamente lo scenario
 * che teneva in vita 77 worktree per 33,9 GB.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sweepWorktrees, type GcWorktree, type TaskStatus, type WorktreeGcDeps } from "./worktree-gc";
import { worktreeRealDirt } from "./task-automerge";
import { branchStatusFromRepo } from "./branch-status";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

/** `git rev-parse <branch>` esce zero ⇒ i commit sono ancora raggiungibili. */
function branchResolves(repo: string, branch: string): boolean {
  return git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).code === 0;
}

describe("free-checkout su git vero", () => {
  let repo: string;
  let root: string;
  /** Worktree montati, per id. */
  let trees: Map<string, GcWorktree>;
  /** Stato del task legato a ogni worktree. */
  let statuses: Map<string, TaskStatus>;
  let logs: string[];
  let notes: Array<[string, string]>;

  /** Un worktree `branch`-mode con un commit che main NON ha. */
  function mountWorktree(id: string, opts: { dirty?: boolean } = {}): GcWorktree {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "lavoro consegnato\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-m", `lavoro di ${id}`).code).toBe(0);
    if (opts.dirty) writeFileSync(join(absPath, `${id}.txt`), "modifica MAI committata\n");
    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    return wt;
  }

  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (id) => ({ taskId: `task-${id}`, status: statuses.get(id) ?? "done", archived: false }),
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeRealDirt(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      // Il cancello di `03ca44c3`: il branch porta commit non della card.
      tryLand: async () => "skipped",
      freeCheckout: async (id) => {
        const wt = trees.get(id)!;
        // `deleteBranch: false` — la cartella, non il ref.
        const r = git(repo, "worktree", "remove", "--force", wt.absPath);
        if (r.code !== 0) return false;
        trees.delete(id);
        return true;
      },
      reap: async (id) => {
        const wt = trees.get(id)!;
        git(repo, "worktree", "remove", "--force", wt.absPath);
        git(repo, "branch", "-D", wt.branchName!);
        trees.delete(id);
        return true;
      },
      noteOnTask: (taskId, msg) => notes.push([taskId, msg]),
      log: (m) => logs.push(m),
      ...over,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-gc-"));
    repo = join(root, "repo");
    git(root, "init", "--quiet", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    trees = new Map();
    statuses = new Map();
    logs = [];
    notes = [];
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("task done + albero pulito → la CARTELLA sparisce e il BRANCH resta risolvibile", async () => {
    const wt = mountWorktree("chiuso");
    statuses.set("chiuso", "done");
    const tip = git(wt.absPath, "rev-parse", "HEAD").out;
    expect(tip).toHaveLength(40);

    const s = await sweepWorktrees(deps());

    // PRIMA il lavoro, poi lo spazio: se una modifica trasforma `free-checkout`
    // in `reap` è QUESTA riga che deve diventare rossa per prima, non un
    // contatore — il rosso deve nominare il danno, non l'effetto collaterale.
    // I commit ci sono: `git rev-parse` verde, e sullo STESSO tip di prima.
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
    expect(git(repo, "rev-parse", wt.branchName!).out).toBe(tip);
    // E il contenuto è ancora leggibile dal repo, non solo il ref.
    expect(git(repo, "show", `${wt.branchName}:chiuso.txt`).out).toBe("lavoro consegnato");
    // La cartella invece non c'è più: è lo spazio che si libera.
    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.freed).toBe(1);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(0);
  });

  test("il task viene avvisato di DOVE è finito il suo lavoro", async () => {
    const wt = mountWorktree("avvisato");
    statuses.set("avvisato", "done");

    await sweepWorktrees(deps());

    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe("task-avvisato");
    expect(notes[0][1]).toContain(wt.branchName!);
    expect(notes[0][1]).toContain("NON è perso");
  });

  for (const status of ["todo", "in_progress", "review", "backlog"] as const) {
    test(`task '${status}' → cartella INTATTA anche se pulita`, async () => {
      const wt = mountWorktree(`attivo-${status}`);
      statuses.set(`attivo-${status}`, status);

      const s = await sweepWorktrees(deps());

      expect(s.freed).toBe(0);
      expect(s.reaped).toBe(0);
      expect(s.kept).toBe(1);
      expect(existsSync(wt.absPath)).toBe(true);
      expect(branchResolves(repo, wt.branchName!)).toBe(true);
    });
  }

  test("modifiche non committate → cartella INTATTA, e il GC lo dice", async () => {
    const wt = mountWorktree("sporco", { dirty: true });
    statuses.set("sporco", "done");

    const s = await sweepWorktrees(deps());

    expect(s.freed).toBe(0);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(1);
    expect(existsSync(wt.absPath)).toBe(true);
    // Il file non committato è ancora lì, con il suo contenuto.
    expect(Bun.spawnSync(["cat", join(wt.absPath, "sporco.txt")]).stdout.toString().trim())
      .toBe("modifica MAI committata");
    // «Lo dice»: il motivo del keep è registrato e nomina lo sporco.
    expect(Object.keys(s.keptReasons).join(" ")).toContain("non committate");
  });

  test("junk d'agente non è sporco: `.topics-daemon/` da solo non salva la cartella", async () => {
    const wt = mountWorktree("junk");
    statuses.set("junk", "done");
    Bun.spawnSync(["mkdir", "-p", join(wt.absPath, ".topics-daemon")]);
    writeFileSync(join(wt.absPath, ".topics-daemon", "state.json"), "{}\n");

    const s = await sweepWorktrees(deps());

    expect(s.freed).toBe(1);
    expect(existsSync(wt.absPath)).toBe(false);
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
  });

  test("una passata mista tocca solo ciò che deve: 1 liberato, 2 intatti", async () => {
    const chiuso = mountWorktree("misto-chiuso");
    const attivo = mountWorktree("misto-attivo");
    const sporco = mountWorktree("misto-sporco", { dirty: true });
    statuses.set("misto-chiuso", "done");
    statuses.set("misto-attivo", "in_progress");
    statuses.set("misto-sporco", "done");

    const s = await sweepWorktrees(deps());

    expect(s.total).toBe(3);
    expect(s.freed).toBe(1);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(2);
    expect(existsSync(chiuso.absPath)).toBe(false);
    expect(existsSync(attivo.absPath)).toBe(true);
    expect(existsSync(sporco.absPath)).toBe(true);
    // Nessuno dei tre branch è stato perso.
    for (const wt of [chiuso, attivo, sporco]) {
      expect(branchResolves(repo, wt.branchName!)).toBe(true);
    }
  });

  test("un host che non sa liberare il checkout non perde niente: keep, cartella e branch intatti", async () => {
    const wt = mountWorktree("host-cieco");
    statuses.set("host-cieco", "done");

    const s = await sweepWorktrees(deps({ freeCheckout: undefined }));

    expect(s.freed).toBe(0);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(1);
    expect(existsSync(wt.absPath)).toBe(true);
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
  });

  test("land riuscito davvero (contenuto su main) → reap pieno, branch incluso", async () => {
    const wt = mountWorktree("landato");
    statuses.set("landato", "done");

    const s = await sweepWorktrees(deps({
      tryLand: async () => {
        // Un land vero: il contenuto arriva su main.
        expect(git(repo, "merge", "--no-ff", "-m", "land", wt.branchName!).code).toBe(0);
        return "landed";
      },
    }));

    expect(s.landed).toBe(1);
    expect(s.reaped).toBe(1);
    expect(s.freed).toBe(0);
    expect(existsSync(wt.absPath)).toBe(false);
    expect(branchResolves(repo, wt.branchName!)).toBe(false);
    // Il lavoro non è perso: è su main.
    expect(git(repo, "show", "main:landato.txt").out).toBe("lavoro consegnato");
  });
});
