/**
 * IL RESIDUO SALVATO SUL BRANCH, su git vero.
 *
 * Il 19/08/2026 la potatura girava e non raccoglieva niente: **191 worktree,
 * 0 raccolti**, e per 137 di loro il motivo era uno solo — «modifiche non
 * committate (junk escluso)». La regola era giusta (quella cartella era l'unica
 * copia) ma senza uscita: nessun passaggio la trasformava mai in una copia fra
 * tante, quindi ~6 GB di sorgenti restavano fermi per sempre su task CHIUSI.
 *
 * Qui si verifica la sola cosa che rende la nuova strada accettabile: che dopo
 * la passata **il testo mai committato sia leggibile dal repo**, non dalla
 * cartella. Un mock che risponde `true` supererebbe anche la versione che
 * cancella e basta; `git show <branch>:<file>` no.
 *
 * E le tre righe da non sbagliare mai, ognuna col suo caso:
 *   • senza il mezzo per salvare → la cartella resta (la vecchia risposta);
 *   • con un conflitto aperto    → la cartella resta (sigillare è peggio);
 *   • orfano con branch vivo     → il checkout se ne va, i commit no.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sweepWorktrees, decideWorktreeReap, type GcWorktree, type TaskStatus, type WorktreeGcDeps } from "./worktree-gc";
import { commitWorktreeResidue, RESIDUE_SUBJECT } from "./worktree-residue";
import { worktreeDirtProbe } from "./task-automerge";
import { branchStatusFromRepo } from "./branch-status";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}
const branchResolves = (repo: string, b: string) =>
  git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`).code === 0;

describe("la decisione pura", () => {
  const base = {
    taskStatus: "done" as TaskStatus, taskArchived: false, hasRealDirt: true,
    mergedIntoMain: false, autoMergeEnabled: true, mode: "branch" as const,
    idleDays: null, abandonAfterDays: 7,
  };

  test("sporco + il mezzo per salvarlo → si salva, non si tiene", () => {
    expect(decideWorktreeReap({ ...base, canCommitResidue: true }).action).toBe("commit-residue");
  });

  test("sporco SENZA il mezzo → resta `keep`: la regola non si indebolisce mai da sola", () => {
    expect(decideWorktreeReap({ ...base, canCommitResidue: false }).action).toBe("keep");
    expect(decideWorktreeReap(base).action).toBe("keep");
  });

  test("sporco ma il branch è sparito → `keep`: il commit non sarebbe raggiungibile", () => {
    expect(decideWorktreeReap({ ...base, canCommitResidue: true, branchGone: true }).action).toBe("keep");
  });

  test("un task ATTIVO non si tocca, nemmeno col mezzo in mano", () => {
    const d = decideWorktreeReap({ ...base, taskStatus: "review", canCommitResidue: true });
    expect(d.action).toBe("keep");
    expect(d.reason).toContain("attivo");
  });
});

/**
 * LE GUARDIE DEL MODULO, prese una alla volta.
 *
 * Il caso «conflitto» della passata completa non le distingue: la guardia sui
 * ref di operazione-in-corso scatta per prima e le altre non vengono mai
 * eseguite. Falsificato il 19/08: disattivare `hasConflict` lasciava la barra
 * VERDE. Qui ognuna ha il suo stato di git, costruito apposta perché sia
 * l'unica a poter rispondere.
 */
describe("le guardie di commitWorktreeResidue", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "res-g-"));
    git(dir, "init", "--quiet", ".");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(dir, "f.txt"), "base\n");
    git(dir, "add", "-A"); git(dir, "commit", "-m", "base");
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  test("conflitto SENZA operazione in corso (stash pop) → non si committa", async () => {
    // Uno `stash pop` finito male lascia `UU` e nessun *_HEAD: e' il solo stato
    // in cui `hasConflict` e' l'unica guardia rimasta in piedi.
    writeFileSync(join(dir, "f.txt"), "mio\n");
    git(dir, "stash");
    writeFileSync(join(dir, "f.txt"), "altro\n");
    git(dir, "add", "-A"); git(dir, "commit", "-m", "altro");
    git(dir, "stash", "pop");
    expect(git(dir, "status", "--porcelain").out).toMatch(/^UU/m);
    for (const r of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
      expect(git(dir, "rev-parse", "--verify", "--quiet", r).code).not.toBe(0);
    }

    const res = await commitWorktreeResidue(dir);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("conflitto");
    // E soprattutto: nessun commit fabbricato sopra i marcatori.
    expect(git(dir, "log", "-1", "--format=%s").out).toBe("altro");
  });

  test("cherry-pick a metà → non si committa (`MERGE_HEAD` da solo non lo vedrebbe)", async () => {
    git(dir, "checkout", "-q", "-b", "lato");
    writeFileSync(join(dir, "f.txt"), "lato\n");
    git(dir, "add", "-A"); git(dir, "commit", "-m", "lato");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "f.txt"), "main\n");
    git(dir, "add", "-A"); git(dir, "commit", "-m", "main");
    expect(git(dir, "cherry-pick", "lato").code).not.toBe(0);
    expect(git(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").code).toBe(0);
    expect(git(dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD").code).not.toBe(0);

    const res = await commitWorktreeResidue(dir);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("CHERRY_PICK_HEAD");
  });

  test("HEAD staccata → non si committa: nessun ramo raggiungerebbe quel commit", async () => {
    git(dir, "checkout", "-q", "--detach");
    writeFileSync(join(dir, "f.txt"), "roba non committata\n");
    expect(git(dir, "symbolic-ref", "--quiet", "HEAD").code).not.toBe(0);

    const res = await commitWorktreeResidue(dir);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("staccata");
  });

  test("albero pulito → non si fabbrica un commit vuoto", async () => {
    const res = await commitWorktreeResidue(dir);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("pulito");
    expect(git(dir, "log", "--format=%s").out.split("\n")).toHaveLength(1);
  });
});

describe("il residuo su git vero", () => {
  let repo: string, root: string;
  let trees: Map<string, GcWorktree>;
  let statuses: Map<string, TaskStatus | null>;
  let logs: string[];

  function mountWorktree(id: string, opts: { dirty?: string } = {}): GcWorktree {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "lavoro consegnato\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-m", `lavoro di ${id}`).code).toBe(0);
    if (opts.dirty) writeFileSync(join(absPath, `${id}.txt`), opts.dirty);
    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    return wt;
  }

  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (id) => {
        const st = statuses.get(id);
        return st === null ? { taskId: null } : { taskId: `task-${id}`, status: st ?? "done", archived: false };
      },
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeDirtProbe(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      tryLand: async () => "skipped",
      commitResidue: async (wt) => (await commitWorktreeResidue(wt.absPath)).ok,
      freeCheckout: async (id) => {
        const wt = trees.get(id)!;
        if (git(repo, "worktree", "remove", "--force", wt.absPath).code !== 0) return false;
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
      log: (m) => logs.push(m),
      ...over,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-res-"));
    repo = join(root, "repo");
    git(root, "init", "--quiet", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    trees = new Map(); statuses = new Map(); logs = [];
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  test("task chiuso + sporco → il testo MAI COMMITTATO si legge dal repo, e la cartella se ne va", async () => {
    const wt = mountWorktree("sporco", { dirty: "questa riga non e' mai stata committata\n" });
    statuses.set("sporco", "done");

    const s = await sweepWorktrees(deps());

    // LA RIGA CHE CONTA. Non «ha risposto true»: il testo si legge dal REPO,
    // attraverso il branch. Se il salvataggio diventasse una cancellazione,
    // e' questa che diventa rossa per prima, e nomina il danno.
    expect(git(repo, "show", `${wt.branchName}:sporco.txt`).out)
      .toBe("questa riga non e' mai stata committata");
    expect(git(repo, "log", "-1", "--format=%s", wt.branchName!).out).toBe(RESIDUE_SUBJECT);
    // Il commit di prima non e' stato riscritto: il residuo ci sta SOPRA.
    expect(git(repo, "log", "-2", "--format=%s", wt.branchName!).out.split("\n")[1]).toBe("lavoro di sporco");
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.residueCommitted).toBe(1);
    expect(s.freed).toBe(1);
  });

  test("senza il mezzo per salvare, la cartella resta INTATTA con dentro il suo lavoro", async () => {
    const wt = mountWorktree("nomezzo", { dirty: "roba non committata\n" });
    statuses.set("nomezzo", "done");

    const s = await sweepWorktrees(deps({ commitResidue: undefined }));

    expect(existsSync(wt.absPath)).toBe(true);
    expect(s.kept).toBe(1);
    expect(s.residueCommitted).toBe(0);
    expect(Object.keys(s.keptReasons).join()).toContain("non committate");
  });

  test("con un CONFLITTO aperto non si committa niente e la cartella resta", async () => {
    const wt = mountWorktree("conflitto");
    statuses.set("conflitto", "done");
    // main e il branch cambiano lo stesso file in modo incompatibile…
    writeFileSync(join(repo, "conflitto.txt"), "versione di main\n");
    git(repo, "add", "-A"); git(repo, "commit", "-m", "main tocca lo stesso file");
    // …e il merge dentro il worktree si ferma sui marcatori.
    expect(git(wt.absPath, "merge", "main").code).not.toBe(0);
    // git marca «entrambi hanno aggiunto» come `AA`, non `UU`: il conflitto ha
    // piu' di una sigla, ed e' il motivo per cui `hasConflict` le guarda tutte.
    expect(git(wt.absPath, "status", "--porcelain").out).toMatch(/^(U.|.U|AA|DD)/m);

    const s = await sweepWorktrees(deps());

    expect(existsSync(wt.absPath)).toBe(true);
    expect(s.residueCommitted).toBe(0);
    expect(s.kept).toBe(1);
  });

  test("orfano con commit non landati → il checkout se ne va, i commit restano sul branch", async () => {
    const wt = mountWorktree("orfano");
    statuses.set("orfano", null); // nessun task lo reclama
    const tip = git(wt.absPath, "rev-parse", "HEAD").out;

    const s = await sweepWorktrees(deps());

    expect(branchResolves(repo, wt.branchName!)).toBe(true);
    expect(git(repo, "rev-parse", wt.branchName!).out).toBe(tip);
    expect(git(repo, "show", `${wt.branchName}:orfano.txt`).out).toBe("lavoro consegnato");
    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.freed).toBe(1);
  });
});
