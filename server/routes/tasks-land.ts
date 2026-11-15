/**
 * Landing a task on main: the queue, the auto lander, the land itself, deploy and publish.
 */
import { isAgentWorking } from "../../shared/board";
import { landFallout } from "../services/task-automerge";
import type { LandingState } from "../services/landing-audit";
import { createLandingQueue, type LandingTicket, type LandOutcomeResult } from "../services/landing-queue";
import { type TaskAttempt } from "../services/task-attempts";
import { createAutoLander } from "../services/auto-land";
import { createNodeDeliveryMeter } from "../services/node-delivery-meter";
import type { StopCause } from "../lib/abort-cause";
import { readWorkflowRules } from "../services/board-workflow";
import { createCiPhase } from "./tasks-ci-phase";
import { ownChangesBetween } from "./tasks-git";
import { isServerRepo, requestCardProcessStop } from "./tasks-shared";
import type { TasksCore, TasksLate } from "./tasks-scope";

/** What a queued land is asked besides landing. */
export interface LandRunOpts {
  /** Do not realign the branch: the bar measured the delivered commit. */
  noRealign?: boolean;
  /**
   * The automatic land's verdict again, handed to `tryMerge` as `beforeMerge`
   * (inside the repo's queue, a moment before the merge), told the full sha about
   * to be merged; a string = stop for that reason.
   */
  recheck?: (commit: string | null) => Promise<string | null>;
}

export function createTasksLand(core: TasksCore, late: TasksLate) {
  const { opts, svc, attempts, db, broadcastToAll, dispatcher } = core;
  const reapAfterLand: TasksLate["reapAfterLand"] = (...args) => late.reapAfterLand(...args);
  const sweepRemoteDelivery: TasksLate["sweepRemoteDelivery"] = (...args) => late.sweepRemoteDelivery(...args);
  const capturaConsegna: TasksLate["capturaConsegna"] = (...args) => late.capturaConsegna(...args);
  const runChecksGate: TasksLate["runChecksGate"] = (...args) => late.runChecksGate(...args);

  /**
   * Taglia il turno VIVO di una card: ferma il processo dell'agente e chiude i
   * tentativi in corso. Non tocca lo stato — dove finisce la card lo decide chi
   * chiama (parcheggiata dal bottone «Ferma», chiusa da un land riuscito).
   *
   * `false` = non c'era niente da tagliare, e chi chiama può smettere lì.
   *
   * Chi chiama DEVE aver già scritto lo stato finale: la fine del turno passa da
   * `onTurnEnd`, che su una card ancora `in_progress` RIPRENDE l'agente
   * (`shouldResume` è vero per tutto tranne un rifiuto del modello). Tagliare
   * prima di chiudere la card significa quindi farla ripartire — su `done` la
   * stessa strada si limita a spegnere il chip.
   */
  /** The `running` attempts of a card; none when the table is missing (degraded host). */
  function runningAttempts(taskId: string): TaskAttempt[] {
    try { return attempts.list(taskId).filter((a) => a.state === "running"); }
    catch { return []; }
  }

  /**
   * A live turn exists if the card declares an agent at work, has `running`
   * attempts, or its topic has an open stream right now. `assignedTopicId`
   * alone is NOT enough: the topic stays bound to the card forever, even one
   * closed months ago (card 47b63de2). The stream has to be asked, because
   * after a land `dispatch_state` is already cleared and the process still runs.
   */
  function cardTurnIsLive(
    t: { id: string; assignedTopicId: string | null; dispatchState: string | null },
    running: TaskAttempt[] = runningAttempts(t.id),
  ): boolean {
    const streamLive = !!t.assignedTopicId && opts?.hasLiveTurn?.("topic:" + t.assignedTopicId.slice(0, 8)) === true;
    return isAgentWorking(t.dispatchState) || running.length > 0 || streamLive;
  }

  function cutLiveTurn(
    t: { id: string; assignedTopicId: string | null; dispatchState: string | null },
    reason: string,
    // A person's Stop on the card is `user`; the machine closing it is not (card C9).
    cause: StopCause,
  ): boolean {
    const running = runningAttempts(t.id);
    if (!cardTurnIsLive(t, running)) return false;
    // Dedup: il tentativo 1 è anche il topic legato al task.
    const keys = new Set<string>();
    for (const id of [t.assignedTopicId, ...running.map((a) => a.topicId)]) {
      if (id) keys.add("topic:" + id.slice(0, 8));
    }
    dispatcher?.onLeaveTodo(t.id); // sgancia un grace timer ancora pendente (queued)
    for (const a of running) {
      try { attempts.finish(a.id, { state: "failed", error: reason }); }
      catch { /* best-effort: il taglio del turno conta più della riga */ }
    }
    // Tree first, turn second: see `killAgentTree`'s doc for why the order is
    // load-bearing, not cosmetic.
    if (opts?.killAgentTree) {
      for (const key of keys) void opts.killAgentTree(key).catch(() => { /* best-effort */ });
    }
    if (opts?.abortTurn) {
      for (const key of keys) void opts.abortTurn(key, cause).catch(() => { /* best-effort */ });
    }
    return true;
  }

  /**
   * La fila dei land, una per progetto: le fusioni toccano tutte main nello
   * stesso checkout, quindi vanno in ordine. Il punto NON è che siano in fila —
   * `task-automerge` già serializzava le sue operazioni git — è che chi arriva
   * mentre una è in corso adesso si ACCODA con un ticket interrogabile, invece
   * di essere una promise fluttuante che nessuno tiene (`void landTask(...)`).
   */
  const landings = opts?.landings ?? createLandingQueue({ log: (m) => console.warn(m) });

  /**
   * Accoda il land di una card e restituisce il suo ticket (subito, senza
   * aspettare git). Ogni percorso che atterra una card passa da qui: il bottone
   * «Landa», la quick-reply dell'agente, e il trascinamento in Done.
   */
  function enqueueLand(projectId: string, taskId: string, landOpts?: LandRunOpts): LandingTicket {
    if (enterCiPhase(projectId, taskId, landOpts)) {
      const at = ciPhase.pending(projectId).indexOf(taskId);
      return { taskId, phase: "queued", ahead: at > 0 ? at : 0, queuedAt: new Date().toISOString(), settledAt: null, error: null, outcome: null, reason: null };
    }
    return landDirect(projectId, taskId, landOpts);
  }

  /** The land itself, behind the CI phase (or instead of it, on a board without CI rows). */
  function landDirect(projectId: string, taskId: string, landOpts?: LandRunOpts): LandingTicket {
    // PRIMA di accodare, non dopo: fra l'accodamento e la fusione la card non è
    // su main, e in quella finestra deve dirlo.
    try { opts?.markLandPending?.(taskId); } catch (err) { console.warn("[land] timbro di attesa fallito per", taskId, err); }
    // LA RICHIESTA LASCIA UNA TRACCIA, e non è un lusso: il 13/08 tre card sono
    // passate a `done` col ramo mai arrivato su main e nel thread — come nel log
    // del server — non c'era una riga sul tentativo. La coda vive in memoria,
    // quindi un riavvio fra l'accodamento e la fusione se la porta via: quella
    // riga è tutto ciò che resta a dire che un land era stato chiesto.
    try {
      svc.addComment({
        taskId, author: "system",
        // Ricevuta interna, e il commento qui accanto lo dice: esiste perché la
        // coda vive in RAM e un riavvio la perderebbe. È un log, non una parola.
        kind: "service",
        content: "Land accodato: la card si chiude solo quando il merge è CONFERMATO su main.",
      });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.warn("[land] traccia della richiesta non scritta per", taskId, err); }
    return landings.enqueue(projectId, taskId, () => landTask(projectId, taskId, landOpts));
  }

  /**
   * THE CARD THAT NEEDS NO ONE LANDS ITSELF (`services/auto-land.ts`).
   * Called after a delivery enters review, from the agent's door and from the
   * node lane once its bar is measured. The land it queues is told not to
   * realign the branch: the bar measured the delivered commit.
   */
  const autoLander = createAutoLander({
    read: (taskId, projectId) => {
      const got = svc.get(taskId, { projectId });
      if (!got) return undefined;
      // `Task` has no `archived` field and `svc.get` serves archived cards too:
      // the flag is read from the row, at the moment of asking.
      const row = db.query("SELECT archived FROM tasks WHERE id = ?").get(taskId) as { archived?: number } | null;
      return { ...got, task: { ...got.task, archived: !!row?.archived } } as ReturnType<Parameters<typeof createAutoLander>[0]["read"]>;
    },
    board: (projectId) => {
      const settings = svc.getBoardSettings(projectId);
      return { autoMerge: settings.dispatchAutoMerge, declaredChecks: settings.reviewChecks.length };
    },
    land: (projectId, taskId, recheck) => enqueueLand(projectId, taskId, { noRealign: true, recheck }),
    note: (taskId, text) => {
      svc.addComment({ taskId, author: "system", kind: "service", content: text });
    },
    files: opts?.deliveryFiles,
    referenced: opts?.deliveryReferenced,
    personPaths: (projectId) => readWorkflowRules(db, projectId).personPaths,
    // On a board with the CI phase the land waits for the CI, not for every open turn on the server: a
    // person's "Landa" never waited for them either, and the reload that follows resumes the turns it cuts
    // (lossless restart). Waiting for zero turns on a working board meant waiting forever: the timer gave
    // up after three hours and the card stayed in review. Boards without the phase keep the wait.
    liveTurns: opts?.liveTurnCount,
    waitsForTurns: (taskId) => {
      const projectId = svc.get(taskId)?.task.projectId;
      return !projectId || !ciPhase.boardHasCiPhase(projectId);
    },
    cardTurnLive: (taskId) => {
      const t = svc.get(taskId)?.task;
      return !!t && cardTurnIsLive(t);
    },
    pollMs: opts?.autoLandPollMs,
    log: (line) => console.warn(line),
  });

  const nodeMeter = createNodeDeliveryMeter({
    readTask: (taskId) => svc.get(taskId)?.task,
    declaredChecks: (projectId) => svc.getBoardSettings(projectId).reviewChecks,
    checkout: opts?.nodeDeliveryCheckout,
    runGate: (taskId, projectId, legMs, checkout) => runChecksGate(taskId, projectId, legMs, checkout),
    recapture: async (taskId) => {
      await capturaConsegna(taskId);
      const t = svc.get(taskId)?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId: t.projectId, task: t });
    },
    // A red measure sends the card back to its agent; anything else is offered to the automatic land.
    tryLand: async (projectId, taskId) => {
      if (await bounceRed(projectId, taskId)) return;
      return afterDelivery(projectId, taskId);
    },
    log: (line) => console.warn(line),
  });

  const ciPhase = createCiPhase({
    svc, db, dispatcher,
    broadcast: (msg) => broadcastToAll(msg),
    cardTurnIsLive: (t) => cardTurnIsLive(t),
    landDirect: (projectId, taskId) => landDirect(projectId, taskId),
    markLandPending: opts?.markLandPending,
    whenLanded: (taskId) => landings.whenSettled(taskId),
    tryAutoLand: (projectId, taskId) => autoLander.tryLand(projectId, taskId),
    integrationRepo: opts?.integrationRepo,
    integrationMeasure: opts?.integrationMeasure,
    integrationCollectMs: opts?.integrationCollectMs,
    filesBetween: opts?.integrationFilesBetween ?? (opts?.integrationRepo
      ? async (taskId, from, to) => {
        const repo = await opts.integrationRepo!(taskId).catch(() => null);
        return repo ? ownChangesBetween(repo, from, to) : null;
      }
      : undefined),
  });
  const { bounceRed, enterCiPhase, afterDelivery } = ciPhase;

  /** Every review card gets the verdict again: a timer lost to a reload strands nothing. */
  async function sweepAutoLand(): Promise<number> {
    let asked = 0;
    const rows = svc.list({ scope: "all", status: "review", rootsOnly: true });
    autoLander.forgetExcept(new Set(rows.map((t) => t.id)));
    for (const t of rows) {
      // A red that arrived after the delivery (a node's bar, a CI row that settled late) goes back to its agent here.
      if (t.checksState === "fail") { await bounceRed(t.projectId, t.id); continue; }
      // The CI phase lives in memory: a card that carries a person's decision and is in no queue is put
      // back (`returnToCiPhase` checks it again); an automatic decision goes through the automatic land below.
      if (t.landIntent === "human") {
        if (!ciPhase.pending(t.projectId).includes(t.id)) await ciPhase.returnToCiPhase(t.projectId, t.id);
        continue;
      }
      if (!t.labels.some((l) => l.label === "invisibile") || t.checksState !== "pass") continue;
      asked += 1;
      await autoLander.tryLand(t.projectId, t.id, { quiet: true });
    }
    return asked;
  }
  try {
    opts?.onAutoLand?.({ measureNodeDelivery: (taskId) => nodeMeter.measure(taskId), sweepAutoLand });
  } catch { /* the host wiring is best-effort */ }

  /**
   * REACHING DONE IS NOT PRESSING "LANDA": the board has a switch, and it has
   * to be read.
   *
   * Every entry into Done of a card carrying a delivery branch queued a merge
   * into main. Not just approval: the drag and the "Sposta in" menu too, two
   * gestures nobody performs in order to merge. The comment next to it claimed
   * the board had already decided this via `dispatchAutoMerge`, but on this
   * path nobody read that field. Measured on 13/08 against the live board db:
   * of the 137 "Mergiato su main" notes, 8 sit on boards whose switch is off
   * today (cifra, armonia-site, quadra, and one board with no settings row at
   * all, which defaults to off). Historical rows cannot prove what the switch
   * said at the time, which is why the count is stated as what it is and no
   * more; the structural fact needs no count, and a grep gives it: outside this
   * function `dispatchAutoMerge` had exactly one production reader, the
   * worktree GC.
   *
   * Off ⇒ no merge, and the card SAYS SO: a mute closure with the code still on
   * the branch is exactly the 10/08 fault in its silent form. The explicit
   * "Landa su main" button still goes through `enqueueLand` directly: that one
   * is a person's choice, not a side effect.
   */
  function enqueueLandOnDone(projectId: string, taskId: string, branch: string): LandingTicket | null {
    let autoMergeOn = true;
    // Failing to read the settings must not merge "because we did not know":
    // the careful direction is to NOT touch main.
    try { autoMergeOn = svc.getBoardSettings(projectId).dispatchAutoMerge; }
    catch (err) { console.warn("[land] board settings unreadable for", projectId, err); autoMergeOn = false; }
    if (autoMergeOn) return enqueueLand(projectId, taskId);
    try {
      svc.addComment({
        taskId, author: "system",
        content:
          // The note quotes the switch by the words printed next to it
          // (`board.settings.autoMerge` in client/src/lib/i18n.ts) and the
          // button by the words printed on it (`board.action.land`, the single
          // action table): a note that names a control the reader cannot find is
          // a note that gets ignored. Both are pinned by a test in
          // server/routes/tasks.test.ts, so renaming either label there fails
          // here rather than quietly drifting.
          "Chiusa SENZA fondere: il merge automatico è spento per questa board " +
          `(impostazioni della board, «Fondi su main quando la card arriva in Done»). Il lavoro resta sul branch \`${branch}\`. ` +
          "Per portarlo su main premi «Landa su main» sulla card, oppure fondilo a mano: " +
          `\`git merge --no-ff ${branch}\`.`,
      });
    } catch (err) { console.warn("[land] skipped-merge note not written for", taskId, err); }
    // THE NOTE HAS TO REACH THE CARD THAT IS OPEN RIGHT NOW. The PATCH handler
    // that called us already broadcast `task:updated` with the task as it was
    // BEFORE this comment, and `addComment` bumps `updated_at` precisely so a
    // live client refetches the thread (Card.tsx keys its comment effect on
    // `task.updatedAt`). Without a second broadcast the note exists only in the
    // db: a closure that looks exactly as mute as the one this whole function
    // exists to stop. Every other `addComment` in this file re-emits.
    const noted = svc.get(taskId, { projectId })?.task;
    if (noted) broadcastToAll({ type: "task:updated", projectId, task: noted });
    // AND THE WAY OUT THE NOTE NAMES HAS TO EXIST. "Landa su main" on a `done`
    // card is drawn by ONE surface: the "chiuso ma non su main" banner, behind
    // `landingState === 'unlanded'` — and `recordDelivery` blanks that column,
    // so it sits at NULL until the periodic audit runs, up to 30 minutes later
    // (LANDING_AUDIT_INTERVAL_MS). A note that names a button which is not
    // there for half an hour hands out a chore instead of a way out, which is
    // the exact defect the banner was built to close.
    //
    // So ASK, don't assert: "ask" makes the audit compute the verdict from the
    // repo now. Claiming `unlanded` outright would be a guess (the branch may
    // already be in main by someone else's hand), and a guess written as a
    // witnessed fact is how `landing_state` lied before.
    void (async () => {
      try { await opts?.stampLanding?.(taskId, "ask"); } catch { /* the verdict is best-effort: it must not break the close */ }
      const stamped = svc.get(taskId, { projectId })?.task;
      if (stamped) broadcastToAll({ type: "task:updated", projectId, task: stamped });
    })();
    return null;
  }

  /**
   * «Il commit di fusione è su main?» — con la prova che manca trattata come un
   * no, mai come un sì. Una verifica che esplode (`throw`) o che non esiste su
   * questo host non è un'assoluzione: vale `null`, cioè «non lo so», e da lì il
   * verdetto non può diventare `landed`.
   */
  async function landProof(repoPath: string, commit: string): Promise<boolean | null> {
    if (!opts?.confirmLandedOnMain) return null;
    try { return await opts.confirmLandedOnMain(repoPath, commit); }
    catch (err) { console.warn("[land] verifica su main fallita per", commit, err); return null; }
  }

  /**
   * «NON C'ERA NIENTE DA ATTERRARE» NON È UNA CHIUSURA, ed è la sola regola che
   * tiene: solo un merge CONFERMATO su main toglie una card da review. Un land
   * senza ramo, o su un ramo che non porta commit che main non abbia, non ha
   * portato niente da nessuna parte — magari il lavoro è già di là per mano di
   * qualcun altro, magari non è mai esistito. Le due cose si distinguono
   * guardando, e a guardare è l'umano: la card resta dov'è con scritto perché.
   *
   * Chiuderla qui sarebbe di nuovo far dire allo stato una cosa che nessuno ha
   * visto — il difetto del 13/08 con un'altra maschera. Su una card già chiusa
   * (il land partito dal trascinamento in Done) non c'è niente da spiegare.
   */
  function explainNothingToLand(projectId: string, taskId: string, reason: string): void {
    const cur = svc.get(taskId, { projectId })?.task;
    if (!cur || cur.status !== "review") return;
    try {
      svc.addComment({
        taskId, author: "system",
        content:
          `Niente da atterrare: ${reason}. Non è stato fuso niente, quindi la card resta in review. ` +
          "Se il lavoro è già su main (o non ce n'era), approvala tu; altrimenti guarda il ramo e rilancia «Landa su main».",
      });
      const fresh = svc.get(taskId, { projectId })?.task;
      if (fresh) broadcastToAll({ type: "task:updated", projectId, task: fresh });
    } catch (err) { console.warn(`[land] nota «niente da atterrare» non scritta per ${taskId}:`, err); }
  }

  async function landTask(projectId: string, taskId: string, landOpts?: LandRunOpts): Promise<LandOutcomeResult | void> {
    const autoMerge = opts?.autoMerge;
    if (!autoMerge) {
      svc.addComment({ taskId, author: "system", content: "Landing non disponibile: merge automatico non configurato per questo host." });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      // Il MOTIVO sul ticket, non la frase per una persona: quella e' il commento
      // qui sopra, e resta italiana. Questo campo esce solo da GET .../land, dove
      // lo legge chi diagnostica, ed e' inglese come gli altri esiti di questa
      // rotta ("task not found", "workspace not configured").
      return { outcome: "skipped", reason: "auto-merge not configured on this host" };
    }
    const task = svc.get(taskId, { projectId })?.task;
    // La card è sparita fra il click e il suo turno in coda (archiviata, spostata
    // di board). Non è un esito da nascondere: `throw` lo porta sul ticket, che è
    // l'unico posto dove chi ha chiesto il land può ancora leggerlo.
    if (!task) throw new Error(`task ${taskId} non trovato su questa board: land annullato`);
    // The automatic land's verdict is asked again INSIDE `tryMerge` (`beforeMerge`), not here.
    const toMerge = task.deliveryCommit ?? null;
    try {
      const recheck = landOpts?.recheck;
      const res = await autoMerge.tryMerge(taskId, task.text, {
        branch: task.deliveryBranch ?? null,
        commit: toMerge,
        ...(landOpts?.noRealign ? { noRealign: true } : {}),
        ...(recheck ? { beforeMerge: (sha: string) => recheck(sha).catch((err) => `the recheck failed: ${String(err)}`) } : {}),
      });
      // The automatic land stopped itself right before the merge (nobody pressed "Landa", so no "Land NON riuscito").
      if (res.status === "skipped" && res.code === "auto-land-stopped") {
        try {
          svc.addComment({
            taskId, author: "system", kind: "service", content: `L'atterraggio automatico si è fermato prima del merge: ${res.reason}. La card resta in review: su un commit nuovo con la barra verde l'atterraggio riparte da quello, altrimenti la chiude una persona.`,
          });
          const fresh = svc.get(taskId, { projectId })?.task;
          if (fresh) broadcastToAll({ type: "task:updated", projectId, task: fresh });
        } catch (err) { console.warn(`[land] nota di arresto non scritta per ${taskId}:`, err); }
        return { outcome: "skipped", reason: res.reason };
      }
      // Il ramo era vecchio e il land l'ha riportato al passo con main da sé: è
      // un commit che nessun umano ha fatto, quindi lo si dice — e per PRIMO,
      // perché è successo prima di tutto il resto.
      // ...and what that costs. What landed is C2 = merge(C, main), and the
      // checks - the local commands AND the two CI rows - measured C. Nobody
      // reads the CI of C2: the push, the draft and the poll loop all happened
      // once, on C, hours earlier (1,93 h in review on average, 32 lands in 7
      // days). So the note says which commit those verdicts describe, and
      // `checks_commit` stops naming a commit as if it were the one that landed.
      // Measured on 17/09: 22 of those 32 lands carry this line and only 4 also
      // warned that the land differed from the delivery - 18 said nothing.
      //
      // NOT a merge queue. Re-pushing C2 and re-reading its CI costs 15-40
      // minutes per land and is the owner's call, not this line's: what changes
      // here is only that the card stops claiming more than it measured.
      if (res.status === "merged" && res.realigned) {
        const before = svc.get(taskId, { projectId })?.task;
        const measured = before?.checksState && before.checksState !== "running"
          ? before.checksCommit ? `\`${before.checksCommit.slice(0, 8)}\`` : "il commit consegnato"
          : null;
        svc.addComment({
          taskId, author: "system", kind: "service",
          content: `Riallineato prima del land: ${res.realigned}.`
            + (measured
              ? ` I check (comandi locali e righe CI) hanno misurato ${measured}, non la fusione che sta atterrando: nessuno li ha rimisurati su quest'ultima.`
              : ""),
        });
        try { svc.clearChecksCommit(taskId); } catch (err) { console.warn(`[land] checks_commit non azzerato per ${taskId}:`, err); }
      }
      // Ciò che è atterrato non era lo scatto approvato: chi ha cliccato «Landa»
      // deve leggerlo, altrimenti crede di aver pubblicato quello che ha visto.
      // Prima del «Mergiato»: la riga che spiega vale solo se si legge per prima.
      const drift = res.status === "merged" || res.status === "nothing" ? res.deliveryDrift : null;
      if (drift) {
        svc.addComment({ taskId, author: "system", content: `⚠️ Land ≠ consegna: ${drift}.` });
      }
      // ── SI CHIEDE A MAIN, non al merge ─────────────────────────────────────
      //
      // `git merge` uscito zero è un resoconto: dice che una fusione è riuscita,
      // non DOVE. Da qui in giù «merged» vale solo insieme alla prova, e la
      // prova è che il commit di fusione sia dentro l'integrazione.
      const proof = res.status === "merged" ? await landProof(res.repoPath, res.commit) : null;
      let pushFailure: string | null = null;
      if (res.status === "merged" && proof === false) {
        // Il caso che chiude questo difetto: la macchina crede di aver landato,
        // main dice di no. La card NON si chiude, il worktree NON si pota (è
        // l'unica copia del lavoro) e il verdetto dice il vero.
        const proofReason = `il merge e' uscito zero ma il commit ${res.commit} NON risulta su main in ${res.repoPath}`;
        svc.addComment({
          taskId, author: "system",
          content:
            `⚠️ Land NON confermato: il merge è uscito zero ma il commit \`${res.commit}\` NON risulta su main in \`${res.repoPath}\`. ` +
            "La card resta dov'è e il branch è stato conservato. Controlla su quale ramo è il checkout, poi rilancia «Landa su main».",
        });
        try { await opts?.stampLanding?.(taskId, "unlanded"); } catch { /* la spia non fa fallire il resto */ }
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
        return { outcome: "unlanded", reason: proofReason };
      }
      if (res.status === "merged") {
        if (proof === null) {
          svc.addComment({
            taskId, author: "system",
            content:
              "⚠️ Il merge è uscito zero ma non ho potuto RILEGGERE main per confermarlo: la card è chiusa, " +
              "il verdetto di atterraggio resta «non verificabile». Controlla a mano se il lavoro è su main.",
          });
        }
        svc.addComment({ taskId, author: "system", kind: "service", content: `Mergiato su main (commit ${res.commit}).` });
        // THIS is where the card's review life ends, not at the start of the
        // land: the preview is torn down once the merge is confirmed. Tearing it
        // down before attempting the merge took the live page away from the
        // reviewer even when the land then failed and the card came back to
        // them (idempotent).
        try { await opts?.teardownPreview?.(taskId); } catch { /* best-effort */ }
        // The OTHER side of the same defect. The land promoted to `done` only
        // when coming from `review` (`POST …/land` does that before calling
        // here): from every other state it merged and left the card where it
        // was. Measured on 11/08 on `4ec47331`: work on main (`a5f83e0e`), card
        // `in_progress` with the `working` chip, and an agent that spent a whole
        // turn redoing it. A successful merge is the strongest possible claim
        // that the work is finished: the status must say so, whatever state we
        // came from. Idempotent on cards already closed and still (the normal
        // case), so it adds no history rows to the path that already worked.
        const statusBeforeSettle = svc.get(taskId, { projectId })?.task.status;
        const closed = svc.settleLanded({ taskId, by: "system", reason: `landed: the code is on main (${res.commit})` });
        if (statusBeforeSettle !== "done" && closed?.status === "done") requestCardProcessStop(opts, taskId);
        // THE MERGE HAPPENED EVEN WHEN THE CARD DOES NOT CLOSE. `settleLanded`
        // refuses to close a parent that still has open steps (closing it would
        // make them unreachable: the feed is `rootsOnly`), and without this line
        // whoever clicked "Landa su main" would read "Mergiato su main" above a
        // card that stays in review, with no idea why. The steps are named: they
        // are the ones to close or archive before approving the card.
        if (closed && closed.status !== "done") {
          const aperti = (svc.get(taskId, { projectId })?.children ?? [])
            .filter((c) => c.status !== "done")
            .map((c) => `«${c.text}»`);
          if (aperti.length) {
            svc.addComment({
              taskId, author: "system",
              content:
                `Il lavoro è su main, ma la card NON si chiude: restano ${aperti.length} sottotask aperti (${aperti.join(", ")}). ` +
                "Chiudili o archiviali, poi approva questa card.",
            });
          }
        }
        // Whoever was WAITING on this card finds out here, no longer at
        // approval: this is now the door through which a landed card reaches
        // `done`.
        if (closed && closed.status === "done") dispatcher?.onBlockerDone(taskId);
        // ...and if an agent was still WORKING on that card, it gets stopped.
        // Closing the card removes it from the queue but does not cut the turn
        // already under way, and that is where the money goes: measured on
        // 11/08 on two consecutive lands, $5,64 (`4ec47331`) and $8,24
        // (`56677242`, stopped within a minute) spent redoing work that was
        // already on main. Not an edge case: it happened on two lands out of
        // two, and the bill grows with every land.
        //
        // AFTER `settleLanded`, never before: the end of the turn goes through
        // `onTurnEnd`, which RESUMES the agent on a card still `in_progress`.
        // Cutting before closing the card would make it start again.
        if (closed && cutLiveTurn(closed, "il lavoro di questa card è atterrato su main: il turno non serve più", "superseded")) {
          svc.addComment({
            taskId, author: "system",
            content: "Fermato l'agente che stava ancora lavorando su questa card: il suo lavoro è appena atterrato su main.",
          });
        }
        await reapAfterLand(taskId, "landed");
        // ── THEN TO ORIGIN. Until 10/11 nobody pushed here: the "release
        // pipeline" of the header comment did not exist, and 18 lands sat on
        // this disk only, their cards in Done. A failed push does not undo the
        // land, but it SAYS so: verdict `unpushed` and a line in the thread.
        if (proof === true && opts?.pushMainAfterLand) {
          let push: { ok: true; pushed: number } | { ok: false; reason: string };
          try { push = await opts.pushMainAfterLand(res.repoPath); }
          catch (err) { push = { ok: false, reason: err instanceof Error ? err.message : String(err) }; }
          if (!push.ok) {
            pushFailure = push.reason;
            svc.addComment({
              taskId, author: "system",
              content:
                `⚠️ Su main in locale ma NON su origin: ${push.reason}. ` +
                "Il lavoro non è perso (è nel main di questa macchina); il controllo periodico ritenta il push, solo fast-forward, ogni 10 minuti.",
            });
          }
        }
        // The remote half of that same reap. Here, and not at the approval, for
        // the reason the whole land path is built on: the branch is finished only
        // once main has been RE-READ and confirms it. `proof === null` - the
        // merge exited zero and main could not be re-read - keeps the branch on
        // origin, because that is the one case where the comment above already
        // asks a person to go and look.
        //
        // `landed: res.branch` LEAVES THAT ONE PULL REQUEST ALONE, and this is
        // the whole reason the flag exists. `confirmLandedOnMain` re-reads the
        // LOCAL main (`server.ts`), and nothing in this server ever pushes main:
        // when the sweep runs, `origin/main` does not have the merge yet and a
        // person pushes it seconds to hours later. GitHub then marks that pull
        // request MERGED by itself - measured on #78, 17/09/2026, a minute after
        // the land. A `gh pr close` racing that push would stamp "Closed" on the
        // ~32 cards that land in a week instead. The card's OTHER branches, which
        // no push will ever merge, are closed here.
        //
        // NOT AWAITED, and that is the difference between housekeeping and a
        // stop-the-world. `landTask` runs inside `landings.enqueue`, ONE land at
        // a time per project, while this sweep is `gh pr list` + `git push
        // --delete` per branch with a 60 s cap each. On the live DB the worst
        // card carries 11 branches: with `gh` logged out or rate-limited an
        // awaited sweep turned a 3-minute queue into a 22-minute one for every
        // OTHER card waiting behind it, and 124 archived cards carry attempt
        // branches that never delivered, so those calls buy nothing at all.
        // Nothing downstream reads its result - the receipt it writes is its own
        // comment - and the two other doors (superseded approval, archive)
        // already call it exactly like this.
        if (proof === true) {
          void sweepRemoteDelivery(projectId, taskId, `Closed by the Topics board: the card landed on main as ${res.commit} from another branch, this one will not land.`,
            { cwd: res.repoPath, landed: res.branch })
            .catch((err) => console.warn(`[land] remote cleanup after a land failed for ${taskId}:`, err));
        }
        if (res.landedNotLive) {
          // Landed on main, but the shared checkout (the live server's cwd) is parked
          // on another branch — so the code is on main yet NOT running. Say it loudly:
          // rebuilding/relaunching off the shared checkout would build the WRONG branch,
          // so we skip those steps and tell the human exactly what to do to activate it.
          svc.addComment({
            taskId, author: "system",
            content: `⚠️ Landato su main ma NON ancora attivo: il server di produzione gira dal checkout fermo su '${res.checkoutBranch}', non su main. Per attivarlo riporta quel checkout su main (git switch main) oppure fai girare il server da un checkout dedicato su main.`,
          });
        } else {
          // THE REBUILD IS FOR THE APP THIS SERVER SERVES, not for every repo
          // with a `client/` folder: a dancerooms land got "Client NON
          // servibile: manca dancerooms/public/index.html" on 2026-09-04.
          const servesFromHere = isServerRepo(res.repoPath);
          if (res.touchedClient && servesFromHere) {
            const t2 = svc.get(taskId, { projectId })?.task;
            if (t2) broadcastToAll({ type: "task:updated", projectId, task: t2 });
            const build = await autoMerge.buildClient(res.repoPath);
            svc.addComment({
              taskId, author: "system",
              // Riuscita ⇒ ricevuta; fallita ⇒ parola, perché chiede un comando
              // all'umano. Stessa regola dei checks: non conta chi scrive, conta
              // se cambia cosa fai.
              kind: build.code === 0 ? "service" : "comment",
              content: build.code === 0
                ? "Client ricostruito: la modifica è visibile (hard refresh se non appare)."
                : build.artifact
                  // A build can exit 0 and leave nothing behind: on 29/08
                  // `public/assets/` stayed empty and `index.html` was gone,
                  // while the card said "rebuilt". When the artifact is still
                  // not there after two attempts the card says so - what is
                  // broken is the thing people see.
                  ? `⚠️ Client NON servibile dopo due build: manca ${build.artifact}. L'app serve da \`public/\`: lancia \`bun run build:client\` e guarda l'errore.`
                  : `Build client fallita (exit ${build.code}). Lancia \`bun run build:client\` a mano.`,
            });
            if (build.code !== 0) console.error("[land] build:client failed for", taskId, build.artifact ?? build.stderr.slice(-2000));
          }
          if (res.touchedNative && servesFromHere) {
            svc.addComment({ taskId, author: "system", content: "Il landing tocca desktop-tauri/: per vederlo nel shell nativo serve un rebuild dell'app (cargo build + relaunch)." });
          }
          if (res.touchedServer && servesFromHere) {
            svc.addComment({ taskId, author: "system", kind: "service", content: "Il landing tocca il server: andrà live al prossimo reload del server (hot-reload watch attivo, o riavvio manuale)." });
          }
        }
      } else if (res.status === "nothing") {
        // "nothing" = the branch has no commits main lacks BY ANCESTRY. That is
        // the exact claim that cost us the `watching` phase — verify it against
        // the repo (content, not ancestry) before destroying anything.
        await reapAfterLand(taskId, "nothing");
        explainNothingToLand(projectId, taskId, "il ramo non porta commit che main non abbia");
      } else if (res.status === "conflict") {
        // La card ESCE da `done`, e la riga di storico deve dire perché. Prima
        // diceva "user → In corso": la stessa riga che scrive un umano quando
        // ritira una consegna a mano — mentre qui l'umano aveva cliccato
        // "Landa su main" e il ritiro è della macchina. `by: "system"` mette la
        // firma giusta, `statusReason` la causa; il commento sotto resta perché
        // porta l'istruzione all'agent, non la sola causa.
        // `actor: "human"` è l'asse dei PERMESSI (nessun agente potrebbe
        // riportare indietro un task chiuso), non quello dell'attribuzione.
        //
        // DUE conflitti diversi, e all'agente servono due istruzioni diverse. Il
        // land prova prima a riportare main DENTRO il ramo vecchio: se è lì che
        // si è rotto, il lavoro non è «pubblicare» ma «riconciliare», e i file
        // in conflitto sono già noti — dirglieli gli risparmia di riscoprirli.
        const rc = res.realignConflict;
        const files = rc?.files ?? [];
        const elenco = files.length > 0 ? files.slice(0, 20).join(", ") : "nessun file elencabile";
        svc.update({
          taskId, actor: "human", by: "system", projectId,
          patch: { status: "in_progress" },
          statusReason: rc
            ? `riportare main nel ramo (indietro di ${rc.behind}) ha fatto conflitto`
            : "il land ha fatto conflitto con main",
        });
        svc.addComment({
          taskId, author: "system",
          content: rc
            ? `Il ramo era indietro di ${rc.behind} commit su main e riportare main dentro il ramo ha fatto conflitto su ${files.length} file: ${elenco}. Non ho landato niente. Rimando all'agent per riconciliare.`
            : "Merge automatico in conflitto con main. Rimando all'agent per risolvere.",
        });
        dispatcher?.resume(
          taskId,
          rc
            ? `Il tuo ramo è indietro di ${rc.behind} commit su main e il land ha provato a riportare main dentro il ramo: ha fatto CONFLITTO su questi file: ${elenco}. Nel tuo worktree fai \`git merge main\`, risolvi quei file (non ce ne sono altri: il merge è stato annullato, quindi riparti da zero), committa la fusione, poi rimetti in review con update_task(status="review"). Il commit di consegna resta un antenato del ramo, quindi il land ripartirà da solo dalla punta. Resta vietato toccare main: niente push, niente merge verso main.`
            : 'Il merge automatico del tuo branch su main è andato in conflitto. Rifai la BASE del tuo ramo sul main aggiornato (`git rebase main`: il tronco è il main LOCALE, perché è lì che il land fonde, e il land ci porta dentro `origin/main` da solo prima di toccare il tuo ramo), NON un merge di main dentro il ramo: risolvi i conflitti durante la rebase, ricommitta, poi rimetti in review con update_task(status="review"). Resta vietato toccare main: niente push, niente merge verso main.',
        ).catch((err) => console.warn(`[Tasks] resume after merge-conflict failed for ${taskId}:`, err));
      } else if (res.status === "skipped") {
        svc.addComment({ taskId, author: "system", content: `⚠️ Land NON riuscito: ${res.reason}. Il branch del task NON è su main. Risolvi e rilancia "Landa su main".` });
        // Il thread lo diceva onestamente e lo STATO diceva il contrario: la card
        // restava in Done col codice fuori da main, cioè nell'unica colonna che
        // nessuno riapre — e il GC dei worktree può potare quel ramo. Misurato
        // l'11/08 su `2e6964cb`. Ora un land fallito ritira la card, con la
        // causa nella riga di storico; l'unico `skipped` che la lascia chiusa è
        // «non c'era niente da atterrare».
        const cur = svc.get(taskId, { projectId })?.task;
        // The delivery commit decides whether a missing branch is a loss or a
        // no-op (see `landFallout`): an analysis card whose branch was reaped
        // after a "nothing to land" must be closable.
        const fall = landFallout(res.code, { deliveryCommit: cur ? (cur.deliveryCommit ?? null) : undefined });
        // Da `done` la card si RITIRA; da `review` non si è mai mossa (il land
        // non approva più prima di atterrare) e ci resta — tranne dove il
        // fallout la manda dall'agente, che è l'unico posto in cui c'è qualcosa
        // da fare. `no-branch` (`fall.status === null`) non è un fallimento:
        // non c'era niente da atterrare, e la card si accetta.
        if (!fall.status) {
          explainNothingToLand(projectId, taskId, "non c'era nessun ramo da atterrare");
        } else if (cur && (cur.status === "done" || cur.status === "review") && cur.status !== fall.status) {
          try {
            // `actor: "human"` è l'asse dei PERMESSI (nessun agente riporta
            // indietro un task chiuso); `by: "system"` è la firma vera, perché
            // a ritirarla è la macchina — stessa scelta del ramo `conflict`.
            svc.update({
              taskId, actor: "human", by: "system", projectId,
              patch: { status: fall.status },
              statusReason: fall.reason,
            });
          } catch (err) { console.warn(`[land] impossibile spostare ${taskId} dopo il land fallito:`, err); }
          if (fall.resume) {
            dispatcher?.resume(taskId, fall.resume)
              .catch((err) => console.warn(`[Tasks] resume after failed land for ${taskId}:`, err));
          }
        }
      }
      // ── The outcome is RECORDED now, not reconstructed later ─────────────
      //
      // `landingState` used to be written only by a pass every 30 minutes that,
      // given the delivery commit, tries to INFER whether its content is on
      // main. Two problems: the verdict arrived up to half an hour late (red on
      // work that had just landed), and the inference is wrong. Tried by hand
      // on 108 cards: the reverse patch gives 20 false alarms, the distinctive
      // line 5, and the "NON su main" message in the thread is there on cards
      // that landed fine too, because it is emitted at DELIVERY. The only proof
      // that holds is valid as long as the branch exists, that is, NOW.
      //
      // So here we write what the land HAS SEEN (`merged` = landed, failed =
      // not landed) and mark it witnessed, so the periodic pass skips it
      // instead of overwriting it with its inference. Only where the land does
      // not know (no branch to look at, or "there was nothing to bring over")
      // do we ask the repo.
      // portare») si chiede al repo.
      const verdict: LandingState | "ask" =
        res.status === "merged" ? (proof === true ? (pushFailure ? "unpushed" : "landed") : "unverifiable")
        : res.status === "conflict" ? "unlanded"
        : res.status === "skipped" && res.code !== "no-branch" ? "unlanded"
        : "ask";
      try { await opts?.stampLanding?.(taskId, verdict); } catch { /* la spia non fa fallire un land */ }
      const updated = svc.get(taskId, { projectId })?.task;
      if (updated) broadcastToAll({ type: "task:updated", projectId, task: updated });
      // Hands the outcome back to the queue ticket: GET /land reports it right
      // away, without having to re-read the task through a second GET.
      // `verdict === "ask"` covers the cases where the land does not know (no
      // branch, or the branch was already on main): they map to "skipped" for
      // the MCP caller.
      // `unpushed` did land (on the local main): for the queue it is `landed`,
      // the card carries the defect.
      const ticketOutcome: LandOutcomeResult['outcome'] =
        verdict === "ask" ? "skipped" : verdict === "unpushed" ? "landed" : verdict;
      // The reason is only useful when the merge was refused: it is what the
      // MCP reports directly instead of leaving the caller to open the card's
      // thread.
      const ticketReason: string | null =
        verdict === "unlanded"
          ? (res.status === "conflict"
            ? (res.realignConflict
              ? `il ramo era indietro di ${res.realignConflict.behind} commit e il realign ha fatto conflitto`
              : "il merge ha fatto conflitto con main")
            : res.status === "skipped" ? (res.reason ?? null) : null)
          : res.status === "skipped" && res.code === "no-branch"
            // Never let a caller read an empty reason as "accepted": nothing was landed.
            ? "nessun ramo di consegna: non c'è niente da atterrare e la card NON risulta su main"
            : null;
      return { outcome: ticketOutcome, reason: ticketReason };
    } catch (e) {
      // ── The path that produced "zero comments, zero reason" ────────────────
      //
      // This `catch` covered git, the comments, the worktree pruning and the
      // rebuild, and it covered them with a `console.error`. What whoever looks
      // at the board got was a card in Done with the code on its branch and a
      // thread that says nothing: the very state the "noisy" failed land
      // (`skipped`) learned to avoid, reached through the back door.
      //
      // Now an exception says three things, in the order they are needed: the
      // line in the thread, the `unlanded` verdict on the card, and the
      // withdrawal from Done, because a card closed on work that has not landed
      // is the one the worktree GC may prune. Then it RETHROWS: the queue
      // ticket is the only place where whoever pressed "Landa" can still read
      // how it went.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[land] failed for", taskId, e);
      try {
        svc.addComment({
          taskId, author: "system",
          content: `⚠️ Land NON riuscito (errore interno): ${msg}. Il branch del task NON è su main. Rilancia "Landa su main" quando la causa è risolta.`,
        });
      } catch (err) { console.warn("[land] impossibile commentare l'errore di", taskId, err); }
      try { await opts?.stampLanding?.(taskId, "unlanded"); } catch { /* la spia non fa fallire il resto */ }
      try {
        const cur = svc.get(taskId, { projectId })?.task;
        if (cur && cur.status === "done") {
          // `actor: "human"` è l'asse dei PERMESSI, `by: "system"` la firma vera:
          // stessa scelta dei rami `conflict` e `skipped`.
          svc.update({
            taskId, actor: "human", by: "system", projectId,
            patch: { status: "in_progress" },
            statusReason: "il land è fallito con un errore interno",
          });
        }
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.warn(`[land] impossibile ritirare ${taskId} da done:`, err); }
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  return { runningAttempts, cardTurnIsLive, cutLiveTurn, landings, enqueueLand, enterCiPhase, landDirect, afterDelivery, autoLander, nodeMeter, sweepAutoLand, enqueueLandOnDone, landProof, explainNothingToLand, landTask } satisfies Partial<TasksLate> & Record<string, unknown>;
}
