/**
 * Test di integrazione per il Punto 1 (task e3240a22):
 * "worktree finta, sleep 600 registrato come script, rimozione via manager,
 *  il pid e' morto e NESSUN altro pid della macchina e' stato toccato."
 *
 * Verifica che `evictOwnedScripts` uccida i processi Topics con cwd nella
 * worktree prima che il git worktree remove giri, e che NON tocchi nessun
 * altro pid della macchina.
 *
 * Usa un repo git vero (mkdtemp) per soddisfare le aspettative di
 * WorktreeManager, e registra manualmente un processo `sleep 600` come
 * source:"script" nel registro di processes.ts prima di chiamare delete().
  * @covers PROCESS-11
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktreeManager, type WorktreeManagerGcDeps } from "../../server/services/worktree-manager";

// Raccogli i pid dei processi che spawn-iamo per pulizia
const spawned: Array<{ pid: number; kill: () => void }> = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* gia' uscito */ }
  }
});

/** Crea un repo git di prova e restituisce il path. */
async function makeGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "test@test.test"]);
  await run(["config", "user.name", "Test"]);
  // Commit iniziale richiesto da worktree add
  fs.writeFileSync(path.join(dir, "README.md"), "test");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}

/** Restituisce true se il pid e' ancora vivo. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

describe("evictOwnedScripts — Punto 1", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-evict-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test("un sleep registrato come script viene ucciso prima del git worktree remove", async () => {
    const repoDir = path.join(tmpRoot, "repo");
    const wtBase = path.join(tmpRoot, "worktrees");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(wtBase, { recursive: true });
    await makeGitRepo(repoDir);

    // Crea la worktree via git direttamente (bypassa il manager per semplicita')
    const wtName = "test-wt";
    const wtPath = path.join(wtBase, "myproject", wtName);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const addProc = Bun.spawn(
      ["git", "worktree", "add", "-b", `topics/${wtName}`, wtPath, "main"],
      { cwd: repoDir, stdout: "ignore", stderr: "ignore" },
    );
    await addProc.exited;

    // Spawn un processo con cwd nella worktree (simula un dev server)
    const sleepProc = Bun.spawn(["sleep", "600"], {
      cwd: wtPath,
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    const ghostPid = sleepProc.pid;
    spawned.push({ pid: ghostPid, kill: () => { try { process.kill(ghostPid, "SIGKILL"); } catch { } } });

    // Aspetta che il processo si sia avviato
    await Bun.sleep(100);
    expect(isAlive(ghostPid)).toBe(true);

    // Lista degli script "posseduti" da Topics — simuliamo il registro
    const ownedScripts: Array<{
      processId: string;
      pid: number | null;
      pidLstart?: string;
      projectPath: string;
      source?: "script" | "detected" | "shell";
      status: string;
    }> = [
      {
        processId: "proc-1",
        pid: ghostPid,
        projectPath: wtPath,
        source: "script",
        status: "running",
      },
    ];

    const killedPids: number[] = [];
    const gcDeps: WorktreeManagerGcDeps = {
      killTree: async (pid, _graceMs) => {
        killedPids.push(pid);
        process.kill(pid, "SIGTERM");
        await Bun.sleep(50);
        try { process.kill(pid, "SIGKILL"); } catch { }
      },
      listOwnedScripts: () => ownedScripts,
    };

    // Stub per projectStore e worktreeStore
    const fakeWt = {
      id: "wt-1",
      projectId: "proj-1",
      absPath: wtPath,
      branchName: `topics/${wtName}`,
      mode: "branch" as const,
      name: wtName,
      status: "ready" as const,
      baseRef: "main",
      createdAt: new Date().toISOString(),
      errorMessage: null,
    };

    const manager = createWorktreeManager(
      { broadcastToAll: () => { } } as any,
      {
        projectStore: {
          get: () => ({ path: repoDir, id: "proj-1", name: "myproject", slug: "myproject" }),
        } as any,
        worktreeStore: {
          get: () => fakeWt,
          delete: () => true,
          list: () => [],
          listNamesForProject: () => [],
          create: () => fakeWt,
          update: () => fakeWt,
        } as any,
      },
      gcDeps,
    );

    // Override TOPICS_WORKTREES_DIR per puntare al nostro dir di test
    const origEnv = process.env.TOPICS_WORKTREES_DIR;
    const origReap = process.env.TOPICS_GHOST_REAP;
    process.env.TOPICS_WORKTREES_DIR = wtBase;
    process.env.TOPICS_GHOST_REAP = "1";

    try {
      await manager.delete("wt-1");
    } finally {
      if (origEnv === undefined) delete process.env.TOPICS_WORKTREES_DIR;
      else process.env.TOPICS_WORKTREES_DIR = origEnv;
      if (origReap === undefined) delete process.env.TOPICS_GHOST_REAP;
      else process.env.TOPICS_GHOST_REAP = origReap;
    }

    // Il pid del nostro sleep deve essere stato ucciso
    expect(killedPids).toContain(ghostPid);

    // Aspetta che il processo muoia davvero
    await Bun.sleep(200);
    expect(isAlive(ghostPid)).toBe(false);

    // Nessun altro pid e' stato toccato (killedPids non contiene niente di estraneo)
    for (const p of killedPids) {
      expect(ownedScripts.map(s => s.pid)).toContain(p);
    }
  }, 15_000);

  test("senza script registrati: nessun pid toccato", async () => {
    const repoDir = path.join(tmpRoot, "repo2");
    const wtBase = path.join(tmpRoot, "worktrees2");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(wtBase, { recursive: true });
    await makeGitRepo(repoDir);

    const wtName = "empty-wt";
    const wtPath = path.join(wtBase, "myproject2", wtName);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const addProc = Bun.spawn(
      ["git", "worktree", "add", "-b", `topics/${wtName}`, wtPath, "main"],
      { cwd: repoDir, stdout: "ignore", stderr: "ignore" },
    );
    await addProc.exited;

    const killedPids: number[] = [];
    const gcDeps: WorktreeManagerGcDeps = {
      killTree: async (pid) => { killedPids.push(pid); },
      listOwnedScripts: () => [],   // nessuno script
    };

    const fakeWt = {
      id: "wt-2",
      projectId: "proj-2",
      absPath: wtPath,
      branchName: `topics/${wtName}`,
      mode: "branch" as const,
      name: wtName,
      status: "ready" as const,
      baseRef: "main",
      createdAt: new Date().toISOString(),
      errorMessage: null,
    };

    const manager = createWorktreeManager(
      { broadcastToAll: () => { } } as any,
      {
        projectStore: {
          get: () => ({ path: repoDir, id: "proj-2", name: "myproject2", slug: "myproject2" }),
        } as any,
        worktreeStore: {
          get: () => fakeWt,
          delete: () => true,
          list: () => [],
          listNamesForProject: () => [],
          create: () => fakeWt,
          update: () => fakeWt,
        } as any,
      },
      gcDeps,
    );

    const origEnv = process.env.TOPICS_WORKTREES_DIR;
    process.env.TOPICS_WORKTREES_DIR = wtBase;
    process.env.TOPICS_GHOST_REAP = "1";
    try {
      await manager.delete("wt-2");
    } finally {
      if (origEnv === undefined) delete process.env.TOPICS_WORKTREES_DIR;
      else process.env.TOPICS_WORKTREES_DIR = origEnv;
      delete process.env.TOPICS_GHOST_REAP;
    }

    // Nessun pid toccato
    expect(killedPids).toHaveLength(0);
  }, 10_000);
});
