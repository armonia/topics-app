/**
 * LA POTATURA DEI WORKTREE, tolta da `server.ts`.
 *
 * Viveva in mezzo a quattromilacinquecento righe di altro, ed e' il sottosistema
 * che DISTRUGGE: un difetto qui non e' un pixel storto, e' la cartella di
 * qualcuno che sparisce. Un modulo suo vuol dire che il contratto di sicurezza
 * si legge tutto insieme invece che a pezzi fra una rotta e un timer.
 *
 * COSA NON CAMBIA, ed e' il punto di questa estrazione: le query, l'ordine
 * park-poi-rimuovi, i valori di default, i log. E' uno spostamento con le
 * dipendenze rese esplicite, non una riscrittura: le decisioni continuano a
 * stare in `worktree-gc.ts` (`sweepWorktrees`), questo file e' solo il
 * cablaggio verso il resto del server.
 *
 * PERCHE' UNA FABBRICA CON LE CLOSURE. In `server.ts` queste funzioni erano
 * `function` dichiarate in fondo, e i tre punti che le usano stanno piu' in
 * alto: si reggevano sull'hoisting. Una fabbrica costruita presto con dentro
 * closure che leggono `taskAutoMerge` al momento della CHIAMATA da' la stessa
 * proprieta' senza dipendere dall'ordine di valutazione, ed e' lo stesso schema
 * che il file usa gia' per `previewManager` (un `let` assegnato piu' tardi,
 * letto solo quando un turno arriva davvero in review).
 */
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Topic } from "../types";
import { sweepWorktrees, type TaskStatus as GcTaskStatus, type WorktreeGcDeps as SweepDeps, type WorktreeGcSummary } from "./worktree-gc";
import { worktreeDirtProbe } from "./task-automerge";
import { branchExistsInRepo, branchStatusFromRepo } from "./branch-status";
import { abandonNoticeFromRepo } from "./worktree-abandon-notice";
import { formatMb, parseSlimSkip, slimWorktree } from "./worktree-slim";
import { alreadyArchived, archiveBranchRef } from "./worktree-archive";
import { commitWorktreeResidue } from "./worktree-residue";
import { isTopicsSpawned } from "../lib/ghost-script";
import { anyInsideDir, isInsideDir } from "../lib/path-containment";
import { topicSessionKey } from "./agent-census";
import { taskIdleDays, transcriptMtime } from "./worktree-task-idle";
import { headHoldsCommitsOffBranch, headStatusOfCheckout } from "./worktree-head-status";

export { taskIdleDays };
import { defaultRunGit, type GitRunner } from "./own-commits";
import { resolveGcForeign, resolveWorktreeAbandonDays, resolveWorktreeMaxPerProject, resolveWorktreeQuarantineDays } from "./app-settings";
import { runRootPass, type RootPassDeps, type RootPassResult, type StoredWorktree } from "./worktree-gc-root-pass";
import { capPass, foreignPass, previewPass, type GcPlan, type GcRow, type GcSettings, type PassesCtx } from "./worktree-gc-passes";
import { MIN_REMOVAL_AGE_MS, canonicalPath } from "./worktree-root-gc";

export type { GcPlan, GcSettings };

/**
 * Tutto cio' che la potatura chiede al resto del server, dichiarato.
 *
 * Sono closure e non valori di proposito: alcune di queste cose (`previewList`,
 * l'anteprima) nascono DOPO il punto in cui la fabbrica viene costruita, e
 * leggerle alla chiamata e' esattamente cio' che l'hoisting garantiva prima.
 */
/** How long after a sub-agent ended its worktree is still kept (it can be resumed). */
const SUBAGENT_GRACE_MS = 24 * 3600_000;

export interface WorktreeGcDeps {
  db: Database;
  /**
   * The worktree store: the population to judge. `update` repairs a row left
   * in `pending` (see `collectPopulation`); without it those rows are judged
   * but not repaired.
   */
  worktreeStore: {
    list(filtro?: { status?: string }): StoredWorktree[];
    update?(id: string, patch: { status: "ready" }): unknown;
    /** Present on the real store: the root pass registers an orphan folder with these. */
    create?(input: { projectId: string; name: string; branchName: string | null; baseRef: string | null; mode: "branch" | "reuse" | "detached"; absPath: string }): { id: string };
    listNamesForProject?(projectId: string): Set<string>;
  };
  /**
   * The manager: the one that really deletes a folder. `isMaterialising` says
   * whether a `pending` row is still in THIS process's hands: those are never
   * touched, however old (the per-project queue can legitimately hold one
   * behind other installs).
   */
  worktreeManager: { delete(id: string, opts?: any): Promise<any>; isMaterialising?(id: string): boolean; worktreesDir?(): string };
  /**
   * The roots that are Topics' own: the current one, then every one it used
   * before (the default, and past roots read off its rows). The server wiring
   * names them; this module never adds one of its own, so a caller that passes
   * a temp root scans that root and nothing else. Without it only
   * `worktreeManager.worktreesDir()` is Topics'.
   */
  roots?: () => { root: string; extraRoots: string[] } | null;
  /** A session Topics did not start (Claude Code, Codex, jcode from a terminal) is active at or under this folder. */
  externalActiveAt?: (absPath: string) => boolean;
  /** Il progetto di un worktree, per leggere lo stato del ramo dal checkout principale. */
  projectStore: { get(id: string): { path?: string } | null | undefined; list?(): Array<{ id: string; slug: string; path: string }> };
  /** Git, injectable for tests. Default: the bounded runner of `own-commits`. */
  git?: GitRunner;
  /** The GC settings, read at every pass. Default: the app settings (with the env fallbacks). */
  settings?: () => GcSettings;
  getTopicBySessionKey: (sessionKey: string) => Topic | null;
  resolveTopicCwd: (topic: Topic | null | undefined) => string | null;
  /**
   * The working directories of live terminal sessions, for the WORKTREE-14
   * guard. The binding between a session and a worktree is the PATH and nothing
   * else: no column, no migration, and a session that came back from
   * `terminal_sessions` after a restart counts like any other.
   */
  liveCwds?: () => string[];
  /** Path rules for the cwd comparisons (Windows separators and case); defaults to the running platform. */
  platform?: NodeJS.Platform;
  /**
   * Is the chat session addressed by this key mid-turn, or active within the
   * last few minutes? A chat topic bound to a worktree has no task and no
   * terminal cwd, so without this answer its worktree reads as an orphan and
   * is reaped under the agent (card dc31628c).
   */
  chatActive?: (sessionKey: string) => boolean;
  /** Il servizio task: card, impostazioni, park, commenti, consegna. */
  svc: any;
  /**
   * IL FILO VERSO I CLIENT, e la ragione per cui e' una dipendenza e non una
   * comodita'.
   *
   * Questa potatura scrive sulle card — le parcheggia `failed`, ci commenta
   * sopra, ci timbra il ramo di consegna — ma parte da un TIMER, non da una
   * rotta: dietro non c'e' nessuno che trasmetta l'esito. Senza questo, una
   * card parcheggiata dal giro delle 3 di notte continua a leggersi «in
   * lavorazione» su ogni schermo aperto fino al ricaricamento successivo, e
   * la board dice una cosa mentre il database ne dice un'altra.
   */
  broadcast: (msg: unknown) => void;
  /** Un turno dispatchato e' in volo su questo task: non si tocca niente. */
  isInFlight: (taskId: string) => boolean;
  /** Il worktree di un task, risolto dal server (task -> topic -> worktree). */
  worktreeOfTask: (taskId: string) => { id: string; absPath: string; projectId: string; name?: string; mode?: string; branchName?: string | null } | null;
  /** La consegna e' su main? Risposta per CONTENUTO, non per discendenza. */
  deliveryIsOnMain: (repoPath: string, commit: string) => Promise<boolean | null>;
  /** L'anteprima viva di un task, se c'e' (nasce dopo: closure). */
  previewList: () => { taskId: string }[];
  previewTeardown: (taskId: string) => Promise<void>;
  /**
   * PUNTO 3 (task e3240a22): lista degli script Topics (source:"script") in
   * esecuzione con il loro projectPath. Usata per rimandare lo slim quando
   * c'e' un processo vivo DENTRO la cartella che si vuole snellire.
   *
   * Closure deliberata (nasce dopo: lo stesso schema di previewList).
   */
  listOwnedScripts?: () => Array<{ processId: string; pid: number | null; projectPath: string; source?: string; status: string }>;
}

/** What a pass reports: the sweep's summary plus what the root pass and the cap did. */
export type GcRunSummary = WorktreeGcSummary & {
  root?: Omit<RootPassResult, "plan"> | null;
  foreignRemoved?: number;
  capped?: number;
};

export interface WorktreeGcRunner {
  runWorktreeGc: () => Promise<GcRunSummary | null>;
  /** The same pass as `runWorktreeGc`, read-only. `weigh` adds the on-disk size of each folder. */
  planWorktreeGc: (opts?: { weigh?: boolean }) => Promise<GcPlan | null>;
  /** A live session or a process of Topics has its working directory in this folder (by-hand relocation asks). */
  isBusyInside: (absPath: string) => boolean;
  /** A card that is not finished is bound to this worktree row (by-hand relocation asks). */
  isTaskActive: (worktreeId: string) => boolean;
  /** Frees room in a project over its worktree cap: slim, then reap the oldest the contract admits. */
  enforceCap: (projectId?: string) => Promise<number>;
  slimWorktreeOfTask: (taskId: string) => Promise<void>;
  /** Ogni quanto passa la scopa. Il timer resta in `server.ts`: e' avvio, non logica. */
  readonly intervalMs: number;
  /** Quanto si aspetta dopo il boot prima del primo giro. */
  readonly bootDelayMs: number;
}

export function createWorktreeGcRunner(deps: WorktreeGcDeps): WorktreeGcRunner {
  // ── Worktree GC — origin fix for worktree pile-up ──────────────────────────
  // Dispatch worktrees were only reaped on a successful approve→automerge; every
  // other terminal path (reject+abandon, delete, an approve the old dirty-main
  // bug skipped, an orphan) leaked one forever. This periodic sweep applies the
  // SAME safety contract to the whole population — reaping only when there is
  // provably nothing to lose. A closed task's unmerged-but-clean commits are
  // never landed here: they are pinned under an archive ref, then the checkout
  // is freed. See server/services/worktree-gc.ts.
  const WORKTREE_GC_INTERVAL_MS = 30 * 60_000;
  // The abandon TTL, the cap and the foreign mode are settings now (Settings >
  // Worktrees), read at every pass; the old env knob is still honoured by the
  // resolver when the setting is empty.
  const readSettings = (): GcSettings => {
    if (deps.settings) return deps.settings();
    return {
      abandonDays: resolveWorktreeAbandonDays(), gcForeign: resolveGcForeign(), maxPerProject: resolveWorktreeMaxPerProject(),
      quarantineDays: resolveWorktreeQuarantineDays(),
    };
  };
  const git: GitRunner = deps.git ?? defaultRunGit;
  const platform = deps.platform ?? process.platform;

  /**
   * La card com'e' ADESSO, a tutti i client aperti.
   *
   * `projectId` is read from the TASK, not from the worktree: `wt.projectId`
   * is the projectStore uuid, while the board filters by the BOARD id, which
   * is the one written on the card. With the former the frame would arrive and
   * be dropped by the client: exactly the silence this function exists to
   * remove, without even an error to say so.
   *
   * Best-effort come ogni altro effetto collaterale di questo giro: un filo
   * rotto non deve fermare una potatura.
   */
  function annuncia(taskId: string): void {
    try {
      const fresh = deps.svc.get(taskId)?.task;
      if (fresh) deps.broadcast({ type: "task:updated", projectId: fresh.projectId, task: fresh });
    } catch (err) {
      console.warn("[worktree-gc] annuncio della card fallito", err);
    }
  }

  const idleDaysOfTask = (taskId: string): number | null =>
    taskIdleDays(deps.db, taskId, (topicId) => transcriptMtime(deps, topicId));

  /**
   * A process Topics started (a script, a `run_command`) still runs in this
   * folder or below it. Asked by the GC pass and by the slim of a card that
   * reached review, which can get there with its command still running.
   */
  const topicsProcessRunsIn = (absPath: string): boolean => {
    if (!deps.listOwnedScripts) return false;
    return deps.listOwnedScripts().some((s) =>
      isTopicsSpawned(s.source) && s.status === "running" && !!s.pid
      && !!s.projectPath && isInsideDir(s.projectPath, absPath, platform));
  };

  /**
   * Un preview server non può sopravvivere alla cartella da cui serve: sia il
   * `reap` sia il `free-checkout` la portano via, quindi entrambi lo spengono
   * prima. Best-effort — un preview ostinato non deve impedire di liberare spazio.
   */
  /**
   * Drops the regenerable artifacts from a task's worktree, keeping the folder.
   *
   * Four conditions before touching anything, all of them «is somebody still in
   * there?»: the folder exists, no turn is running on the task, no live preview
   * is serving a `bun run dev` from it, and no process Topics started (a
   * script, a `run_command`) runs inside it. The safety of WHAT is deleted
   * lives entirely in `worktree-slim` (a closed list of names plus a double
   * gate read from git), not here.
   *
   * A live preview or process is a postponement, not a no: the GC pass comes
   * back every 30 minutes and finds it gone once it has ended.
   */
  // Chi risparmiare, se l'umano non è d'accordo su un nome (di solito `target`:
  // vedi `parseSlimSkip`). Letto una volta sola: cambiarlo vuole un riavvio, come
  // ogni altra soglia di questo file.
  const WORKTREE_SLIM_SKIP = parseSlimSkip(process.env.TOPICS_WORKTREE_SLIM_SKIP);

  async function slimWorktreeOfTask(taskId: string): Promise<void> {
    try {
      const wt = deps.worktreeOfTask(taskId);
      if (!wt || !existsSync(wt.absPath)) return;
      if (deps.isInFlight(taskId)) return;
      if (deps.previewList().some((p) => p.taskId === taskId)) return;
      if (topicsProcessRunsIn(wt.absPath)) return;
      const res = await slimWorktree(wt.absPath, WORKTREE_SLIM_SKIP);
      if (res.removed.length > 0) {
        console.log(
          `[worktree-slim] ${wt.name}: ${formatMb(res.bytes)} liberati — ` +
          res.removed.map((r) => `${r.relPath} (${formatMb(r.bytes)})`).join(", "),
        );
      }
      for (const e of res.errors) console.warn(`[worktree-slim] ${wt.name}: ${e.relPath} non rimosso — ${e.message}`);
    } catch (err) {
      console.warn("[worktree-slim] fallito", err);
    }
  }

  async function teardownPreviewOfWorktree(worktreeId: string): Promise<void> {
    try {
      const topic = deps.db.prepare("SELECT id FROM topics WHERE worktree_id = ? LIMIT 1").get(worktreeId) as { id?: string } | undefined;
      if (!topic?.id) return;
      const t = deps.db.prepare("SELECT id FROM tasks WHERE assigned_topic_id = ? LIMIT 1").get(topic.id) as { id?: string } | undefined;
      if (t?.id) await deps.previewTeardown(t.id);
    } catch { /* best-effort */ }
  }

  /**
   * UNA PASSATA ALLA VOLTA.
   *
   * Quattro punti la lanciano — il giro dopo il boot, il timer dei 30 minuti,
   * la rotta `/__daemon/worktree-gc` e `runGc` — e finché la potatura si
   * limitava a LEGGERE, due passate sovrapposte erano solo lavoro doppio.
   *
   * Da quando salva il residuo, SCRIVE: due `git add` nella stessa cartella si
   * contendono `index.lock`, e chi perde non riprova. Misurato il 19/08/2026,
   * al primo giro col codice nuovo: sette worktree persi per
   * «Unable to create index.lock: File exists», tutti nello stesso progetto.
   *
   * Chi arriva mentre una passata è in volo riceve LA STESSA promessa: nessuna
   * coda che si accumula, nessun secondo giro, e il chiamante ottiene comunque
   * il riepilogo vero invece di un `null` da interpretare.
   */
  /** La passata in volo, o `null` se non ce n'e' nessuna. */
  let inVolo: Promise<GcRunSummary | null> | null = null;

  function runWorktreeGc(): Promise<GcRunSummary | null> {
    const corrente = inVolo;
    if (corrente) return corrente;
    const avviata = sweepOnce();
    inVolo = avviata;
    // Si registra la pulizia SENZA incatenarci sopra: chi aspetta riceve la
    // passata vera, non un anello di `.finally` che ne cambia il tipo e
    // sposterebbe anche il punto in cui un rifiuto si propaga. Il confronto
    // `=== avviata` evita che una passata finita azzeri quella dopo.
    void avviata.finally(() => { if (inVolo === avviata) inVolo = null; });
    return avviata;
  }

  /**
   * THE SWEEP'S POPULATION, and why it is not `list({ status: "ready" })`.
   *
   * The only writer of `pending -> ready|error` is the in-memory closure of
   * `create()`: a restart mid-`git worktree add` (or an update the DB
   * swallowed) leaves the row `pending` forever. The UI shows the loader, the
   * sweep skipped it every round, and folder (up to ~200 MB) and branch
   * stayed. Three weeks of evidence on two projects, as of 2026-09-03.
   *
   * Here a `pending` row nobody is building and older than the grace is
   * REPAIRED when folder and branch still exist (back to `ready`, with the
   * frame the UI has been waiting for), and in every case it enters the same
   * sweep: the same safety contract as every other row, no new subsystem.
   * Age alone would be the wrong lever: the per-project queue legitimately
   * holds a row behind other installs, which is why the deciding word is
   * `isMaterialising`; the grace stays as a belt for rows born before this
   * process.
   */
  const WORKTREE_PENDING_GRACE_MS = 10 * 60_000;

  /**
   * Rows whose removal failed MAX_FAILED_PASSES passes running are left alone
   * until the next restart instead of being retried forever; said once, in the log.
   */
  const MAX_FAILED_PASSES = 3;
  const failedPasses = new Map<string, number>();

  async function collectPopulation(opts: { repair?: boolean } = {}): Promise<GcRow[]> {
    const out: GcRow[] = [];
    for (const w of deps.worktreeStore.list() as GcRow[]) {
      if ((failedPasses.get(w.id) ?? 0) >= MAX_FAILED_PASSES) continue;
      // An `error` row is judged too (the folder a failed `worktree add` left,
      // or the row alone), but only once it is a day old: until then its message
      // is what the person looking at the UI is reading.
      if (w.status === "error") {
        const born = Date.parse(w.createdAt ?? "");
        if (!Number.isFinite(born) || Date.now() - born >= MIN_REMOVAL_AGE_MS) out.push(w);
        continue;
      }
      if (w.status !== "pending") { out.push(w); continue; }
      if (deps.worktreeManager.isMaterialising?.(w.id)) continue;
      const born = Date.parse(w.createdAt ?? "");
      if (Number.isFinite(born) && Date.now() - born < WORKTREE_PENDING_GRACE_MS) continue;

      const repoPath = deps.projectStore.get(w.projectId)?.path;
      const present = existsSync(w.absPath);
      const branch = w.mode !== "branch"
        ? "merged"
        : repoPath ? await branchStatusFromRepo(repoPath, w.branchName).catch(() => "gone" as const) : "gone";
      if (present && branch !== "gone" && deps.worktreeStore.update && opts.repair !== false) {
        try {
          const updated = deps.worktreeStore.update(w.id, { status: "ready" });
          if (updated) deps.broadcast({ type: "worktree:updated", worktree: updated, payload_version: 1 });
          console.log(`[worktree-gc] riga pending riparata: ${w.branchName ?? w.id} torna ready (cartella e ramo presenti)`);
        } catch (err) {
          console.warn("[worktree-gc] riparazione della riga pending fallita", err);
        }
      } else {
        console.log(`[worktree-gc] riga pending stantia ${w.branchName ?? w.id}: cartella ${present ? "presente" : "assente"}, ramo ${branch}; la passata la giudica`);
      }
      out.push(w);
    }
    return out.map((w) => ({
      id: w.id, projectId: w.projectId, absPath: w.absPath, branchName: w.branchName, mode: w.mode,
    }));
  }

  /**
     * QUALCOSA STA GIRANDO LÀ DENTRO?
     *
     * Estratta perché adesso la usano in due (`slim` e `commitResidue`) e la
     * risposta deve essere la stessa: un'anteprima viva è un `bun run dev` in
     * quella cartella, e uno script Topics vivo è un processo con il cwd lì.
     * In entrambi i casi l'albero si sta ancora muovendo, e chi lo tocca —
     * per snellirlo o per committarlo — fotografa uno stato di mezzo.
     */
    const qualcosaVivoDentro = (wt: { id: string; absPath: string }): boolean => {
      if (deps.previewList().some((p) => deps.worktreeOfTask(p.taskId)?.id === wt.id)) return true;
      // PUNTO 3 (task e3240a22): l'unica guardia era previewList(), che non
      // consulta runningScripts. È il solo modo di fabbricare un fantasma che
      // il Punto 2 non vedrà mai: la root esiste, il contenuto è sparito sotto.
      return topicsProcessRunsIn(wt.absPath);
    };

    /**
     * Le modifiche non committate, messe sul branch prima di liberare la
     * cartella. Il COSA sta in `worktree-residue.ts`; qui restano le due
     * guardie che solo il server può rispondere: la cartella c'è ancora, e
     * dentro non sta girando niente.
     */
    const commitResidue = async (wt: { id: string; absPath: string; branchName?: string | null }): Promise<boolean> => {
      if (!wt.absPath || !existsSync(wt.absPath)) return false;
      if (qualcosaVivoDentro(wt)) {
        console.log(`[worktree-residue] ${wt.branchName ?? wt.id}: qualcosa gira dentro — residuo rimandato`);
        return false;
      }
      const res = await commitWorktreeResidue(wt.absPath);
      console.log(
        res.ok
          ? `[worktree-residue] ${wt.branchName ?? wt.id}: ${res.reason} (${res.commit})`
          : `[worktree-residue] ${wt.branchName ?? wt.id}: non salvato — ${res.reason}`,
      );
      return res.ok;
    };

  /** The task bound to a worktree row: worktree -> topic -> task. */
  const resolveTaskOf = (worktreeId: string): { taskId: string; status: GcTaskStatus; archived: boolean } | { taskId: null } => {
    const topic = deps.db.prepare("SELECT id FROM topics WHERE worktree_id = ? LIMIT 1").get(worktreeId) as { id?: string } | undefined;
    if (!topic?.id) return { taskId: null };
    const t = deps.db.prepare("SELECT id, status, archived FROM tasks WHERE assigned_topic_id = ? LIMIT 1").get(topic.id) as { id?: string; status?: string; archived?: number } | undefined;
    if (!t?.id) return { taskId: null };
    return { taskId: t.id, status: (t.status ?? "todo") as GcTaskStatus, archived: !!t.archived };
  };

  /** The roots this runner may look at: what the wiring names, else the manager's current root alone. */
  const rootsOf = (): { root: string; extraRoots: string[] } | null => {
    if (deps.roots) return deps.roots();
    const root = deps.worktreeManager.worktreesDir?.();
    return root ? { root, extraRoots: [] } : null;
  };

  /** A folder is Topics' own: under one of its roots (the setting may have moved the root, more than once). */
  const isOurs = (absPath: string): boolean => {
    const r = rootsOf();
    return !r || [r.root, ...r.extraRoots].some((root) => isInsideDir(absPath, root));
  };

  /** Worktrees locked by somebody other than Topics, as of the last read of git's lists. */
  let lockedByOthers = new Set<string>();

  /** A live terminal or sub-agent has its working directory in or under this folder (as written or as git spells it). */
  const liveCwdInside = (absPath: string): boolean => {
    const check = (path: string): boolean => {
      try {
        const since = new Date(Date.now() - SUBAGENT_GRACE_MS).toISOString();
        const kids = deps.db.prepare(
          "SELECT cwd FROM subagents WHERE state = 'running' OR ended_at IS NULL OR ended_at > ?",
        ).all(since) as { cwd: string }[];
        if (anyInsideDir(kids.map((k) => k.cwd), path, platform)) return true;
      } catch { /* table absent in old hosts: nothing to protect */ }
      return anyInsideDir(deps.liveCwds?.() ?? [], path, platform);
    };
    return check(absPath) || check(canonicalPath(absPath));
  };

  /** A chat topic bound to this row is mid-turn, or spoke in the last minutes. */
  const chatOnRow = (rowId: string): boolean => {
    if (!deps.chatActive) return false;
    try {
      const rows = deps.db.prepare("SELECT id FROM topics WHERE worktree_id = ?").all(rowId) as { id: string }[];
      return rows.some((r) => deps.chatActive!(topicSessionKey(r.id)));
    } catch { return false; }
  };

  /** The row at this path, as written or as git spells it. */
  const rowIdAt = (absPath: string): string | null => {
    const rows = deps.worktreeStore.list();
    const exact = rows.find((w) => w.absPath === absPath);
    if (exact) return exact.id;
    const canon = canonicalPath(absPath);
    return rows.find((w) => canonicalPath(w.absPath) === canon)?.id ?? null;
  };

  /**
   * SOMEBODY IS INSIDE: the one answer every pass that removes or moves a folder
   * asks (sweep, cap, foreign pass, root pass, by-hand relocation). A live
   * terminal or sub-agent cwd, a process Topics started, a chat bound to the
   * row that is mid-turn, or a session Topics did not start (a terminal's
   * Claude Code, Codex, jcode).
   */
  const busyInside = (absPath: string, rowId: string | null = null): boolean =>
    liveCwdInside(absPath)
    || topicsProcessRunsIn(absPath)
    || (rowId !== null && chatOnRow(rowId))
    || (deps.externalActiveAt?.(absPath) ?? false);

  /**
   * Pins the branch tip under `refs/topics/archive/<task>` before a checkout is
   * freed or abandoned (`wt-<id>` for a row with no task). False when the branch
   * should resolve and the ref could not be written: the checkout then stays.
   */
  const pinBeforeFree = async (wt: { id: string; projectId: string; absPath: string; branchName: string | null; mode: string }): Promise<boolean> => {
    if (wt.mode !== "branch" || !wt.branchName) return true;
    const repoPath = deps.projectStore.get(wt.projectId)?.path;
    if (!repoPath) return true;
    // Freeing keeps the BRANCH: commits made on a HEAD that left it would go with the folder.
    if (await headHoldsCommitsOffBranch(wt, repoPath, git)) return false;
    if (!(await branchExistsInRepo(repoPath, wt.branchName))) return true;
    // Already kept by an archive ref, ours or the hook's tag: nothing more to pin.
    const tip = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${wt.branchName}^{commit}`]).catch(() => null);
    if (tip?.code === 0 && await alreadyArchived(repoPath, tip.stdout.trim(), git).catch(() => false)) return true;
    const t = resolveTaskOf(wt.id);
    return archiveBranchRef(repoPath, wt.branchName, t.taskId ?? `wt-${wt.id}`);
  };

  /** Counts consecutive failed passes per row; a success clears the count. */
  const tracked = (id: string, ok: boolean): boolean => {
    if (ok) failedPasses.delete(id);
    else {
      const n = (failedPasses.get(id) ?? 0) + 1;
      failedPasses.set(id, n);
      if (n === MAX_FAILED_PASSES) console.warn(`[worktree-gc] ${id}: ${n} passes failed in a row, left alone until the next restart`);
    }
    return ok;
  };

  /** The sweep's dependencies over a population, with the real effects. */
  function sweepDeps(population: GcRow[], settings: GcSettings): SweepDeps {
    return {
      listWorktrees: () => population,
      resolveTask: resolveTaskOf,
      isBusy: (taskId) => deps.isInFlight(taskId),
      // Only the folders under Topics' own root are Topics' to judge: an
      // adopted session's checkout elsewhere is kept as is. A manager that
      // cannot name its root (tests, older hosts) judges everything, as before.
      foreign: (w) => !isOurs(w.absPath),
      lockedByOthers: (w) => lockedByOthers.has(canonicalPath(w.absPath)),
      // A `spawn_agent` child has a worktree but no card and no terminal: its
      // folder stays while it runs and for 24h after it ended (see `liveCwdInside`).
      liveInside: (w) => busyInside(w.absPath, w.id),
      diskPresent: (absPath) => existsSync(absPath),
      realDirt: (absPath) => worktreeDirtProbe(absPath),
      branchStatus: async (w) => {
        const repoPath = deps.projectStore.get(w.projectId)?.path;
        if (!repoPath) return "gone" as const;
        const status = await branchStatusFromRepo(repoPath, w.branchName);
        return status !== "unmerged" && await headHoldsCommitsOffBranch(w, repoPath, git) ? "unmerged" : status;
      },
      headStatus: (w) => headStatusOfCheckout(w, deps.projectStore.get(w.projectId)?.path, git),
      abandonAfterDays: settings.abandonDays,
      idleDays: (taskId) => idleDaysOfTask(taskId),
      // «Il ramo non c'è più» va letto insieme a QUESTO, o dice il contrario del
      // vero. Il commit di consegna si guarda per CONTENUTO (`commitStatusFromRepo`
      // + `classifyLanding`, gli stessi dell'audit dei land): un land squashato non
      // lascia un'ancestry, ma è atterrato lo stesso. `unverifiable` esce `null`,
      // che non è `false`: non aver potuto guardare non è una prova di fallimento.
      deliveryLanded: async (taskId, wt) => {
        const commit = deps.svc.get(taskId)?.task?.deliveryCommit;
        if (!commit) return null;
        const repoPath = deps.projectStore.get(wt.projectId)?.path;
        if (!repoPath) return null;
        return deps.deliveryIsOnMain(repoPath, commit);
      },
      // Lo scioglimento che NON declassa: il legame col worktree morto se ne va, il
      // checkout pure (il branch è già sparito, non c'è niente da conservare), ma
      // la card resta nella sua colonna. `release` con `requeue: false` su una card
      // in review la lascia in review apposta — vedi il commento in `tasks.ts`.
      unbind: async (taskId, wt, reason, deliveryLanded) => {
        const t = deps.svc.get(taskId)?.task;
        const notice = await abandonNoticeFromRepo({
          reason,
          repoPath: deps.projectStore.get(wt.projectId)?.path ?? null,
          branchName: wt.branchName,
          deliveryCommit: t?.deliveryCommit ?? null,
          deliveryLanded,
          taskFate: "stays",
        });
        try {
          deps.svc.release({ taskId, requeue: false, keepStatus: true, by: "system", reason: notice });
        } catch (err) {
          console.warn("[worktree-gc] scioglimento del legame fallito", err);
          return false;
        }
        annuncia(taskId);
        try { await deps.previewTeardown(taskId); } catch { /* best-effort */ }
        return deps.worktreeManager.delete(wt.id, { deleteBranch: false });
      },
      abandon: async (taskId, wt, reason) => {
        // The tip goes under the archive ref BEFORE the checkout can be lost.
        if (!(await pinBeforeFree(wt))) return false;
        // PRIMA SI GUARDA, POI SI SCRIVE. Questa riga è quella che l'umano legge
        // per decidere se ha perso lavoro: fino al 04/08 era una formula fissa che
        // giurava «il branch è INTATTO (nessun commit perso)» senza aver mai
        // risolto il ref — e la scriveva anche sul ramo «branch sparito», negando e
        // rassicurando nella stessa riga (task `5770b9de`, visto sul task
        // `8f635484`: `topics/vibrant-creek` non esisteva). Verifica + composizione
        // stanno in `worktree-abandon-notice`, dove sono collaudate su un repo vero.
        const notice = await abandonNoticeFromRepo({
          reason,
          repoPath: deps.projectStore.get(wt.projectId)?.path ?? null,
          branchName: wt.branchName,
        });
        // Order matters: park FIRST. `release` clears the topic binding, so from
        // here on nothing can resume this task into a checkout that's about to
        // disappear (a resume falls back to the base project dir — the human's own
        // repo). If the removal below fails, the task is at least already safe.
        try {
          deps.svc.release({
            taskId,
            requeue: false,
            parkState: "failed",
            by: "system",
            reason: notice,
          });
        } catch (err) {
          console.warn("[worktree-gc] park del task abbandonato fallito", err);
          return false;
        }
        annuncia(taskId);
        try { await deps.previewTeardown(taskId); } catch { /* best-effort */ }
        // `deleteBranch: false` is the whole point of this path.
        return deps.worktreeManager.delete(wt.id, { deleteBranch: false });
      },
      // Never a merge: see the archive branch in `sweepWorktrees`. Wired
      // whatever the board's auto-merge setting says: archiving is not landing.
      archiveBranch: async (taskId, wt) => {
        const repoPath = deps.projectStore.get(wt.projectId)?.path;
        if (!repoPath || !wt.branchName) return false;
        return archiveBranchRef(repoPath, wt.branchName, taskId);
      },
      // Solo la cartella. `deleteBranch: false` è tutta la differenza con `reap`
      // qui sotto: i commit restano raggiungibili dal ref, e il worktree smette di
      // occupare ~400 MB per una copia di lavoro che nessuno riaprirà.
      freeCheckout: async (worktreeId) => {
        const row = population.find((w) => w.id === worktreeId);
        if (row && !(await pinBeforeFree(row))) return false;
        await teardownPreviewOfWorktree(worktreeId);
        return deps.worktreeManager.delete(worktreeId, { deleteBranch: false });
      },
      reap: async (worktreeId) => {
        await teardownPreviewOfWorktree(worktreeId);
        return deps.worktreeManager.delete(worktreeId);
      },
      // Il recupero dell'arretrato: le card consegnate PRIMA che esistesse lo
      // snellimento alla consegna, e quelle la cui anteprima era ancora viva
      // quando ci abbiamo provato. Stesse tre condizioni di `slimWorktreeOfTask`
      // — che è la funzione stessa, raggiunta via il task del worktree.
      commitResidue,
      slim: async (wt) => {
        if (qualcosaVivoDentro(wt)) {
          console.log(`[worktree-slim] ${wt.branchName ?? wt.id}: qualcosa gira dentro — slim rimandato`);
          return 0;
        }
        const res = await slimWorktree(wt.absPath, WORKTREE_SLIM_SKIP);
        if (res.removed.length > 0) {
          console.log(
            `[worktree-slim] ${wt.branchName ?? wt.id}: ${formatMb(res.bytes)} liberati — ` +
            res.removed.map((r) => r.relPath).join(", "),
          );
        }
        return res.bytes;
      },
      // A reap refused because the work isn't provably on main must be VISIBLE:
      // the same class of loss went unnoticed for 8 days precisely because the
      // sweep only ever spoke to the server log.
      noteOnTask: (taskId, message, opts) => {
        try { deps.svc.addComment({ taskId, author: "system", content: message, kind: opts?.kind, once: opts?.once }); }
        catch (err) { console.warn("[worktree-gc] noteOnTask failed", err); }
        // Il commento e' il posto dove l'umano viene a sapere che una cartella
        // e' sparita: se arriva solo al prossimo ricaricamento, arriva dopo che
        // ha gia' cercato il suo lavoro dove non c'e' piu'.
        annuncia(taskId);
      },
      // Il ramo scritto sulla card mentre e' ancora noto: e' cio' che la tiene
      // landabile dopo che la cartella se n'e' andata (vedi `stampDeliveryBranch`).
      // USA setDeliveryBranch e non recordDelivery: quest'ultima azzera commit,
      // diffstat e landing_state (per progetto: un dato non aggiornato mente),
      // ma qui non ci sono nuovi dati — solo un indirizzo da conservare. Le card
      // dichiarate NON su main dal GC perdevano proprio quei dati, e con loro
      // uscivano dall'audit di landing (filtra per delivery_commit IS NOT NULL).
      stampDeliveryBranch: (taskId, branch) => {
        try { deps.svc.setDeliveryBranch(taskId, branch); }
        catch (err) { console.warn("[worktree-gc] stampDeliveryBranch failed", err); }
        // Il ramo appena timbrato e' cio' che rende la card ancora landabile:
        // il bottone che lo usa vive sullo schermo, quindi il dato deve
        // arrivarci senza aspettare un F5.
        annuncia(taskId);
      },
      log: (msg) => console.log(msg),
    };
  }

  /** Wraps the removing effects so a row that keeps failing is counted, then left alone (see `failedPasses`). */
  function withFailureCount(d: SweepDeps): SweepDeps {
    const guard = async (id: string, run: () => Promise<boolean>): Promise<boolean> => {
      try { return tracked(id, await run()); } catch (err) { tracked(id, false); throw err; }
    };
    return {
      ...d,
      reap: (id) => guard(id, () => d.reap(id)),
      freeCheckout: d.freeCheckout ? (id) => guard(id, () => d.freeCheckout!(id)) : undefined,
      abandon: d.abandon ? (taskId, wt, reason) => guard(wt.id, () => d.abandon!(taskId, wt, reason)) : undefined,
      unbind: d.unbind ? (taskId, wt, reason, landed) => guard(wt.id, () => d.unbind!(taskId, wt, reason, landed)) : undefined,
    };
  }

  /** What the root pass needs from this host. */
  const rootPassDeps = (): RootPassDeps => ({
    roots: rootsOf,
    quarantineDays: () => readSettings().quarantineDays ?? resolveWorktreeQuarantineDays(),
    store: deps.worktreeStore,
    projects: () => deps.projectStore.list?.() ?? [],
    git,
    onLocks: (locks) => { lockedByOthers = locks; },
    abandonDays: () => readSettings().abandonDays,
    liveInside: (absPath) => busyInside(absPath, rowIdAt(absPath)),
    log: (msg) => console.log(msg),
  });
  const canScanRoot = (): boolean => (!!deps.roots || !!deps.worktreeManager.worktreesDir) && !!deps.projectStore.list && !!deps.worktreeStore.create;

  // `null` when the pass failed: the `catch` below turns the failure into a result
  // instead of a rejection, so a timer that starts a pass has nothing to handle.
  async function sweepOnce(): Promise<GcRunSummary | null> {
    try {
      const settings = readSettings();
      // The disk first: register orphans, remove ghosts, prune what git forgot.
      const root = canScanRoot() ? await runRootPass(rootPassDeps()) : null;
      const population = await collectPopulation();
      const summary: GcRunSummary = await sweepWorktrees(withFailureCount(sweepDeps(population, settings)));
      if (root) { const { plan: _plan, ...rest } = root; summary.root = rest; }
      if (settings.gcForeign === "merged") summary.foreignRemoved = await foreignPass(passesCtx);
      summary.capped = await enforceCap();
      return summary;
    } catch (err) {
      console.error("[worktree-gc] sweep failed", err);
      return null;
    }
  }

  /** What the extra passes (cap, foreign, preview) read from this host. */
  const passesCtx: PassesCtx = {
    readSettings,
    rows: () => deps.worktreeStore.list() as GcRow[],
    isOurs,
    folderPresent: (absPath) => existsSync(absPath),
    taskOf: resolveTaskOf,
    isInFlight: (taskId) => deps.isInFlight(taskId),
    liveInside: (absPath) => busyInside(absPath, rowIdAt(absPath)),
    busyInside: (wt) => qualcosaVivoDentro(wt),
    slim: (absPath) => slimWorktree(absPath, WORKTREE_SLIM_SKIP),
    sweepOne: (wt, settings) => sweepWorktrees(withFailureCount(sweepDeps([wt], settings))),
    previewDeps: (population, settings) => sweepDeps(population, settings),
    population: (opts) => collectPopulation(opts),
    rootDeps: rootPassDeps,
    canScanRoot,
    removeForeign: {
      isForeign: (p) => !isOurs(p),
      held: (w) => busyInside(w.absPath, w.id) || resolveTaskOf(w.id).taskId !== null,
      mergedAndClean: async (w) => {
        const repoPath = deps.projectStore.get(w.projectId)?.path;
        if (!repoPath || !w.branchName || !existsSync(w.absPath)) return false;
        // HEAD-aware: a row adopted on a merged branch and then detached, with
        // commits on top, is judged by what the folder holds now.
        if ((await headStatusOfCheckout(w, repoPath, git)) !== "merged") return false;
        const dirt = await worktreeDirtProbe(w.absPath);
        return dirt.ok && dirt.paths.length === 0 && dirt.unregistered !== true;
      },
      remove: (id) => deps.worktreeManager.delete(id, { deleteBranch: false, includeForeign: true }).then(Boolean),
      log: (msg) => console.log(msg),
    },
  };

  let capInFlight: Promise<number> | null = null;

  /** One cap pass at a time: a burst of creates asks once, not once each. */
  function enforceCap(projectId?: string): Promise<number> {
    if (capInFlight) return capInFlight;
    const run = capPass(passesCtx, projectId).catch((err) => { console.warn("[worktree-gc] cap pass failed", err); return 0; });
    capInFlight = run;
    void run.finally(() => { if (capInFlight === run) capInFlight = null; });
    return run;
  }

  async function planWorktreeGc(opts: { weigh?: boolean } = {}): Promise<GcPlan | null> {
    try {
      return await previewPass(passesCtx, opts);
    } catch (err) {
      console.error("[worktree-gc] preview failed", err);
      return null;
    }
  }

  return {
    runWorktreeGc,
    planWorktreeGc,
    isBusyInside: (absPath) => busyInside(absPath, rowIdAt(absPath)),
    isTaskActive: (worktreeId) => {
      const t = resolveTaskOf(worktreeId);
      return t.taskId !== null && !t.archived && t.status !== "done";
    },
    enforceCap,
    slimWorktreeOfTask,
    intervalMs: WORKTREE_GC_INTERVAL_MS,
    // Due minuti dopo il boot: si lascia depositare il dispatch prima di
    // giudicare chi e' vivo. Era un numero letterale dentro il `setTimeout`.
    bootDelayMs: 120_000,
  };
}
