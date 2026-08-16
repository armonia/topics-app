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
import { existsSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { sweepWorktrees, type TaskStatus as GcTaskStatus, type WorktreeGcSummary } from "./worktree-gc";
import { worktreeDirtProbe } from "./task-automerge";
import { branchStatusFromRepo } from "./branch-status";
import { abandonNoticeFromRepo } from "./worktree-abandon-notice";
import { formatMb, parseSlimSkip, slimWorktree } from "./worktree-slim";

/**
 * Tutto cio' che la potatura chiede al resto del server, dichiarato.
 *
 * Sono closure e non valori di proposito: alcune di queste cose (`tryMerge`,
 * l'anteprima) nascono DOPO il punto in cui la fabbrica viene costruita, e
 * leggerle alla chiamata e' esattamente cio' che l'hoisting garantiva prima.
 */
export interface WorktreeGcDeps {
  db: Database;
  /** Lo store dei worktree: la popolazione da valutare. */
  worktreeStore: { list(filtro?: { status?: string }): any[] };
  /** Il manager: e' lui che cancella davvero una cartella. */
  worktreeManager: { delete(id: string, opts?: any): Promise<any> };
  /** Il progetto di un worktree, per leggere lo stato del ramo dal checkout principale. */
  projectStore: { get(id: string): { path?: string } | null | undefined };
  getTopicBySessionKey: (sessionKey: string) => any;
  resolveTopicCwd: (topic: any) => string | null;
  /** Il servizio task: card, impostazioni, park, commenti, consegna. */
  svc: any;
  /** Un turno dispatchato e' in volo su questo task: non si tocca niente. */
  isInFlight: (taskId: string) => boolean;
  /** Il worktree di un task, risolto dal server (task -> topic -> worktree). */
  worktreeOfTask: (taskId: string) => { id: string; absPath: string; projectId: string; name?: string; mode?: string; branchName?: string | null } | null;
  /** Il progetto che possiede un percorso: serve a datare il ramo dal checkout giusto. */
  projectIdForPath: (path: string) => string | null;
  /** La consegna e' su main? Risposta per CONTENUTO, non per discendenza. */
  deliveryIsOnMain: (repoPath: string, commit: string) => Promise<boolean | null>;
  /**
   * Il merge del ramo del task nel checkout principale (nasce dopo: closure).
   *
   * Il terzo argomento NON e' decorazione: e' la fotografia della consegna
   * (ramo e commit gia' registrati sulla card), ed e' cio' che tiene una card
   * landabile quando la cartella del worktree non c'e' piu'. Toglierlo fa
   * fallire il land proprio nei casi per cui questa potatura esiste.
   */
  tryMerge: (
    taskId: string,
    text: string,
    delivery?: { branch: string | null; commit: string | null },
  ) => Promise<any>;
  /** L'anteprima viva di un task, se c'e' (nasce dopo: closure). */
  previewList: () => { taskId: string }[];
  previewTeardown: (taskId: string) => Promise<void>;
}

export interface WorktreeGcRunner {
  runWorktreeGc: () => Promise<WorktreeGcSummary | null>;
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
  // provably nothing to lose, landing a closed task's unmerged-but-clean commits
  // first. See server/services/worktree-gc.ts.
  const WORKTREE_GC_INTERVAL_MS = 30 * 60_000;
  // After how many days without a single sign of life an `in_progress` task counts
  // as abandoned and gives its checkout back (branch kept — see worktree-gc.ts).
  // A week: dispatch turns are capped at minutes, so seven days of total silence
  // on a task that claims an agent is working can only mean nobody is.
  const WORKTREE_ABANDON_DAYS = Number(process.env.TOPICS_WORKTREE_ABANDON_DAYS ?? 7);

  /**
   * Days since the LAST SIGN OF LIFE on a task, or null if we can't tell.
   *
   * "Life" is deliberately the union of every trace an agent or a human leaves,
   * because each one alone has a blind spot: the task row misses work that only
   * talked (a long turn commenting nothing), comments miss a chat-only session,
   * and both miss a CLI session whose only trace is the transcript growing on
   * disk. The maximum of the four is the honest answer; a query that blows up
   * returns null, which the GC reads as "don't touch".
   */
  function taskIdleDays(taskId: string): number | null {
    try {
      const row = deps.db
        .prepare(
          `SELECT t.updated_at AS taskAt,
                  (SELECT MAX(created_at) FROM task_comments WHERE task_id = t.id) AS commentAt,
                  (SELECT MAX(m.timestamp) FROM messages m
                     JOIN topics tp ON tp.session_key = m.session_key
                    WHERE tp.id = t.assigned_topic_id) AS messageAt,
                  t.assigned_topic_id AS topicId
             FROM tasks t WHERE t.id = ?`,
        )
        .get(taskId) as { taskAt?: string; commentAt?: string; messageAt?: string; topicId?: string } | undefined;
      if (!row) return null;

      let last = 0;
      for (const ts of [row.taskAt, row.commentAt, row.messageAt]) {
        const ms = ts ? Date.parse(ts) : NaN;
        if (Number.isFinite(ms)) last = Math.max(last, ms);
      }

      // The transcript: the only trace of a session that writes without ever
      // reaching our tables. Best-effort — a missing file just doesn't vote.
      if (row.topicId) {
        try {
          const sk = (deps.db.prepare("SELECT session_key AS sk FROM topics WHERE id = ?")
            .get(row.topicId) as { sk?: string } | undefined)?.sk;
          const topic = sk ? deps.getTopicBySessionKey(sk) : null;
          const csid = sk
            ? (deps.db.prepare("SELECT claude_session_id AS id FROM claude_code_sessions WHERE session_key = ?")
                .get(sk) as { id?: string } | undefined)?.id
            : undefined;
          const cwd = topic ? deps.resolveTopicCwd(topic) : null;
          if (cwd && csid) {
            const p = claudeTranscriptPath(cwd, csid);
            if (existsSync(p)) last = Math.max(last, statSync(p).mtimeMs);
          }
        } catch { /* il transcript è un voto in più, mai un blocco */ }
      }

      if (!last) return null;
      return (Date.now() - last) / 86_400_000;
    } catch (err) {
      console.warn("[worktree-gc] idleDays failed", err);
      return null;
    }
  }

  /**
   * Un preview server non può sopravvivere alla cartella da cui serve: sia il
   * `reap` sia il `free-checkout` la portano via, quindi entrambi lo spengono
   * prima. Best-effort — un preview ostinato non deve impedire di liberare spazio.
   */
  /**
   * Butta gli artefatti rigenerabili dal worktree di un task, tenendo la cartella.
   *
   * Tre condizioni prima di toccare qualsiasi cosa, e sono tutte «c'è ancora
   * qualcuno lì dentro?»: la cartella esiste, nessun turno sta girando su quel
   * task, nessuna anteprima viva ci sta servendo un `bun run dev`. La sicurezza
   * di COSA si cancella sta invece tutta in `worktree-slim` (lista chiusa di nomi
   * + doppio cancello letto da git), non qui.
   *
   * Un'anteprima viva è un rinvio, non un no: la passata del GC ripassa ogni 30
   * minuti e la troverà spenta appena l'umano avrà approvato o chiuso.
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

  function runWorktreeGc() {
    return sweepWorktrees({
      listWorktrees: () => deps.worktreeStore.list({ status: "ready" }).map((w) => ({
        id: w.id, projectId: w.projectId, absPath: w.absPath, branchName: w.branchName, mode: w.mode,
      })),
      resolveTask: (worktreeId) => {
        const topic = deps.db.prepare("SELECT id FROM topics WHERE worktree_id = ? LIMIT 1").get(worktreeId) as { id?: string } | undefined;
        if (!topic?.id) return { taskId: null };
        const t = deps.db.prepare("SELECT id, status, archived FROM tasks WHERE assigned_topic_id = ? LIMIT 1").get(topic.id) as { id?: string; status?: string; archived?: number } | undefined;
        if (!t?.id) return { taskId: null };
        return { taskId: t.id, status: (t.status ?? "todo") as GcTaskStatus, archived: !!t.archived };
      },
      isBusy: (taskId) => deps.isInFlight(taskId),
      diskPresent: (absPath) => existsSync(absPath),
      realDirt: (absPath) => worktreeDirtProbe(absPath),
      branchStatus: (w) => {
        const repoPath = deps.projectStore.get(w.projectId)?.path;
        if (!repoPath) return Promise.resolve("gone" as const);
        return branchStatusFromRepo(repoPath, w.branchName);
      },
      // DUE NAMESPACE, UNO SOLO GIUSTO. `wt.projectId` è l'uuid del projectStore
      // (`75e5098a-…`); `board_settings` è chiavata sull'id di BOARD, cioè
      // `deps.projectIdForPath(path)` (`topics-app-ar3jt5`). Passare il primo dove va il
      // secondo non solleva niente: `getBoardSettings` non trova la riga e
      // restituisce i default, dove `dispatchAutoMerge` è `false`.
      //
      // Effetto misurato l'11/08: `dispatch_auto_merge = 1` su entrambe le board, e
      // il GC che stampava «77× commit non mergiati, AUTOMERGE NON DISPONIBILE».
      // Il ramo `land-then-reap` — quello che porta su main il lavoro di un task
      // chiuso prima di liberarne la cartella — non è mai partito, nemmeno una
      // volta, da quando esiste. Un id sbagliato non fallisce: mente in silenzio.
      autoMergeEnabled: (projectId) => {
        try {
          const path = deps.projectStore.get(projectId)?.path;
          if (!path) return false;
          return !!deps.svc.getBoardSettings(deps.projectIdForPath(path)).dispatchAutoMerge;
        } catch { return false; }
      },
      abandonAfterDays: WORKTREE_ABANDON_DAYS,
      idleDays: (taskId) => taskIdleDays(taskId),
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
        try { await deps.previewTeardown(taskId); } catch { /* best-effort */ }
        return deps.worktreeManager.delete(wt.id, { deleteBranch: false });
      },
      abandon: async (taskId, wt, reason) => {
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
        try { await deps.previewTeardown(taskId); } catch { /* best-effort */ }
        // `deleteBranch: false` is the whole point of this path.
        return deps.worktreeManager.delete(wt.id, { deleteBranch: false });
      },
      tryLand: async (taskId) => {
        const t = deps.svc.get(taskId)?.task;
        const text = t?.text ?? "";
        const res = await deps.tryMerge(taskId, text, {
          branch: t?.deliveryBranch ?? null,
          commit: t?.deliveryCommit ?? null,
        });
        return res.status === "merged" ? "landed" : res.status === "nothing" ? "nothing" : res.status === "conflict" ? "conflict" : "skipped";
      },
      // Solo la cartella. `deleteBranch: false` è tutta la differenza con `reap`
      // qui sotto: i commit restano raggiungibili dal ref, e il worktree smette di
      // occupare ~400 MB per una copia di lavoro che nessuno riaprirà.
      freeCheckout: async (worktreeId) => {
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
      slim: async (wt) => {
        // Un'anteprima viva è un `bun run dev` che gira LÌ DENTRO: rimandare.
        if (deps.previewList().some((p) => deps.worktreeOfTask(p.taskId)?.id === wt.id)) return 0;
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
      noteOnTask: (taskId, message) => {
        try { deps.svc.addComment({ taskId, author: "system", content: message }); }
        catch (err) { console.warn("[worktree-gc] noteOnTask failed", err); }
      },
      // Il ramo scritto sulla card mentre e' ancora noto: e' cio' che la tiene
      // landabile dopo che la cartella se n'e' andata (vedi `stampDeliveryBranch`).
      stampDeliveryBranch: (taskId, branch) => {
        try { deps.svc.recordDelivery({ taskId, branch, commit: null }); }
        catch (err) { console.warn("[worktree-gc] stampDeliveryBranch failed", err); }
      },
      log: (msg) => console.log(msg),
    }).catch((err) => { console.error("[worktree-gc] sweep failed", err); return null; });
  }
  return {
    runWorktreeGc,
    slimWorktreeOfTask,
    intervalMs: WORKTREE_GC_INTERVAL_MS,
    // Due minuti dopo il boot: si lascia depositare il dispatch prima di
    // giudicare chi e' vivo. Era un numero letterale dentro il `setTimeout`.
    bootDelayMs: 120_000,
  };
}
