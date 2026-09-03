/**
 * WorktreeManager — git operations for the Worktree entity (migration 017).
 *
 * Wraps the system `git` binary via `Bun.spawn` (consistent with
 * `server/git-watcher.ts:14-49` and the ~25-endpoint git surface in
 * `routes/files.ts`). Adopting `simple-git` would only swap one wrapper
 * for another that calls the same binary, so we stay native.
 *
 * State machine for `worktrees.status`:
 *
 *      ┌──────── retry ────────┐
 *      │                       │
 *      ▼                       │
 *   pending ── git success ──→ ready
 *      │
 *      └─ git failure ─→ error  (errorMessage stored, row preserved)
 *
 * The row is created upfront in `pending` so the renderer can render a
 * loader as soon as the create endpoint returns — the actual `git
 * worktree add` may take seconds on large repos. When the disk operation
 * completes, the manager flips status and broadcasts `worktree:updated`.
 *
 * Concurrency: per-project async queue. Two concurrent creates on the
 * SAME project run sequentially (git can deadlock under rare races).
 * Different projects run in parallel.
 *
 * Refusal: if the source project's path is itself a worktree (its `.git`
 * is a *file* pointing at the parent's `.git/` directory), creation is
 * rejected with a clear error. We refuse to chain worktrees.
 */

import type { AppContext } from "../types";
import type { Worktree } from "../types";
import type { WorktreeStore } from "./worktree-store";
import type { ProjectStore } from "./project-store";
import {
  generateWorktreeName,
  isValidWorktreeName,
} from "../utils/worktree-naming";
import { makeSerialQueue } from "../lib/serial-queue";
import { provisionTauriSidecars } from "./worktree-sidecars";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { topicsHome } from "./daemon-state";
import { join, resolve } from "node:path";
import type { OwnedScript } from "../lib/ghost-script";
import type { NotificationRecordInput } from "../../shared/notification-log";

export class WorktreeRefusalError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorktreeRefusalError";
  }
}

export class WorktreeOperationError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = "",
    public readonly code: number | null = null,
  ) {
    super(message);
    this.name = "WorktreeOperationError";
  }
}

export interface CreateWorktreeInput {
  projectId: string;
  /** Optional override; auto-generated when omitted. */
  name?: string;
  mode: "branch" | "reuse" | "detached";
  /**
   * For mode `branch`: the ref to fork from (e.g. `main`).
   * For mode `reuse`:  the existing branch to attach to.
   * For mode `detached`: the ref to detach at.
   */
  baseRef: string;
}

export interface DeleteWorktreeOptions {
  /**
   * Default behavior: delete branch only when mode === 'branch'. Set this to
   * `false` to keep the branch even on `branch`-mode worktrees, or `true` to
   * force-delete a `reuse`-mode worktree's branch (rarely useful).
   */
  deleteBranch?: boolean;
}

export interface WorktreeManager {
  /**
   * Synchronously inserts a `pending` row, schedules the git operation,
   * and returns the row. The caller broadcasts `worktree:new` immediately;
   * a follow-up `worktree:updated` fires when the row flips to `ready` or
   * `error`. The promise side of the materialise is exposed via
   * `awaitMaterialisation(id)` for tests.
   */
  create(input: CreateWorktreeInput): Promise<Worktree>;
  delete(id: string, opts?: DeleteWorktreeOptions): Promise<boolean>;
  /** Resolves once the `pending` row of `id` has reached a terminal status. */
  awaitMaterialisation(id: string, timeoutMs?: number): Promise<Worktree>;
  /**
   * True while THIS process is still building `id` on disk (the closure queued
   * by `create` has not settled). A `pending` row that nobody is
   * building is a leftover of a restart mid-`git worktree add`, or of a
   * status update the DB swallowed: the GC repairs or collects those, and
   * this is how it tells them apart from a row honestly waiting its turn in
   * the per-project queue (which can take minutes behind other installs).
   */
  isMaterialising(id: string): boolean;
  /** The currently-configured worktrees-base directory. */
  worktreesDir(): string;
}

/** Dipendenze opzionali iniettate: INIETTARE, non importare. */
export interface WorktreeManagerGcDeps {
  /**
   * Uccide l'albero di un processo: pid + graceMs.
   * Iniettato da processes.ts per evitare un secondo scrittore di stato.
   */
  killTree?: (pid: number, graceMs?: number) => Promise<void>;
  /**
   * Restituisce la lista degli script avviati da Topics (source:"script") con
   * pid e projectPath. Usata per individuare i processi con cwd nella worktree
   * che si sta per cancellare.
   */
  listOwnedScripts?: () => OwnedScript[];
  /**
   * Writes a row in the notification log (and lights the bell on every open
   * window). Used for the one failure the delete cannot fix on its own: a folder
   * that survives both `git worktree remove` and our own `rm`. Absent in
   * tests; the error log line is written regardless.
   */
  notify?: (input: NotificationRecordInput) => void;
}

/**
 * How many times, and how far apart, the delete retries removing a folder that
 * `git worktree remove` gave up on. The typical cause is a process still
 * writing in the tree during the removal: a second attempt half a second
 * later usually finds it gone.
 */
const RM_ATTEMPTS = 3;
const RM_RETRY_MS = 500;

/**
 * LA RADICE DEI WORKTREE — e perché non è `homedir()`.
 *
 * Era `join(homedir(), ".topics", "worktrees")`, cablata. Ma `TOPICS_HOME`
 * esiste apposta perché un server possa avere una casa TUTTA SUA: lo usano il
 * server di test (`scripts/start-test-server.sh`, «dedicated TOPICS_HOME so the
 * test server doesn't…») e l'isolamento di un server avviato per sbaglio da una
 * worktree di dispatch.
 *
 * Con la radice cablata quell'isolamento era vero a metà: il database andava
 * dove doveva, i WORKTREE no. Misurato il 19/08/2026 nella casa vera:
 * **55 cartelle** appartenenti a progetti `e2e-naming-…`, `e2e-rename-…`,
 * `e2e-archive-…` — cioè checkout fabbricati da una suite di test che si
 * credeva confinata, mai puliti da nessuno perché nessun registro li
 * conosceva.
 *
 * Derivarla da `topicsHome()` rende l'isolamento una PROPRIETÀ invece che una
 * cosa da ricordarsi due volte. `TOPICS_WORKTREES_DIR` resta, ed è l'override
 * esplicito per chi vuole staccare solo questa.
 */
export function worktreeRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOPICS_WORKTREES_DIR || join(topicsHome(env), "worktrees");
}

export function createWorktreeManager(
  ctx: AppContext,
  deps: {
    projectStore: ProjectStore;
    worktreeStore: WorktreeStore;
  },
  gcDeps: WorktreeManagerGcDeps = {},
): WorktreeManager {
  const worktreesDir = worktreeRootDir();

  // Ensure base dir exists lazily — first create() touches the disk.
  function ensureDirSync(p: string) {
    mkdirSync(p, { recursive: true });
  }

  /**
   * PUNTO 1 (task e3240a22): spegni PRIMA i processi Topics dentro la worktree,
   * poi rimuovi la cartella.
   *
   * Cerca i processi source:"script" il cui projectPath sta dentro `wtPath`.
   * Per ogni processo trovato, chiama killTree con identita' (pid+lstart) gia'
   * verificata al momento dello spawn (il campo pidLstart nella registrazione).
   *
   * Se TOPICS_GHOST_REAP != "1", logga ma non uccide (modalita' solo-log).
   *
   * TRAPPOLA DI CODA: `del()` gira dentro `chainOnProjectQueue`. Non aspettare
   * incondizionatamente 5s per ognuno: aspetta al massimo 2s SOLO se abbiamo
   * davvero segnalato qualcuno, altrimenti niente attesa.
   */
  async function evictOwnedScripts(wtPath: string): Promise<void> {
    if (!gcDeps.listOwnedScripts) return;
    // Letto alla chiamata, non alla costruzione: permette di variare l'env
    // in test (e di passare da solo-log ad armato senza riavviare il server).
    const armed = process.env.TOPICS_GHOST_REAP === "1";
    const base = wtPath.endsWith("/") ? wtPath : wtPath + "/";
    const owned = gcDeps.listOwnedScripts().filter(s => {
      if (s.source !== "script" || s.status !== "running" || !s.pid) return false;
      const p = s.projectPath;
      return p === wtPath || p.startsWith(base);
    });
    if (owned.length === 0) return;

    for (const sp of owned) {
      const pid = sp.pid!;
      console.log(
        `[ghost-reap] pid=${pid} port=? cwd sparito (${sp.projectPath}) — ` +
        (armed ? "KILLING" : "only log (imposta TOPICS_GHOST_REAP=1 per armare)"),
      );
      if (armed && gcDeps.killTree) {
        try {
          await gcDeps.killTree(pid, 2000);
        } catch (err) {
          console.warn(`[ghost-reap] killTree(${pid}) fallito:`, err);
        }
      }
    }

    // Aspetta la sparizione dei listener SOLO se abbiamo segnalato qualcuno,
    // e con cap 2s per non bloccare la coda del progetto.
    if (armed && owned.length > 0) {
      await new Promise<void>(res => setTimeout(res, 2000));
    }
  }

  /** Ids whose materialise closure is queued or running in this process. */
  const buildInFlight = new Set<string>();

  // Per-project async serialization (task e33820da: shared safe helper).
  const projectQueue = makeSerialQueue();
  function chainOnProjectQueue<T>(
    projectId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return projectQueue.enqueue(projectId, fn);
  }

  /**
   * Run `git ...` in `cwd`. Returns stdout on success, throws
   * WorktreeOperationError on non-zero exit.
   */
  async function runGit(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new WorktreeOperationError(
        `git ${args[0] || "?"} failed (exit ${exitCode})`,
        stderr.trim(),
        exitCode,
      );
    }
    return { stdout, stderr };
  }

  /**
   * Refuse to create a worktree from inside another worktree. Detect by
   * inspecting the resolved `.git` path: a real repo has `<root>/.git/` as
   * a directory; a worktree has `<root>/.git` as a file pointing at the
   * parent repo's `.git/worktrees/<name>/` directory.
   */
  function assertNotAlreadyAWorktree(projectPath: string) {
    const dotGit = join(projectPath, ".git");
    if (!existsSync(dotGit)) {
      throw new WorktreeRefusalError(
        `Project path is not a git repository: ${projectPath}`,
      );
    }
    const st = statSync(dotGit);
    if (st.isFile()) {
      throw new WorktreeRefusalError(
        `Cannot create worktrees from inside an existing worktree (${projectPath}). Pick the original repository instead.`,
      );
    }
  }

  function pickName(projectId: string, requested: string | undefined): string {
    if (requested !== undefined) {
      if (!isValidWorktreeName(requested)) {
        throw new WorktreeRefusalError(
          `Invalid worktree name: must match /^[a-z][a-z0-9-]{0,63}$/`,
        );
      }
      return requested;
    }
    const existing = deps.worktreeStore.listNamesForProject(projectId);
    return generateWorktreeName(existing);
  }

  async function create(input: CreateWorktreeInput): Promise<Worktree> {
    const project = deps.projectStore.get(input.projectId);
    if (!project) {
      throw new WorktreeRefusalError(`Project not found: ${input.projectId}`);
    }
    assertNotAlreadyAWorktree(project.path);

    const name = pickName(input.projectId, input.name);
    const targetDir = join(worktreesDir, project.slug);
    ensureDirSync(targetDir);
    const absPath = join(targetDir, name);

    if (existsSync(absPath)) {
      throw new WorktreeRefusalError(
        `Target path already exists on disk: ${absPath}`,
      );
    }

    // Decide the branchName to record on the row up-front.
    // - branch:   we will create `topics/<name>` (or use the user-given ref-name idiom)
    // - reuse:    branchName === baseRef
    // - detached: branchName is null
    let branchName: string | null;
    if (input.mode === "branch") {
      branchName = `topics/${name}`;
    } else if (input.mode === "reuse") {
      branchName = input.baseRef;
    } else {
      branchName = null;
    }

    // Insert the row in `pending` BEFORE running git so the WS broadcast
    // can race ahead and the UI gets a loader.
    const row = deps.worktreeStore.create({
      projectId: input.projectId,
      name,
      branchName,
      baseRef: input.mode === "detached" ? null : input.baseRef,
      mode: input.mode,
      absPath,
    });

    // Caller broadcasts `worktree:new` with `row` immediately.
    // Materialise asynchronously, serialised per project.
    buildInFlight.add(row.id);
    chainOnProjectQueue(input.projectId, async () => {
      try {
        await materialiseOnDisk(project.path, absPath, branchName, input);
        // Wrap the DB write: when this async runs AFTER `closeDatabase()`
        // (e.g. a peer test in the same process has torn down the
        // singleton between scheduling and execution), the prepared
        // statement throws SQLITE_NOMEM. We don't want to crash the
        // entire process for a best-effort status update on a worktree
        // that's already going stale anyway.
        try {
          const updated = deps.worktreeStore.update(row.id, { status: "ready" });
          if (updated) ctx.broadcastToAll({ type: "worktree:updated", worktree: updated, payload_version: 1 });
        } catch (dbErr) {
          console.warn(`[WorktreeManager] post-materialise update skipped (DB unavailable):`, dbErr);
        }
      } catch (err: any) {
        const stderr = err?.stderr || String(err?.message || err);
        // Same guard as above — recording the failure shouldn't crash the
        // outer process if the DB is gone.
        try {
          const updated = deps.worktreeStore.update(row.id, {
            status: "error",
            errorMessage: stderr.slice(0, 4000),
          });
          if (updated) ctx.broadcastToAll({ type: "worktree:updated", worktree: updated, payload_version: 1 });
        } catch (dbErr) {
          console.warn(`[WorktreeManager] error-status update skipped (DB unavailable):`, dbErr);
        }
        console.error(
          `[WorktreeManager] create failed { project_slug: ${project.slug}, worktree_name: ${name} }`,
          err,
        );
      } finally {
        buildInFlight.delete(row.id);
      }
    });

    return row;
  }

  async function materialiseOnDisk(
    projectPath: string,
    absPath: string,
    branchName: string | null,
    input: CreateWorktreeInput,
  ): Promise<void> {
    const start = Date.now();
    if (input.mode === "branch") {
      // git worktree add -b topics/<name> <abs_path> <base_ref>
      await runGit(projectPath, [
        "worktree",
        "add",
        "-b",
        branchName!,
        absPath,
        input.baseRef,
      ]);
    } else if (input.mode === "reuse") {
      // git worktree add <abs_path> <existing_branch>
      await runGit(projectPath, ["worktree", "add", absPath, input.baseRef]);
    } else {
      // detached
      await runGit(projectPath, ["worktree", "add", "--detach", absPath, input.baseRef]);
    }
    const ms = Date.now() - start;
    console.log(
      `[WorktreeManager] created { project: ${projectPath}, worktree: ${absPath}, mode: ${input.mode}, base_ref: ${input.baseRef}, ms: ${ms} }`,
    );
    await installDeps(absPath);
    await provisionSidecars(projectPath, absPath);
  }

  /**
   * THE TAURI SIDECARS, or the Rust crate cannot be compiled here.
   *
   * Same shape of fault as `installDeps`, on another gate: `git worktree add`
   * materialises TRACKED files, and `desktop-tauri/src-tauri/binaries/` is a
   * build artifact, so a fresh worktree cannot even run `cargo check` (tauri
   * refuses on the missing resource path before compiling a line). An agent
   * delivering Rust from here has no way to prove it builds, and no way to
   * notice it broke the build: the whole risk lands on Windows CI, a round
   * later. See `worktree-sidecars.ts` for why this clones instead of linking.
   *
   * Best effort, like the install: no sidecars in the main checkout is the
   * normal state of a fresh clone, not a reason to refuse a worktree.
   */
  async function provisionSidecars(projectPath: string, absPath: string): Promise<void> {
    const res = await provisionTauriSidecars(projectPath, absPath);
    const line = `[WorktreeManager] tauri sidecars { worktree: ${absPath}, status: ${res.status}, ms: ${res.ms} }`;
    if (res.status === "failed") console.warn(`${line} ${res.reason ?? ""}`);
    else console.log(line);
  }

  /**
   * LE DIPENDENZE DEL CLIENT, SUBITO — e costano meno di quanto sembrano.
   *
   * `git worktree add` copia i file TRACCIATI, e `client/node_modules` non lo e':
   * un worktree nasce senza. Li' `eslint` e `tsc` non partono, quindi due dei
   * cinque cancelli di review NON MISURANO NIENTE. Misurato il 18/08 prima di
   * questa riga: 95 worktree su 103 erano cosi', cioe' quasi ogni card
   * dispacciata veniva giudicata su meta' della barra.
   *
   * ── Perche' installare e non collegare ──────────────────────────────────
   * Un symlink a `client/node_modules` del checkout principale sembra gratis, ma
   * ha un bordo affilato: un `bun install` dentro il worktree scriverebbe nelle
   * dipendenze del checkout VERO, e un ramo che cambia `client/package.json`
   * userebbe quelle di main — cioe' le sbagliate, in silenzio. Un rosso
   * plausibile e' peggio di uno palese.
   *
   * ── E il costo non e' quello che dice `du` ──────────────────────────────
   * `du` riporta 357-409 MB e su 95 worktree farebbe ~38 GB: e' la stima che mi
   * aveva fatto scartare questa strada, ed era SBAGLIATA. Misurato con `df`
   * prima e dopo un'installazione vera in un worktree: **7 MB** e 0,8 secondi.
   * Bun clona dalla sua cache globale e APFS condivide i blocchi (clonefile),
   * quindi `du` conta la dimensione apparente di file che sul disco non
   * esistono due volte.
   *
   * ── Best-effort, sempre ─────────────────────────────────────────────────
   * Un `bun install` che fallisce (rete giu', lockfile incoerente col ramo) non
   * deve impedire la nascita del worktree: l'agente puo' lavorare lo stesso, e i
   * cancelli che non partono adesso lo DICONO invece di andare rossi (uscita 97,
   * vedi `scripts/check-client-deps.ts`). Il silenzio qui e' un degrado onesto.
   */
  async function installDeps(absPath: string): Promise<void> {
    // DUE INSTALLAZIONI, non una. La radice porta `bun-types`: senza, il
    // typecheck del server muore su «Cannot find type definition file for
    // 'bun'» — che e' un errore vero solo in apparenza, misurato su
    // `soaring-cypress`: con le dipendenze di radice quel ramo fa 0 errori.
    // `client/` porta eslint e tsc. Ne manca una, e mezza barra tace.
    const started = Date.now();
    let ok = 0;
    for (const dir of [absPath, join(absPath, "client")]) {
      if (!existsSync(join(dir, "package.json"))) continue;
      try {
        const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
          cwd: dir, stdout: "pipe", stderr: "pipe",
        });
        if ((await proc.exited) === 0) ok += 1;
        else console.warn(`[WorktreeManager] deps NON installate in ${dir}`);
      } catch (err) {
        console.warn(`[WorktreeManager] deps NON installate in ${dir}: ${String(err)}`);
      }
    }
    console.log(
      `[WorktreeManager] deps installed { worktree: ${absPath}, ok: ${ok}/2, ms: ${Date.now() - started} }`,
    );
  }

  /**
   * THE FOLDER GOES BEFORE THE ROW, or the row goes and the folder stays
   * forever.
   *
   * `git worktree remove --force` fails for ordinary reasons: a process still
   * writing in the tree, or a registration git has already lost (`.git` in
   * the folder points at a `.git/worktrees/<name>` that no longer exists, and
   * git answers "is not a working tree"). Until 2026-09-03 the failure was a
   * `console.warn` and the row was deleted anyway. The row is the ONLY handle
   * the GC has on a folder: once it is gone, a copy of the repo weighing
   * hundreds of MB is invisible to every sweep, and the human finds out from
   * a full disk (measured: `sage-well`, 137 MB, task closed and landed).
   *
   * So: on failure we prune (idempotent) and remove the folder ourselves,
   * with a short retry. The decision to destroy was already taken by the
   * caller and `evictOwnedScripts` has already run. If the folder still
   * stands after that, we throw: the row and the branch stay, the error is
   * logged and notified, and the next sweep tries again. Returning `false`
   * here would read as "not found" to the route.
   */
  async function removeFolderOurselves(projectPath: string, absPath: string, cause: string): Promise<void> {
    try {
      await runGit(projectPath, ["worktree", "prune"]);
    } catch (err) {
      const why = err instanceof WorktreeOperationError ? err.stderr || err.message : String(err);
      console.warn(`[WorktreeManager] git worktree prune failed for ${projectPath}:`, why);
    }
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= RM_ATTEMPTS; attempt++) {
      try {
        await rm(absPath, { recursive: true, force: true });
      } catch (err) {
        lastErr = err;
      }
      if (!existsSync(absPath)) {
        console.log(`[WorktreeManager] folder removed by hand after git refused (attempt ${attempt}): ${absPath}`);
        return;
      }
      if (attempt < RM_ATTEMPTS) await new Promise((r) => setTimeout(r, RM_RETRY_MS));
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "folder still present");
    console.error(
      `[WorktreeManager] cannot remove worktree folder ${absPath} (git: ${cause}; rm: ${detail}), row kept so the GC retries`,
    );
    try {
      gcDeps.notify?.({
        kind: "other",
        title: "Cartella di worktree non rimovibile",
        body: `${absPath}: git ha rifiutato (${cause}) e la rimozione diretta e' fallita (${detail}). La riga resta, il GC riprova.`,
        dedupeKey: `worktree-rm-failed:${absPath}`,
      });
    } catch (err) {
      console.warn("[WorktreeManager] notify failed:", err);
    }
    throw new WorktreeOperationError(`worktree folder could not be removed: ${absPath}`, detail, null);
  }

  async function del(
    id: string,
    opts: DeleteWorktreeOptions = {},
  ): Promise<boolean> {
    const wt = deps.worktreeStore.get(id);
    if (!wt) return false;
    const project = deps.projectStore.get(wt.projectId);
    // Even if project is gone (defensive), proceed with row delete.
    return chainOnProjectQueue(wt.projectId, async () => {
      // Best-effort: remove from disk, then the branch if we own it.
      if (project && existsSync(wt.absPath)) {
        // PUNTO 1: spegni i processi Topics dentro la worktree PRIMA di rimuoverla.
        await evictOwnedScripts(wt.absPath);
        try {
          await runGit(project.path, ["worktree", "remove", wt.absPath, "--force"]);
        } catch (err: any) {
          const cause = String(err?.stderr || err?.message || err).trim();
          console.warn(`[WorktreeManager] git worktree remove failed for ${wt.absPath}:`, cause);
          // Throws when the folder survives: row and branch stay, see above.
          await removeFolderOurselves(project.path, wt.absPath, cause);
        }
      } else if (project) {
        // Directory already gone (user deleted it by hand). Git still holds
        // the worktree registration in .git/worktrees/<name>, and while it
        // does, `git branch -D` below refuses ("branch is used by worktree")
        // — the branch + metadata would leak permanently and a same-name
        // re-create would fail with a cryptic git error. Prune first.
        try {
          await runGit(project.path, ["worktree", "prune"]);
        } catch (err: any) {
          console.warn(
            `[WorktreeManager] git worktree prune failed for ${project.path}:`,
            err?.stderr || err?.message,
          );
        }
      }
      const shouldDeleteBranch =
        opts.deleteBranch !== undefined
          ? opts.deleteBranch
          : wt.mode === "branch";
      if (shouldDeleteBranch && project && wt.branchName) {
        // THE LINE THAT MADE 213 DELIVERIES UNREACHABLE, and it stays. The land
        // is a squash, so nothing on `main` descends from this branch: deleting
        // it leaves the agent's commit reachable from no ref at all, and the
        // next gc is right to collect it. What was missing was not a reason to
        // keep the branch (a branch drags a whole worktree behind it) but a ref
        // of 41 bytes, planted when the delivery is RECORDED:
        // `services/delivery-ref-keep.ts`, LAND-09.
        try {
          await runGit(project.path, ["branch", "-D", wt.branchName]);
        } catch (err: any) {
          // Branch may already be gone (e.g. user deleted it manually).
          console.warn(
            `[WorktreeManager] git branch -D ${wt.branchName} failed:`,
            err?.stderr || err?.message,
          );
        }
      }
      const removed = deps.worktreeStore.delete(id);
      // Caller is responsible for the WS broadcast.
      return removed;
    });
  }

  async function awaitMaterialisation(
    id: string,
    timeoutMs = 10_000,
  ): Promise<Worktree> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const wt = deps.worktreeStore.get(id);
      if (!wt) throw new Error(`Worktree ${id} not found`);
      if (wt.status !== "pending") return wt;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Worktree ${id} did not materialise within ${timeoutMs}ms`);
  }

  return {
    create,
    delete: del,
    awaitMaterialisation,
    isMaterialising: (id) => buildInFlight.has(id),
    worktreesDir: () => resolve(worktreesDir),
  };
}
