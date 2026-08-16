/**
 * LANDARE UNA CARD IN REVIEW, PER INTERO E SU ROBA VERA.
 *
 * Il 12/08 quattro card che stavano in `review` ad aspettare una decisione umana
 * — `d6baaf5e`, `3bde1ab0`, `c8ea8173`, `5472e584` — sono finite in `backlog`
 * marcate `failed` nella stessa ora, tutte con la stessa riga: «Worktree
 * liberato: il branch del worktree non esiste piu'». Nessuna aveva fallito. Il
 * loro lavoro era ATTERRATO: il land pota il ramo, il GC trova una riga fantasma
 * e parcheggia la card. Il backlog non lo dispaccia nessuno e non lo guarda
 * nessuno, quindi la decisione non era rimandata: era persa di vista. E capitava
 * proprio alle card che avevano funzionato.
 *
 * Perché questo file esiste accanto a `worktree-gc.test.ts`, che il contratto lo
 * collauda già: lì i pezzi sono finti. Qui il ramo lo pota GIT dopo un merge
 * vero, e lo stato della card lo scrive il `TaskService` vero su uno SCHEMA vero
 * (la catena delle migration). Un mock che restituisce `"gone"` avrebbe superato
 * anche la versione che parcheggia, ed è esattamente ciò che è successo.
 *
 * Le tre righe che devono reggere, che sono la barra del task:
 *   • una card in `review` il cui ramo è stato potato da un land RESTA in review;
 *   • il suo contatore dei tentativi non si muove di un'unità;
 *   • un ramo sparito senza atterraggio, sotto un task che dichiara di
 *     lavorarci, si parcheggia ancora — il guasto vero non si è mascherato.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { branchStatusFromRepo, commitStatusFromRepo } from "./branch-status";
import { classifyLanding } from "./landing-audit";
import { worktreeDirtProbe } from "./task-automerge";
import { abandonNoticeFromRepo } from "./worktree-abandon-notice";
import { sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";

const PID = "topics-app-live";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, dispatch_retry_cap INTEGER)`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  return db;
}

describe("una card in review che viene landata", () => {
  let repo: string;
  let root: string;
  let db: Database;
  let svc: TaskService;
  let trees: Map<string, GcWorktree>;
  /** Il task legato a ogni worktree. */
  let bound: Map<string, string>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gc-review-repo-"));
    root = mkdtempSync(join(tmpdir(), "gc-review-trees-"));
    trees = new Map();
    bound = new Map();
    db = freshDb();
    let n = 0;
    svc = createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `id-${++n}` });

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    db.close();
  });

  /**
   * Una card consegnata: worktree col suo ramo, un commit dentro, lo scatto
   * della consegna registrato come lo registra la consegna vera, e la card in
   * `review` con dei tentativi già spesi (per poterli guardare dopo).
   */
  function cardConsegnata(id: string, attempts = 1): { taskId: string; wt: GcWorktree } {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-q", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "il lavoro della card\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-q", "-m", `lavoro di ${id}`).code).toBe(0);
    const commit = git(absPath, "rev-parse", "HEAD").out;

    const t = svc.create({ projectId: PID, text: `card ${id}`, status: "todo" });
    db.prepare("UPDATE tasks SET status = 'review', dispatch_attempts = ? WHERE id = ?").run(attempts, t.id);
    svc.recordDelivery({ taskId: t.id, branch, commit });

    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    bound.set(id, t.id);
    return { taskId: t.id, wt };
  }

  /** Il land come lo fa il sistema: merge su main e ramo POTATO. */
  function landa(wt: GcWorktree) {
    expect(git(repo, "merge", "-q", "--no-ff", "-m", `land ${wt.branchName}`, wt.branchName!).code).toBe(0);
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);
  }

  /**
   * Le stesse deps che monta `server.ts`, con dentro le funzioni vere: git per
   * lo stato dei rami e dei commit, il `TaskService` per lo stato delle card.
   */
  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (wtId) => {
        const taskId = bound.get(wtId);
        if (!taskId) return { taskId: null };
        const t = svc.get(taskId)!.task;
        return { taskId, status: t.status as "review", archived: false };
      },
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeDirtProbe(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      tryLand: async () => "skipped",
      deliveryLanded: async (taskId) => {
        const commit = svc.get(taskId)?.task?.deliveryCommit;
        if (!commit) return null;
        const state = classifyLanding(await commitStatusFromRepo(repo, commit));
        return state === "unverifiable" ? null : state === "landed";
      },
      unbind: async (taskId, wt, reason, deliveryLanded) => {
        const notice = await abandonNoticeFromRepo({
          reason, repoPath: repo, branchName: wt.branchName,
          deliveryCommit: svc.get(taskId)?.task?.deliveryCommit ?? null,
          deliveryLanded, taskFate: "stays",
        });
        svc.release({ taskId, requeue: false, keepStatus: true, by: "system", reason: notice });
        return trees.delete(wt.id);
      },
      abandon: async (taskId, wt, reason) => {
        const notice = await abandonNoticeFromRepo({ reason, repoPath: repo, branchName: wt.branchName });
        svc.release({ taskId, requeue: false, parkState: "failed", by: "system", reason: notice });
        return trees.delete(wt.id);
      },
      reap: async (wtId) => trees.delete(wtId),
      freeCheckout: async (wtId) => trees.delete(wtId),
      noteOnTask: (taskId, content) => { svc.addComment({ taskId, author: "system", content }); },
      log: () => {},
      ...over,
    };
  }

  test("landata → resta in review, senza timbro e col contatore fermo", async () => {
    const { taskId, wt } = cardConsegnata("d6baaf5e", 1);
    const prima = svc.get(taskId)!.task;
    expect(prima.status).toBe("review");

    landa(wt);
    const s = await sweepWorktrees(deps());

    const dopo = svc.get(taskId)!.task;
    expect(dopo.status).toBe("review");                 // la barra
    expect(dopo.dispatchAttempts).toBe(prima.dispatchAttempts); // la barra
    expect(dopo.dispatchState).toBeNull();
    expect(dopo.dispatchError).toBeNull();
    expect(dopo.assignedTopicId).toBeNull();
    expect(s.unbound).toBe(1);
    expect(s.abandoned).toBe(0);
  });

  test("il thread spiega l'atterraggio invece di suonare l'allarme", async () => {
    const { taskId, wt } = cardConsegnata("3bde1ab0");
    landa(wt);
    await sweepWorktrees(deps());

    const testo = svc.get(taskId)!.comments.map((c) => c.content).join("\n");
    expect(testo).toContain("atterraggio riuscito");
    expect(testo).not.toContain("torna in backlog");
    expect(testo).not.toContain("git fsck");
  });

  test("quattro card nella stessa passata: quattro restano in review", async () => {
    const cards = ["d6baaf5e", "3bde1ab0", "c8ea8173", "5472e584"].map((id) => cardConsegnata(id));
    for (const c of cards) landa(c.wt);

    const s = await sweepWorktrees(deps());

    expect(cards.map((c) => svc.get(c.taskId)!.task.status)).toEqual(["review", "review", "review", "review"]);
    expect(s.unbound).toBe(4);
    expect(s.abandoned).toBe(0);
  });

  // IL CONTROLLO CHE IMPEDISCE DI AVER SOLO SPENTO L'ALLARME. Un ramo cancellato
  // SENZA che il lavoro sia arrivato su main, sotto un task che dichiara di
  // starci lavorando, è il guasto vero: quello si parcheggia ancora.
  test("ramo cancellato senza land, task attivo → parcheggiato come sempre", async () => {
    const { taskId, wt } = cardConsegnata("perduta");
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    // Niente merge: il ramo se ne va e il lavoro con lui.
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);

    const s = await sweepWorktrees(deps());

    const dopo = svc.get(taskId)!.task;
    expect(dopo.status).toBe("backlog");
    expect(dopo.dispatchState).toBe("failed");
    expect(s.abandoned).toBe(1);
    expect(s.unbound).toBe(0);
  });

  // La stessa perdita sotto una card in review: la card NON scende comunque —
  // in review aspetta una persona — ma la frase non finge che vada tutto bene.
  test("ramo perduto sotto una card in review → resta in review, con l'allarme scritto", async () => {
    const { taskId, wt } = cardConsegnata("perduta-in-review", 2);
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);

    await sweepWorktrees(deps());

    const dopo = svc.get(taskId)!.task;
    expect(dopo.status).toBe("review");
    expect(dopo.dispatchAttempts).toBe(2);
    const testo = svc.get(taskId)!.comments.map((c) => c.content).join("\n");
    expect(testo).toContain("il branch NON c'è");
    expect(testo).toContain("git fsck --lost-found");
  });
});
