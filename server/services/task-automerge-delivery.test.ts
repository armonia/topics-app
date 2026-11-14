/**
 * @covers LAND-03
 * @covers LAND-15
 */
import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, declaredDeliveryFor, landFallout } from "./task-automerge";
import { UNPLANTED_DELIVERY_COMMIT } from "./branch-on-origin";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

/**
 * Il land contro la CONSEGNA, su git vero.
 *
 * Il difetto misurato l'11/08 (card `e54a9be6`): la card era stata ri-dispatchata
 * più volte e aveva quindi PIÙ rami. Ha consegnato su `topics/cheery-shepherd`
 * — dove l'umano, prima di approvare, aveva anche aggiunto il commit che
 * rimetteva `bun run lint` a 0 — ma il land ha risolto il ramo dal worktree VIVO
 * e ha mergiato `topics/gilded-galleon`, un altro ramo della stessa card con una
 * copia più vecchia dello stesso lavoro. Su main è atterrata la copia vecchia,
 * `lint` è tornato rosso, e il thread non ha detto niente: per il land era un
 * merge riuscito come tutti gli altri.
 *
 * Qui il repo è montato con quella forma esatta, e la guardia chiede due cose:
 * che atterri il ramo CONSEGNATO, e che ogni scostamento dallo scatto approvato
 * finisca in una frase (`deliveryDrift`) che il thread possa stampare.
 */

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/**
 *   main       base
 *   vivo       base ← V         (il ramo del worktree vivo: copia vecchia)
 *   consegnato base ← D1 ← D2   (il ramo consegnato; D2 aggiunto prima di approvare)
 */
function repoConDueRami(): { repo: string; d1: string; d2: string } {
  const repo = mkdtempSync(join(tmpdir(), "land-delivery-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  commit(repo, "base.txt", "base\n", "base");

  git(repo, "switch", "-q", "-c", "topics/vivo");
  commit(repo, "copia-vecchia.txt", "vecchia\n", "copia vecchia dello stesso lavoro");

  git(repo, "switch", "-q", "main");
  git(repo, "switch", "-q", "-c", "topics/consegnato");
  const d1 = commit(repo, "lavoro.txt", "lavoro\n", "il lavoro della card");
  const d2 = commit(repo, "lint-fix.txt", "tipizzato\n", "il fix che rimette lint a 0");

  git(repo, "switch", "-q", "main");
  return { repo, d1, d2 };
}

const land = (repo: string, liveBranch: string) =>
  createTaskAutoMerge({
    resolveTaskMerge: () => ({ repoPath: repo, branch: liveBranch, defaultBranch: "main" }),
  });

describe("land vs consegna — su git vero", () => {
  test("card con due rami: atterra il ramo CONSEGNATO, e lo dice", async () => {
    const { repo, d1 } = repoConDueRami();
    try {
      const res = await land(repo, "topics/vivo").tryMerge("t1", "card a due rami", {
        branch: "topics/consegnato",
        commit: d1,
      });

      expect(res.status).toBe("merged");
      if (res.status !== "merged") return;
      expect(res.branch).toBe("topics/consegnato");

      // La prova che conta: su main c'è il fix, non la copia vecchia.
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "lint-fix.txt"))).toBe(true);
      expect(existsSync(join(repo, "copia-vecchia.txt"))).toBe(false);

      // E il thread ha di che parlare: ramo diverso + un commit dopo la consegna.
      expect(res.deliveryDrift).toContain("topics/consegnato");
      expect(res.deliveryDrift).toContain("topics/vivo");
      expect(res.deliveryDrift).toContain("1 commit aggiunto DOPO la consegna");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("consegna e punta coincidono: niente da dire", async () => {
    const { repo, d2 } = repoConDueRami();
    try {
      const res = await land(repo, "topics/consegnato").tryMerge("t2", "consegna intatta", {
        branch: "topics/consegnato",
        commit: d2,
      });
      expect(res.status).toBe("merged");
      if (res.status !== "merged") return;
      expect(res.deliveryDrift).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("commit di consegna riscritto da un rebase: il land avvisa che pubblica la punta", async () => {
    const { repo } = repoConDueRami();
    try {
      const orfano = git(repo, "rev-parse", "topics/vivo"); // non è su `consegnato`
      const res = await land(repo, "topics/consegnato").tryMerge("t3", "consegna ribasata", {
        branch: "topics/consegnato",
        commit: orfano,
      });
      expect(res.status).toBe("merged");
      if (res.status !== "merged") return;
      expect(res.deliveryDrift).toContain("non è raggiungibile");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("ramo consegnato potato: pubblica il ramo vivo dicendo che la consegna non c'è più", async () => {
    const { repo, d1 } = repoConDueRami();
    try {
      const res = await land(repo, "topics/vivo").tryMerge("t4", "consegna sparita", {
        branch: "topics/sparito",
        commit: d1,
      });
      expect(res.status).toBe("merged");
      if (res.status !== "merged") return;
      expect(res.branch).toBe("topics/vivo");
      expect(res.deliveryDrift).toContain("non esiste più");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * L'AGENTE RILASCIATO — su git vero.
   *
   * `resolveTaskMerge` risolve card → `assigned_topic_id` → topic → worktree →
   * ramo. L'agente però si rilascia di routine (fine turno, o lo si ferma a
   * mano) e `assigned_topic_id` torna NULL: da lì in poi il land rispondeva
   * `no-branch` — l'unico codice che LASCIA la card in Done — anche col ramo
   * intatto. Misurato la notte del 12/08 su `ee5ebbb4`: ramo
   * `topics/transient-berry` presente, worktree presente, e il messaggio diceva
   * «nessun worktree/branch». Qui `resolveTaskMerge` risponde `null` come in
   * quella notte, e il land deve atterrare lo stesso.
   */
  test("agente rilasciato (resolveTaskMerge → null): il ramo CONSEGNATO atterra comunque", async () => {
    const { repo, d2 } = repoConDueRami();
    try {
      const am = createTaskAutoMerge({
        resolveTaskMerge: () => null,
        declaredDelivery: () => ({ repoPath: repo, branch: "topics/consegnato" }),
      });
      const res = await am.tryMerge("t5", "consegna senza agente", { branch: "topics/consegnato", commit: d2 });

      expect(res.status).toBe("merged");
      if (res.status !== "merged") return;
      expect(res.branch).toBe("topics/consegnato");
      // La prova che conta: il lavoro è DAVVERO su main.
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "lavoro.txt"))).toBe(true);
      expect(existsSync(join(repo, "lint-fix.txt"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * A card run on another machine returns with `deliveryBranch` null and its
   * branch only in `priorBranch`, pushed to origin from there (12/11, 17436204
   * and 403aad1f). The land goes through `declaredDeliveryFor`, the wiring the
   * server uses, against a real bare origin.
   */
  function remoteCardRepo(): { root: string; repo: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "land-remote-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "here");
    const clone = join(root, "there");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, repo);
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "switch", "-q", "-c", "main");
    commit(repo, "base.txt", "base\n", "base");
    git(repo, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, clone);
    git(clone, "config", "user.email", "t@t.t");
    git(clone, "config", "user.name", "t");
    return { root, repo, clone };
  }

  function landRemoteCard(repo: string, task: { deliveryBranch: string | null; priorBranch: string | null }, commit: string | null = null) {
    return createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: declaredDeliveryFor({
        getTask: () => ({ projectId: "topics-app-abc123", ...task }),
        resolveRepoPath: () => repo,
      }),
    }).tryMerge("t7", "remote card", { branch: task.deliveryBranch, commit });
  }

  test("remote card, branch only on origin: the land fetches it and brings its commits to main", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(clone, "switch", "-q", "-c", "topics/vexing-thorn");
      commit(clone, "remote-work.txt", "done there\n", "work done on the node");
      git(clone, "push", "-q", "origin", "topics/vexing-thorn");

      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: "topics/vexing-thorn" });

      expect(res.status).toBe("merged");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "remote-work.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("remote card, stale local branch: origin's later commit lands too", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(clone, "switch", "-q", "-c", "topics/singing-locket");
      commit(clone, "first.txt", "1\n", "first commit");
      git(clone, "push", "-q", "origin", "topics/singing-locket");
      git(repo, "fetch", "-q", "origin", "topics/singing-locket:topics/singing-locket");
      commit(clone, "second.txt", "2\n", "second commit, pushed later");
      git(clone, "push", "-q", "origin", "topics/singing-locket");

      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: "topics/singing-locket" });

      expect(res.status).toBe("merged");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "first.txt"))).toBe(true);
      expect(existsSync(join(repo, "second.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("remote card, stale local branch held by a worktree: the fetch is refused, so the land refuses with the reason", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(clone, "switch", "-q", "-c", "topics/held");
      commit(clone, "first.txt", "1\n", "first commit");
      git(clone, "push", "-q", "origin", "topics/held");
      git(repo, "fetch", "-q", "origin", "topics/held:topics/held");
      git(repo, "worktree", "add", "-q", join(root, "wt"), "topics/held");
      commit(clone, "second.txt", "2\n", "second commit, pushed later");
      git(clone, "push", "-q", "origin", "topics/held");

      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: "topics/held" });

      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("branch-stale");
      expect(landFallout(res.code).status).toBe("review");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "first.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("local branch rebased after its push: origin differs by sha only, so the land goes through", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(repo, "switch", "-q", "-c", "topics/rebased");
      commit(repo, "card.txt", "card\n", "the card's work");
      git(repo, "push", "-q", "origin", "topics/rebased");
      git(clone, "pull", "-q", "origin", "main");
      commit(clone, "other.txt", "other\n", "main moves on");
      git(clone, "push", "-q", "origin", "main");
      git(repo, "fetch", "-q", "origin", "main");
      git(repo, "rebase", "-q", "origin/main");
      git(repo, "switch", "-q", "main");

      const res = await landRemoteCard(repo, { deliveryBranch: "topics/rebased", priorBranch: null });

      expect(res.status).toBe("merged");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "card.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("node round that failed to plant: the round sent back before it does not land", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      // Round 1, rejected by a person: its branch stays as `priorBranch` and on origin.
      git(repo, "switch", "-q", "-c", "topics/round1");
      commit(repo, "rejected.txt", "no\n", "the rejected round");
      git(repo, "push", "-q", "origin", "topics/round1");
      git(repo, "switch", "-q", "main");
      // Round 2 ran on the node and committed there; the bundle never planted
      // here, so the card holds the node's commit and no delivery branch.
      git(clone, "fetch", "-q", "origin", "topics/round1:topics/round1");
      git(clone, "switch", "-q", "topics/round1");
      const nodeCommit = commit(clone, "accepted.txt", "yes\n", "round 2 on the node");

      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: "topics/round1" }, nodeCommit);

      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("delivery-absent");
      expect(landFallout(res.code, { deliveryCommit: nodeCommit }).status).toBe("review");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "rejected.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("node round that failed to plant and sent no commit: refused, with a prior branch or with none", async () => {
    const { root, repo } = remoteCardRepo();
    try {
      git(repo, "switch", "-q", "-c", "topics/round1");
      commit(repo, "rejected.txt", "no\n", "the rejected round");
      git(repo, "push", "-q", "origin", "topics/round1");
      git(repo, "switch", "-q", "main");

      for (const priorBranch of ["topics/round1", null]) {
        const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch }, UNPLANTED_DELIVERY_COMMIT);
        expect(res.status).toBe("skipped");
        if (res.status !== "skipped") return;
        expect(res.code).toBe("delivery-absent");
        expect(landFallout(res.code, { deliveryCommit: UNPLANTED_DELIVERY_COMMIT }).status).toBe("review");
      }
      expect(existsSync(join(repo, "rejected.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("delivered branch differing from the live one is fetched from origin too", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(repo, "branch", "topics/live");
      git(clone, "switch", "-q", "-c", "topics/delivered");
      commit(clone, "delivered.txt", "d\n", "delivered work");
      git(clone, "push", "-q", "origin", "topics/delivered");

      const res = await createTaskAutoMerge({
        resolveTaskMerge: () => ({ repoPath: repo, branch: "topics/live", defaultBranch: "main" }),
      }).tryMerge("t8", "card", { branch: "topics/delivered", commit: null });

      expect(res.status).toBe("merged");
      git(repo, "switch", "-q", "main");
      expect(existsSync(join(repo, "delivered.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("remote card, branch nowhere: refused, the card leaves Done", async () => {
    const { root, repo } = remoteCardRepo();
    try {
      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: "topics/lost-branch" });

      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("branch-missing");
      // The remote run left both delivery columns empty: the prior branch alone refuses.
      expect(landFallout(res.code, { deliveryCommit: null, priorBranch: "topics/lost-branch" }).status).toBe("review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("no branch ever existed: still no-branch", async () => {
    const { root, repo } = remoteCardRepo();
    try {
      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: null });
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("no-branch");
      expect(landFallout(res.code, { deliveryCommit: null, priorBranch: null }).status).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * 13/11, card 06bf57c1: a node round started from the branch of the round
   * before (still a local branch here), with "Riporta origin/main" merges in
   * between. The earlier commits looked foreign, the land picked the later
   * ones alone and reported a conflict a plain merge did not have.
   */
  test("node branch with interleaved realign merges, built on the prior round: it lands on main", async () => {
    const { root, repo, clone } = remoteCardRepo();
    try {
      git(repo, "switch", "-q", "-c", "topics/round1");
      commit(repo, "shared.txt", "round1\n", "first round of the card");
      git(repo, "push", "-q", "origin", "topics/round1");
      git(repo, "switch", "-q", "main");

      git(clone, "fetch", "-q", "origin");
      git(clone, "switch", "-q", "-c", "topics/silent-plateau", "origin/topics/round1");
      commit(repo, "other.txt", "x\n", "main moves on");
      git(repo, "push", "-q", "origin", "main");
      git(clone, "fetch", "-q", "origin");
      git(clone, "merge", "-q", "--no-edit", "-m", "Riporta origin/main nel ramo prima del land", "origin/main");
      commit(clone, "shared.txt", "node\n", "node round reworks the first round");
      commit(repo, "more.txt", "y\n", "main moves again");
      git(repo, "push", "-q", "origin", "main");
      git(clone, "fetch", "-q", "origin");
      git(clone, "merge", "-q", "--no-edit", "-m", "Riporta origin/main nel ramo prima del land", "origin/main");
      const tip = commit(clone, "node.txt", "node\n", "node round finishes");
      git(clone, "push", "-q", "origin", "topics/silent-plateau");

      const res = await landRemoteCard(repo, { deliveryBranch: "topics/silent-plateau", priorBranch: "topics/round1" }, tip);

      expect(res.status).toBe("merged");
      git(repo, "switch", "-q", "main");
      expect(readFileSync(join(repo, "shared.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("node\n");
      expect(existsSync(join(repo, "node.txt"))).toBe(true);
      expect(git(repo, "merge-base", "--is-ancestor", tip, "main")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /** 13/11, card 06bf57c1: "nothing to land" was said about a commit main did not have. */
  test("nothing to bring over while the delivered commit is not on main: refused, never accepted", async () => {
    const { root, repo } = remoteCardRepo();
    try {
      // The declared branch has nothing ahead of main, the delivered commit lives elsewhere.
      git(repo, "branch", "topics/rebuilt", "main");
      git(repo, "switch", "-q", "-c", "topics/elsewhere");
      const delivered = commit(repo, "rebuilt.txt", "one commit\n", "the card rebuilt as one commit");
      git(repo, "switch", "-q", "main");

      for (const task of [
        { deliveryBranch: "topics/rebuilt", priorBranch: null },
        { deliveryBranch: null, priorBranch: null },
      ]) {
        const res = await landRemoteCard(repo, task, delivered);
        expect(res.status).toBe("skipped");
        if (res.status !== "skipped") return;
        expect(res.code).toBe("not-on-main");
        expect(landFallout(res.code, { deliveryCommit: delivered }).status).toBe("review");
      }
      expect(existsSync(join(repo, "rebuilt.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("no branch and the delivered commit already on main: still no-branch", async () => {
    const { root, repo } = remoteCardRepo();
    try {
      const onMain = git(repo, "rev-parse", "main");
      const res = await landRemoteCard(repo, { deliveryBranch: null, priorBranch: null }, onMain);
      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).toBe("no-branch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("agente rilasciato e ramo davvero potato: fallisce con un codice che TOGLIE la card da Done", async () => {
    const { repo } = repoConDueRami();
    try {
      const am = createTaskAutoMerge({
        resolveTaskMerge: () => null,
        declaredDelivery: () => ({ repoPath: repo, branch: "topics/mai-esistito" }),
      });
      const res = await am.tryMerge("t6", "consegna irrecuperabile", { branch: "topics/mai-esistito", commit: null });

      expect(res.status).toBe("skipped");
      if (res.status !== "skipped") return;
      expect(res.code).not.toBe("no-branch");
      expect(landFallout(res.code).status).toBe("review");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("server.ts wires the land through declaredDeliveryFor and nothing of its own", () => {
  // The wiring is the one place a regression hid: the logic can be right in
  // `declaredDeliveryFor` while server.ts goes back to reading `deliveryBranch`
  // alone (12/11). server.ts cannot be imported in a test, so the test reads it.
  const source = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
  const at = source.indexOf("createTaskAutoMerge({");
  const block = source.slice(at, source.indexOf("log: (msg, err) => console.error", at))
    .split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");

  test("declaredDelivery is declaredDeliveryFor(...)", () => {
    expect(at).toBeGreaterThan(0);
    expect(block).toMatch(/declaredDelivery:\s*declaredDeliveryFor\(/);
  });

  test("the block reads no branch column itself", () => {
    expect(block).not.toContain("deliveryBranch");
    expect(block).not.toContain("priorBranch");
  });
});
