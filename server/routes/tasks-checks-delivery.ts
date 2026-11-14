/**
 * The pre-review checks gate and the delivery rounds that outlive their request.
 */
import { cpus } from "node:os";
import { isCiEvidenceCheck } from "../../shared/board";
import { mintSessionToken, SESSION_TOKEN_HEADER } from "../lib/session-token";
import { topicsHome } from "../services/daemon-state";
import { type Task } from "../services/tasks";
import { type RealignOutcome } from "../services/task-automerge";
import { FAST_GATES_CHECK, checksVerdict, formatChecksComment, formatChecksThreadSummary, formatChecksWait, hasFastGates, runReviewChecks, type ReviewCheck } from "../services/review-checks";
import { ChecksInterruptedError, createChecksGate, type ChecksLane, type ChecksLeg } from "../services/checks-gate";
import { forgetDelivery, reviewChecksStopping, swapInterruptedDelivery, throwIfStopping } from "../services/review-checks-brakes";
import { bumpPendingDeliveryRound, forgetPendingDelivery, loadPendingDeliveries, savePendingDelivery, type PendingDelivery } from "../services/pending-delivery-store";
import { ciNotMeasured } from "../services/ci-evidence";
import type { TasksCore, TasksLate } from "./tasks-scope";

/** How many pre-review check runs may execute at once (see `createChecksGate`). */
function checksLanes(): number {
  const forced = Number(process.env.TOPICS_CHECKS_LANES);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  let cores = 0;
  try { cores = cpus().length; } catch { cores = 0; }
  return cores >= 12 ? 2 : 1;
}

export function createTasksChecksDelivery(core: TasksCore, late: TasksLate) {
  const { ctx, opts, svc, broadcastToAll, broadcastToTopicSubscribers } = core;
  const tasksRouter: TasksLate["tasksRouter"] = (...args) => late.tasksRouter(...args);

  /**
   * Le corse dei check, una per task, VIVE oltre la richiesta che le ha chieste.
   * Sta nella chiusura della rotta (non è un singleton di modulo) perché muore
   * con l'istanza: due server nello stesso processo, due registri, come per la
   * fila dei land qui sotto.
   */
  // TWO RUNS AT ONCE ON A BIG MACHINE. One run at a time was the right
  // default when every agent also ran the whole suite by itself; since the
  // envelope stopped that (2026-09-04) a run costs ~6-8 load for ~7 minutes,
  // and with six agents delivering in the same quarter hour a single lane
  // meant 40+ minutes of queue for the last one - past the 50-minute cap (now 100) of
  // `update_task`. Two lanes on twelve cores keep the load under ~20 and halve
  // the queue; smaller machines keep the one lane. `TOPICS_CHECKS_LANES`
  // overrides either way.
  const checksGate = createChecksGate({ maxConcurrent: checksLanes() });
  // Notifica il chiamante non appena il gate esiste, cosi' puo' passarne
  // `runningCount` al dispatcher senza accoppiamenti circolari.
  // `settleDelivery` is a hoisted declaration below: the hook only stores the
  // reference, and nothing calls it before the router is finished being built.
  try { opts?.onChecksGate?.(checksGate, { settleDelivery: (taskId) => settleDelivery(taskId) }); } catch { /* best-effort */ }

  // WITHOUT A PREDICATE, and only here: this is the one instant when the gate's
  // registry is EMPTY by construction, so every «running» left in the database
  // belongs to a dead process. The periodic sweep (`sweepStaleChecksLights` in
  // server.ts) asks the same question every 30 s, but it has to pass the live
  // registry - the bare call there would switch off a run that is grinding.
  try {
    const spente = svc.clearStaleChecksRuns();
    if (spente.length) console.warn(`[checks] ${spente.length} spie 'running' spente: erano di un processo morto`);
  } catch { /* una spia non deve poter impedire al server di partire */ }

  /**
   * Terzo gate strutturale sulla review, dopo il commit (`review_needs_commit`) e
   * il riassunto (`review_needs_summary`): i comandi dichiarati sulla board devono
   * essere VERDI. Non si chiede all'agente se ha fatto girare i test — si fanno
   * girare, nel suo worktree, sul codice che ha appena committato.
   *
   * Ritorna `null` quando il gate non si applica (board senza comandi, task senza
   * worktree di branch): "nessun check" non è un verde e non deve scriverne uno.
   *
   * L'AGENTE ASPETTA, LA RICHIESTA NO. Il gate girava dentro questa richiesta, e
   * la richiesta durava quanto i comandi: misurato il 13/08, `test:unit` da solo
   * ci mette ~10 minuti su macchina carica, ma il socket muore a 255,6s netti
   * perché `idleTimeout` di Bun non sale oltre 255. Esito: transizione persa e
   * `checks_state` fermo su «running» per sempre. Adesso la corsa vive nel
   * registro (`services/checks-gate.ts`) e questa funzione aspetta al massimo UNA
   * GAMBA: `{ pending: true }` significa "sta ancora girando, richiama" ed è il
   * client MCP a rimettersi in fila, esattamente come fa per `ask_user_question`.
   *
   * Il resto della semantica è quello di prima, e volutamente: il task NON entra
   * in review mentre i comandi girano (il reviewer vedrebbe una consegna
   * guardabile a verdetto ignoto), e un rosso torna all'agente con l'output.
   */
  /**
   * A DELIVERY WHOSE CLIENT GAVE UP STILL LANDS ITS VERDICT.
   *
   * The checks run in the registry and the status moves only when a leg comes
   * back with the verdict - and the leg is the MCP client polling every 25 s,
   * for at most 100 minutes (`CHECKS_MAX_LEGS`). On 2026-09-04 at 12:37 three
   * cards resumed together, delivered at once, and sat in the gate's slot
   * queue past that cap: `update_task` threw, each agent ended its turn saying
   * "consegnato", the checks finished green minutes later and NOBODY applied
   * them. The cards stayed in_progress, the dispatcher read the turns as
   * "closed without review" and spent an attempt each.
   *
   * So the route remembers the delivery it answered 202 to, and when the run
   * ends it re-issues that same PATCH to itself: green moves the card to
   * review exactly as a client leg would, red leaves the comment the run
   * already wrote. The client's polling becomes a courtesy, not a condition.
   */
  const pendingDeliveries = new Map<string, { pathname: string; body: Record<string, unknown> }>();

  /**
   * AND IT OUTLIVES THE PROCESS, since 2026-09-16.
   *
   * The map above only ever had to survive a client giving up. Now it has to
   * survive the server too: a delivery whose checks are only WAITING no longer
   * holds a planned reload back (`cardTurnsHoldingReload` in lib/quiescence.ts),
   * and cutting it is only free if it comes back by itself. The row is written
   * beside every `set` and removed beside every `delete`; the map stays the fast
   * path, the table is read once at boot.
   */
  function rememberDelivery(taskId: string, pathname: string, body: Record<string, unknown>): void {
    pendingDeliveries.set(taskId, { pathname, body });
    savePendingDelivery(ctx.db, {
      taskId, pathname, body,
      // THE COMMIT OF *THIS* ROUND, not of the last one measured.
      //
      // It used to be `svc.get(taskId).task.checksCommit`, which is whatever
      // the previous round recorded, and a delivery that never started a round
      // wrote it anyway: `runChecksGate` answers `interrupted` to a leg that
      // arrives while the server is on its way out BEFORE it resolves a
      // checkout, so the row got the old commit. If that stale commit happened
      // to be the worktree HEAD (a redelivery with no new commit of its own),
      // at boot `sameDelivery` read "same delivery" and skipped the realign
      // entirely - the checks then measured a base main had moved away from,
      // which is the 2026-09-04 regression the block at `runChecksGate`
      // describes, while the log claimed "nessun riallineamento in più".
      //
      // `roundCommit` is written by the round itself, once its checkout is
      // known, and only a round that got that far can claim "already realigned".
      commit: roundCommit.get(taskId) ?? null,
    });
  }

  function forgetDeliveryMemo(taskId: string): void {
    pendingDeliveries.delete(taskId);
    roundCommit.delete(taskId);
    forgetPendingDelivery(ctx.db, taskId);
  }

  /**
   * What the round in flight is measuring: the commit its checkout was on when
   * it started, AFTER the realign. Written by `runChecksGate` once it has a
   * ref, dropped when a verdict is recorded - so "no entry" means "this
   * delivery never got as far as realigning", and the round that restarts it
   * has to realign.
   */
  const roundCommit = new Map<string, string | null>();

  /**
   * The deliveries a previous process was in the middle of, recognised by their
   * commit: the round they restart is the SAME delivery, so it does not realign
   * on main again (`sameDelivery` in `runChecksGate`). An entry lives until a
   * verdict is recorded for that card, exactly like the row.
   */
  const restoredDeliveries = new Map<string, string | null>();

  /**
   * THE CHAT SEES THE WAIT TOO. The card shows «2/5» (`checksProgress`); the
   * agent's thread showed a mute `update_task` spinning for the whole bar, and
   * from there the topic looked stuck: on 05/09/2026 three card turns sat 20-60
   * minutes in this exact wait while the person asked, three times, why the
   * topics were still. Each pending leg pushes ONE line into the running tool
   * call of the agent's live stream, on the channel bash already uses for its
   * partial output (`stream:tool_update`): ephemeral, never persisted, skipped
   * when there is no live stream or no running tool to hang it on. The clock
   * starts at the first pending leg, so the queue behind another card counts.
   */
  const checksWaitSince = new Map<string, number>();
  function tellChatAboutChecksWait(
    sessionKey: string,
    topicId: string | null,
    taskId: string,
    projectId: string,
    task: { checksProgress?: { done: number; total: number } | null } | undefined,
  ): void {
    try {
      const since = checksWaitSince.get(taskId) ?? Date.now();
      checksWaitSince.set(taskId, since);
      const stream = ctx.activeStreams.get(sessionKey);
      if (!stream) return;
      const running = ctx.getMessageById(stream.messageId)?.toolCalls?.find((tc) => tc.status === "running");
      if (!running) return;
      const declared = svc.getBoardSettings(projectId).reviewChecks;
      const progress = task?.checksProgress ?? null;
      const partialResult = formatChecksWait({
        done: progress ? progress.done : null,
        total: progress?.total ?? declared.length,
        checks: declared,
        elapsedMs: Date.now() - since,
      });
      const message = { type: "stream:tool_update" as const, sessionKey, topicId: topicId ?? undefined, toolCallId: running.id, partialResult };
      if (topicId) broadcastToTopicSubscribers(topicId, message);
      else broadcastToAll(message);
    } catch { /* a courtesy line: it must never stop the leg */ }
  }

  function settleDelivery(taskId: string, attempt = 0): void {
    const pending = pendingDeliveries.get(taskId);
    if (!pending) return;
    // The run's promise settles a microtask after `run` returns; a timer is
    // enough to land after it, and a run still marked live simply waits.
    setTimeout(() => {
      if (checksGate.isRunning(taskId)) {
        if (attempt < 20) settleDelivery(taskId, attempt + 1);
        return;
      }
      // The map entry goes, the ROW stays: the re-issued PATCH writes it again
      // if the round is still going, and removes it once there is a verdict. A
      // process that dies in between finds the delivery again at its next boot.
      if (!pendingDeliveries.delete(taskId)) return;
      reissueDelivery(taskId, pending.pathname, pending.body, "client andato");
    }, attempt === 0 ? 0 : 250);
  }

  /** The remembered PATCH, sent back through the router's own front door. The
   *  leg is short: nobody is waiting on this answer, the card and the thread are. */
  function reissueDelivery(taskId: string, pathname: string, body: Record<string, unknown>, why: string): void {
    const url = new URL(`http://localhost${pathname}`);
    // The coordinator must prove who it is here too (provenGlobalOrchestrator): the
    // remembered PATCH already passed that proof, so the server re-signs it for the same
    // session. Session routes stay tokenless as before: anonymous, not refused.
    const coordinator = pathname.match(/^\/api\/orchestrator-sessions\/([^/]+)\//)?.[1];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (coordinator) headers[SESSION_TOKEN_HEADER] = mintSessionToken(topicsHome(), decodeURIComponent(coordinator));
    const req = new Request(url, {
      method: "PATCH", headers,
      body: JSON.stringify({ ...body, legMs: 1_000 }),
    });
    tasksRouter(req, url, pathname, "PATCH")
      .then((resp) => console.log(`[Tasks] consegna di ${taskId.slice(0, 8)} completata dal server (${why}): HTTP ${resp?.status ?? "nessuna risposta"}`))
      .catch((err) => console.warn(`[Tasks] consegna di ${taskId.slice(0, 8)}: il PATCH riemesso dal server è fallito:`, err));
  }

  /**
   * How many times a boot restarts the SAME round before saying so instead.
   *
   * Three, and the arithmetic is the round's own: a round with the CI rows
   * costs the local commands (typecheck measured at 73-177 s, plus lint,
   * deadcode and the static rails) and then up to 65 minutes of polling
   * GitHub, while a save under `server/` sends a SIGTERM that cuts it - 6
   * restarts in the 14/09T23 hour, 4 in the T20 one, 1-2 an hour all through
   * 16/09. Three whole rounds thrown away is already more wall clock than one
   * round ever gets, so a fourth silent attempt is not patience, it is a loop.
   */
  const MAX_DELIVERY_ROUNDS = 3;

  /**
   * The round is not restarted a fourth time: the card is told, once.
   *
   * The row goes with it, because leaving it would restart the count at the
   * next boot and write the same line again. Nothing else is touched - the card
   * stays `in_progress`, the branch and the commit are where the agent left
   * them - since what unblocks this is a person or a new delivery, not another
   * round nobody watches.
   */
  function giveUpOnDelivery(taskId: string, rounds: number): void {
    forgetPendingDelivery(ctx.db, taskId);
    console.warn(`[Tasks] consegna di ${taskId.slice(0, 8)}: ${rounds} giri di check ripartiti da zero senza verdetto, il giro non riparte`);
    try {
      const task = svc.get(taskId)?.task;
      if (!task) return;
      svc.addComment({
        taskId, author: "system", kind: "comment",
        content:
          `I check di questa consegna sono ripartiti da zero ${rounds} volte senza arrivare a un verdetto: ` +
          "ogni riavvio del server taglia il giro (i comandi locali durano minuti, le righe CI aspettano la pull request) " +
          "e ricominciarlo non ha misurato niente. Il giro non riparte piu' da solo: serve un commit nuovo da consegnare, " +
          "oppure una persona che guardi perche' questo giro non arriva in fondo.",
      });
      const t = svc.get(taskId)?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId: t.projectId, task: t });
    } catch { /* the card may have moved under us: the log line above stays */ }
  }

  /**
   * THE DELIVERIES THE PREVIOUS PROCESS WAS STILL WAITING ON.
   *
   * A planned reload no longer waits for a delivery whose checks are only
   * waiting (`cardTurnsHoldingReload`), and the swap brake already cut rounds
   * without a verdict. Either way the round is gone and nothing else would
   * bring the delivery back: the agent's turn died with the process, and its
   * `update_task` with it. So the server re-issues each remembered PATCH, once,
   * as the same delivery — the commit is carried into `restoredDeliveries`, so
   * the round measures the tree it already realigned instead of merging main a
   * second time.
   *
   * ONLY FOR A CARD THAT IS STILL DELIVERING. The filter used to be "not in
   * review, not done, not gone", which let through every card that had left
   * `in_progress` by another door: the «Ferma» button parks it in `backlog`
   * (`release({requeue:false})`), the dispatcher's boot reconcile requeues an
   * orphan to `todo`. The re-issue then ran the WHOLE round for it — tsc,
   * eslint, `bun test`, vite launched by nobody on the Mac that had just
   * rebooted for lack of memory, which is the exact resource this change
   * defends — wrote `checks_state = 'pass'` and a service comment on a parked
   * card, and only the final transition was refused with a 409, suite already
   * run. A green badge on a delivery that never happened.
   */
  function resumePendingDeliveries(): void {
    let entries: PendingDelivery[] = [];
    try { entries = loadPendingDeliveries(ctx.db); } catch { entries = []; }
    for (const entry of entries) {
      if (!stillDelivering(entry.taskId)) {
        forgetPendingDelivery(ctx.db, entry.taskId);
        // One line per row dropped, because "my card never resumed its checks"
        // is a question somebody asks, and the rows in flight at a shutdown are
        // a handful, not a stream.
        console.warn(`[Tasks] consegna di ${entry.taskId.slice(0, 8)} dimenticata al boot: la card non è più in lavorazione, nessun check lanciato`);
        continue;
      }
      // COUNTED BEFORE IT RESTARTS, because the round that follows may well be
      // cut by the next save under `server/` and never be counted at all.
      const round = bumpPendingDeliveryRound(ctx.db, entry.taskId);
      if (round > MAX_DELIVERY_ROUNDS) {
        giveUpOnDelivery(entry.taskId, round);
        continue;
      }
      restoredDeliveries.set(entry.taskId, entry.commit);
      pendingDeliveries.set(entry.taskId, { pathname: entry.pathname, body: entry.body });
      // A tick, not a microtask: the router is still being built, and the
      // re-issue goes back in through `tasksRouter`.
      setTimeout(() => {
        // Asked again, at the moment of the action: this sweep runs while
        // `createTasksRouter` is still being built (server.ts), and the
        // dispatcher's boot reconcile — which requeues the orphans of the
        // killed process — only runs its first pass later, asynchronously. A
        // card requeued in between must not get a round either.
        if (!stillDelivering(entry.taskId)) {
          pendingDeliveries.delete(entry.taskId);
          restoredDeliveries.delete(entry.taskId);
          forgetPendingDelivery(ctx.db, entry.taskId);
          console.warn(`[Tasks] consegna di ${entry.taskId.slice(0, 8)} dimenticata: la card non è più in lavorazione, nessun check lanciato`);
          return;
        }
        if (!pendingDeliveries.delete(entry.taskId)) return;
        // Said HERE and not in the sweep above: a line that announces a resume
        // must only be printed by a resume that happens.
        console.warn(
          `[Tasks] consegna di ${entry.taskId.slice(0, 8)} ripresa dopo il riavvio: i check ripartono ` +
          (entry.commit
            ? `sullo stesso commit (${entry.commit.slice(0, 7)}), nessun riallineamento in più`
            : "con un riallineamento su main: il giro tagliato non era arrivato a farlo"),
        );
        reissueDelivery(entry.taskId, entry.pathname, entry.body, "riavvio del server");
      }, 0);
    }
  }

  /**
   * Is this card still the one that delivered? `in_progress` is the only status
   * a delivery can come back to: review and done are past it, backlog and todo
   * are a card someone took back. `archived` is not a status here — an archived
   * card answers nothing from `get`, which the missing-task arm covers.
   */
  function stillDelivering(taskId: string): boolean {
    let task: Task | undefined;
    try { task = svc.get(taskId)?.task; } catch { return false; }
    return !!task && task.status === "in_progress";
  }

  async function runChecksGate(
    taskId: string,
    projectId: string,
    legMs: number,
    // A delivery planted from another machine has no worktree of its own: the
    // meter (`node-delivery-meter.ts`) hands in a throwaway checkout instead.
    checkout?: () => Promise<{ cwd: string; commit: string | null } | null>,
  ): Promise<ChecksLeg> {
    const checkoutRef = checkout ?? (opts?.taskCheckoutRef ? () => opts!.taskCheckoutRef!(taskId) : null);
    if (!checkoutRef || !opts) return null;
    let checks: ReviewCheck[] = [];
    try { checks = svc.getBoardSettings(projectId).reviewChecks; } catch { return null; }
    if (!checks.length) return null;
    // A server on its way out starts no round: the realign below would run a
    // merge in the worktree that the exit can cut in half, and the round would
    // be interrupted before its first command anyway. The leg is HELD for its
    // length, like a leg with a round in flight, so the socket close answers it
    // and the client retries that silence within its grace. Answered at once,
    // the client calls again in a tight loop for the whole exit (~3.5 s of
    // provider grace), and every call spends one of its legs.
    if (reviewChecksStopping()) {
      await Bun.sleep(legMs);
      return { interrupted: true };
    }
    // THE CHECKS MEASURE THE TREE THAT LANDS. On 2026-09-04 three cards
    // (4c4ac437, 882f81b9, c8039b35) burnt a turn each on an "inherited" red:
    // a bloat baseline main had already moved while their branch sat on an
    // older base. The land realigns before merging; the checks now do the
    // same before measuring, once per delivery. "Once per delivery" is read
    // off the gate: a run in flight, or a retained verdict for the commit the
    // worktree is on, means the legs of the same delivery; anything else is a
    // new delivery and main may have moved since (8db353ac, 2026-09-04: a
    // redelivery measured on a base ten commits behind because the key was
    // merely "known"). A realign that cannot happen - conflict, dirty tree -
    // IS the verdict: not a single command runs, and the agent gets the file
    // list instead of a timeout.
    const before = await checkoutRef().catch(() => null);
    // A round the swap brake interrupted restarts as the SAME delivery: realigned
    // again, two `git merge main` in one worktree (a server re-issue and a client
    // leg) race on index.lock and write a failed realign as a red.
    //
    // So does a round the RESTART cut. The registry of the dead process is
    // gone, so nothing in memory can say "same delivery": the row says it, by
    // the commit the round was measuring. The worktree is still on the tree the
    // first realign produced, and merging main into it again would write a
    // second merge commit into a delivery nobody re-made. A row whose commit is
    // null says "this round never got as far as a checkout": it matches only a
    // worktree whose own HEAD is unreadable, where a realign has nothing to
    // merge into anyway - and `roundCommit` is what keeps that null honest.
    const restoredCommit = restoredDeliveries.get(taskId);
    const sameDelivery = checksGate.isRunning(taskId) || checksGate.verdictFor(taskId, before?.commit ?? null)
      || swapInterruptedDelivery(taskId, before?.commit ?? null)
      || (restoredDeliveries.has(taskId) && restoredCommit === (before?.commit ?? null));
    if (opts.realignForChecks && !sameDelivery) {
      const re = await opts.realignForChecks(taskId)
        .catch((err): RealignOutcome => ({ ok: false, reason: `riallineamento fallito: ${err instanceof Error ? err.message : String(err)}` })); // allow-italian: board notes are written in Italian like every other service comment
      if (!re.ok) {
        const comment =
          `**Riallineamento su main fallito, check non partiti**: ${re.reason}. ` + // allow-italian: board notes are written in Italian like every other service comment
          "Nel worktree fai `git merge main`, risolvi, committa, poi rimetti in review con update_task(status=\"review\")."; // allow-italian: board notes are written in Italian like every other service comment
        try {
          svc.recordChecks({
            taskId, state: "fail", commit: null,
            runs: [{ name: "realign", cmd: "git merge main", ok: false, code: 1, ms: 0, timedOut: false, tail: re.reason }],
          });
          svc.addComment({ taskId, author: "system", kind: "comment", content: comment });
          const t = svc.get(taskId, { projectId })?.task;
          if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
        } catch { /* the verdict counts more than its record */ }
        return { ok: false, comment };
      }
      if (re.note) {
        try { svc.addComment({ taskId, author: "system", kind: "service", content: `Riallineato su main prima dei check: ${re.note}` }); } // allow-italian: board notes are written in Italian like every other service comment
        catch { /* a trace, not the gate */ }
      }
    }
    const ref = await checkoutRef().catch(() => null);
    if (!ref) return null;
    // Past the realign, on a known checkout: from here on THIS is the commit
    // the delivery is measuring, and the one a restart has to carry over.
    roundCommit.set(taskId, ref.commit ?? null);
    // The fast static guards run FIRST, so a missing @covers or a stray sleep
    // costs seconds here instead of a queued CI run. The list lives in the
    // `gates:fast` script, the one CI runs as well. A project without it
    // (any repo but this one) is measured exactly as before.
    if (hasFastGates(ref.cwd)) checks = [FAST_GATES_CHECK, ...checks.filter((c) => c.cmd !== FAST_GATES_CHECK.cmd)];
    // The CI evidence rows never reach a shell: they are read after the local commands.
    const localChecks = checks.filter((c) => !isCiEvidenceCheck(c));
    const ciChecks = checks.filter(isCiEvidenceCheck);

    const measure = async (lane: ChecksLane) => {
      // 'running' subito e in broadcast: i comandi possono durare minuti e una
      // board ferma senza spiegazioni si legge come "si è impiantato".
      try {
        const t = svc.recordChecks({
          taskId, state: "running", commit: ref.commit, runs: null,
          // Zero su N: la spia si accende gia' sapendo QUANTI comandi
          // aspettano, cosi' la card dice «0/4» invece di «in corso».
          progress: { done: 0, total: checks.length },
        });
        broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch { /* il gate vale anche senza la spia */ }

      /* IL PROGRESSO SI RIPORTA A OGNI COMANDO FINITO.
       *
       * `onProgress` c'era gia' in `runReviewChecks` e non lo usava nessuno:
       * i comandi giravano uno per uno e la card diceva «check in corso»
       * dall'inizio alla fine. Segnalato: «vedo che c'e' qualcosa in corso,
       * ma se c'e' qualcosa in corso dovrebbe esserci un progress».
       *
       * Best-effort come la spia qui sopra: se la scrittura fallisce il gate
       * continua: un progresso mancato non deve poter fermare una consegna. */
      const runs = await runReviewChecks(localChecks, {
        cwd: ref.cwd,
        // So a run frozen for load can say so in THIS card's thread.
        taskId,
        commit: ref.commit,
        // No new command starts under the memory floor (see `MemoryFloor`).
        memoryFloor: opts?.checksMemoryFloor,
        onProgress: (_run, i) => {
          try {
            const t = svc.recordChecks({
              taskId, state: "running", commit: ref.commit,
              // I run PARZIALI viaggiano con lui: un comando gia' rosso si
              // vede subito nel drawer, invece di aspettare la fine del giro.
              runs: null,
              progress: { done: i + 1, total: checks.length },
            });
            broadcastToAll({ type: "task:updated", projectId, task: t });
          } catch { /* una spia persa non ferma il gate */ }
        },
      });
      if (ciChecks.length && runs.length === localChecks.length && runs.every((r) => r.ok)) {
        // Waiting on GitHub holds no CPU: give the lane to the next card's run.
        lane.release();
        // A reader that throws measured nothing: NOT MEASURED, like its own
        // docstring promises. Left to the gate, the exception became the `null`
        // of a run that blew up, which the delivery reads as "no gate at all",
        // and the card entered review with no e2e verdict. Only a shutdown
        // passes through, as the interrupted outcome it already has.
        const unread = (reason: string) => ciChecks.map((c) => ciNotMeasured(c, reason));
        /* THE WAIT ON GITHUB IS NOT A MUTE WAIT.
         *
         * The pull request and its run exist within seconds of the push, and
         * used to reach the card only inside the tail of the verdict — measured
         * on run 35158365969, from 22:34:48 to 22:49:48: a quarter of an hour in
         * which the card said «check 1/2» and nothing that could be opened.
         * Best-effort like every other lamp of this round: a link that fails to
         * be written must not be able to stop a delivery. */
        const onCiWait = (links: { prUrl: string; runUrl?: string }) => {
          try {
            const t = svc.recordChecks({
              taskId, state: "running", commit: ref.commit, runs: null,
              progress: { done: localChecks.length, total: checks.length }, ci: links,
            });
            broadcastToAll({ type: "task:updated", projectId, task: t });
          } catch { /* a link lost does not stop the gate */ }
        };
        const ciRuns = ref.commit && opts?.ciEvidence
          ? await opts.ciEvidence({ cwd: ref.cwd, sha: ref.commit, taskId, checks: ciChecks, onCiWait }).catch((err: unknown) => {
            if (err instanceof ChecksInterruptedError) throw err;
            return unread(`the CI evidence reader failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          : unread(ref.commit ? "no CI evidence reader on this server" : "the worktree has no commit");
        // One row per declared CI check, whatever the reader answered.
        runs.push(...ciChecks.map((c) => ciRuns.find((r) => r.cmd === c.cmd) ?? ciNotMeasured(c, "the CI evidence reader returned no row for it")));
        throwIfStopping();
      }
      const ok = runs.length === checks.length && runs.every((r) => r.ok);
      const comment = formatChecksComment(runs, { commit: ref.commit });
      const threadSummary = formatChecksThreadSummary(runs, { commit: ref.commit });
      try {
        // TRE ESITI, non due. `checksVerdict` e' lo stesso predicato che sceglie
        // la parola del commento: uno SCADUTO non ha misurato niente, e
        // marcarlo `fail` manda chi rivede a cercare un guasto che non c'e'.
        // Misurate il 18/08 sul DB vivo: 6 card su 15 marcate rosse erano solo
        // scadute. `checks` e' l'elenco DICHIARATO — se ne sono tornati meno,
        // qualcuno non e' arrivato in fondo.
        svc.recordChecks({ taskId, state: checksVerdict(runs, checks.length), commit: ref.commit, runs });
        forgetDelivery(taskId);
        // Measured: whatever brought this delivery back, it is no longer a
        // delivery of a dead process, and its next leg is a NEW one.
        restoredDeliveries.delete(taskId);
        roundCommit.delete(taskId);
        // Green is service bookkeeping; red is a visible outcome. The thread
        // keeps only the compact verdict and first failure. Commands and logs
        // remain in checks_json, rendered by the expandable ChecksSection.
        svc.addComment({ taskId, author: "system", kind: ok ? "service" : "comment", content: threadSummary });
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch { /* l'esito conta più della sua registrazione */ }
      settleDelivery(taskId);
      return { ok, comment };
    };

    return checksGate.leg(taskId, {
      commit: ref.commit ?? null,
      legMs,
      run: async (lane) => {
        try {
          return await measure(lane);
        } catch (err) {
          // Interrupted for swap: no verdict, and nothing else would restart the
          // round if no client leg comes back. The remembered PATCH is re-issued
          // once the key is gone, and its first command waits for the swap to end.
          if (err instanceof ChecksInterruptedError && err.reason === "swap") setTimeout(() => settleDelivery(taskId), 0);
          throw err;
        }
      },
    });
  }

  return { checksGate, rememberDelivery, forgetDeliveryMemo, tellChatAboutChecksWait, settleDelivery, reissueDelivery, giveUpOnDelivery, resumePendingDeliveries, stillDelivering, runChecksGate, pendingDeliveries, roundCommit, restoredDeliveries, checksWaitSince } satisfies Partial<TasksLate> & Record<string, unknown>;
}
