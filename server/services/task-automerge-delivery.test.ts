/**
 * @covers LAND-03
 */
import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, landFallout } from "./task-automerge";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
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
