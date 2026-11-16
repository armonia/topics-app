/**
 * task-dispatcher-usage.ts: token ledger and live turn of a card.
 * 
 * The monotonic usage ledger per task, the live per-turn ticker, the triage
 * markers and the machine-block note shown while a card waits.
 */
import { type Task } from "./tasks";
import { type SessionUsage } from "./transcript-usage";
import { daySpendSentence } from "./dispatch-block-signal";
import { bookSessionCost, type SessionLedger } from "./task-dispatcher-spend-cap";
import { describeTurnEnd, type TurnEndInfo } from "../providers/stop-reason";
import { summarizeToolInput, RESUME_WAIT_OPENINGS } from "./task-dispatcher-support";
import type { DispatcherCtx, FrameMark } from "./task-dispatcher-context";

export function createUsageLedger(ctx: DispatcherCtx) {
  const { deps, floorHeldNoted, liveTurns, usageLedgers, shared } = ctx.core;

  /**
   * Quanto la sessione ha consumato finora, oppure `null` se non si è potuto
   * LEGGERE.
   *
   * La distinzione è l'origine di due guasti, non una raffinatezza: prima
   * questa funzione rispondeva `ZERO_USAGE` sia quando la sessione non aveva
   * consumato niente sia quando il transcript era irraggiungibile (ruotato,
   * riga assente, eccezione), e da lì in poi nessuno dei due casi era più
   * distinguibile. Un ancoraggio preso su uno zero FINTO manda l'offset a 0 su
   * una base che quei token li contiene già — 80.000 al posto di 40.000,
   * misurato dall'avversario. `null` è la sola risposta onesta, e chi la riceve
   * fa l'unica cosa giusta: non muove il numero.
   */
  function sessionUsage(sessionKey: string): SessionUsage | null {
    try {
      const u = deps.getSessionUsage?.(sessionKey);
      return u ?? null;
    } catch { return null; }
  }

  /** Il registro non serve più quando il task esce dalle mani del dispatcher. */
  function forgetUsage(taskId: string): void { usageLedgers.delete(taskId); }

  /**
   * La riga della sessione, creandola se manca. L'ancoraggio nasce QUI e solo
   * qui, da una lettura RIUSCITA: è il punto che rende impossibile ri-ancorare
   * su uno zero finto.
   */
  function usageRow(taskId: string, sessionKey: string, reading: SessionUsage, model?: string | null): SessionLedger | null {
    let ledger = usageLedgers.get(taskId);
    if (!ledger) {
      const t = deps.svc.get(taskId)?.task;
      if (!t) return null;
      ledger = {
        base: t.agentTokens ?? 0,
        baseCacheRead: t.agentCacheReadTokens ?? 0,
        baseCents: t.agentCostCents ?? 0,
        sessions: new Map(),
      };
      usageLedgers.set(taskId, ledger);
    }
    let s = ledger.sessions.get(sessionKey);
    if (!s) {
      s = { offset: reading, tokens: 0, cacheRead: 0, costCents: 0, unpricedCostTokens: 0, model: model ?? taskModel(taskId) };
      ledger.sessions.set(sessionKey, s);
    }
    // The model can arrive after the anchor (from a path that did not hold it).
    // A hole gets filled, nothing gets overwritten: changing it mid-session would
    // re-price backwards tokens already counted at the other rate.
    else if (!s.model && model) s.model = model;
    return s;
  }

  /** The model written on the card: the fallback when the path does not carry one. */
  function taskModel(taskId: string): string | null {
    try { return deps.svc.get(taskId)?.task.model ?? null; } catch { return null; }
  }

  /**
   * Aggancia la sessione all'INIZIO del turno e torna la lettura di partenza.
   *
   * L'ancoraggio va preso qui e non alla prima scrittura: se nascesse a fine
   * turno, l'offset sarebbe la lettura di adesso e il turno appena consumato
   * varrebbe zero — il conto resterebbe fermo per sempre. È lo stesso momento
   * in cui il vecchio codice prendeva `usage0`, e la sola differenza è che
   * adesso quel punto SOPRAVVIVE al turno.
   */
  function anchorUsage(taskId: string, sessionKey: string, model?: string | null): SessionUsage | null {
    if (!sessionKey) return null;
    try {
      const reading = sessionUsage(sessionKey);
      if (!reading) return null;
      usageRow(taskId, sessionKey, reading, model);
      return reading;
    } catch { return null; }
  }

  /**
   * Porta il conto del task al totale che si sa calcolare adesso. Non somma un
   * delta: ricalcola l'assoluto e lo passa al pavimento `MAX`, quindi chiamarla
   * due volte non conta due volte, e non chiamarla affatto per un turno non
   * perde quel turno — lo recupera la chiamata dopo.
   */
  function bookUsageFloor(taskId: string, sessionKey: string, model?: string | null): void {
    if (!sessionKey) return;
    try {
      const reading = sessionUsage(sessionKey);
      if (!reading) return;                       // non si sa: non si muove niente
      const s = usageRow(taskId, sessionKey, reading, model);
      if (!s) return;
      s.tokens = Math.max(s.tokens, reading.billableTokens - s.offset.billableTokens);
      s.cacheRead = Math.max(s.cacheRead, reading.cacheReadTokens - s.offset.cacheReadTokens);
      bookSessionCost(s, reading);
      const ledger = usageLedgers.get(taskId)!;
      let tokens = ledger.base;
      let cacheRead = ledger.baseCacheRead;
      let costCents = ledger.baseCents;
      let unpriced = 0;
      for (const row of ledger.sessions.values()) {
        tokens += row.tokens;
        cacheRead += row.cacheRead;
        costCents += row.costCents;
        unpriced += row.unpricedCostTokens;
      }
      ctx.queue.emit(deps.svc.raiseAgentUsage({ taskId, tokens, cacheReadTokens: cacheRead, costCents, unpricedCostTokens: unpriced }));
    } catch { /* metrics never break the loop */ }
  }

  /**
   * Il tempo del turno, che è l'unica metà additiva.
   *
   * Il wall-clock è di CHI HA POSSEDUTO il turno e non si ricava da nessuna
   * lettura di sessione: un run zombie porta i token (li ha bruciati), non
   * l'attesa.
   */
  function recordTurnMs(taskId: string, t0: number): void {
    try {
      ctx.queue.emit(deps.svc.recordAgentUsage({ taskId, addMs: Date.now() - t0, addTokens: 0, addCacheReadTokens: 0 }));
    } catch { /* metrics never break the loop */ }
  }

  /**
   * I segni dell'agente sulla card: i suoi commenti e i suoi sottotask.
   *
   * Gli eventi di stato e le note di servizio NON contano: le scrive il
   * dispatcher stesso («todo→in_progress», «Nuovo worktree»), e conteggiarle
   * spegnerebbe il chip prima ancora che l'agente abbia letto la card.
   */
  function framingSnapshot(taskId: string): FrameMark | null {
    try {
      const row = deps.svc.get(taskId);
      if (!row) return null;
      const words = (row.comments ?? []).filter(
        (c) => c.author !== "system" && (c.kind ?? "comment") === "comment",
      ).length;
      return { text: row.task.text, priorityAuto: row.task.priorityAuto, marks: words + (row.children ?? []).length };
    } catch { return null; }
  }

  /** Vero finché la card è ancora quella di partenza, segni compresi. */
  function stillTriaging(taskId: string, from: FrameMark): boolean {
    const now = framingSnapshot(taskId);
    // Illeggibile: non si cambia idea su una lettura mancata (stessa regola di
    // `sessionUsage`, per la stessa ragione).
    if (!now) return true;
    return now.text === from.text && now.priorityAuto === from.priorityAuto && now.marks <= from.marks;
  }

  function broadcastLiveUsage(): void {
    for (const [taskId, lt] of liveTurns) {
      let liveTokens = lt.baseTokens;
      // Senza l'ancoraggio del turno o senza lettura, l'anteprima resta al
      // valore di partenza: un numero inventato dal vivo si vede.
      try {
        const now = sessionUsage(lt.sessionKey);
        if (now && lt.usage0) liveTokens = lt.baseTokens + Math.max(0, now.billableTokens - lt.usage0.billableTokens);
      } catch { /* keep base */ }
      if (lt.triage && lt.frame && !stillTriaging(taskId, lt.frame)) lt.triage = false;
      try {
        deps.broadcast({
          type: "task:usage-live", projectId: lt.projectId, taskId,
          turnStartedAt: lt.turnStartedAt, baseMs: lt.baseMs, liveTokens, model: lt.model,
          triage: lt.triage,
          lastTool: liveTool(lt.sessionKey),
        });
      } catch { /* best-effort */ }
    }
  }

  /** The running tool of a session as the card prints it, or `null`. */
  function liveTool(sessionKey: string): { name: string; input: string | null; since: number } | null {
    try {
      const a = deps.sessionActivity?.(sessionKey);
      if (!a || !a.name) return null;
      return { name: a.name, input: summarizeToolInput(a.name, a.input), since: a.since };
    } catch { return null; }
  }

  /**
   * The wait before a retry, told to the card as it happens.
   *
   * On the turn-died-and-I-retry branch nothing in `dispatch_state` moves: the
   * chip stays `working` and the card's stopwatch keeps running on a session
   * that is not answering. During a provider outage that is every stalled
   * card saying «sto lavorando», and the reason (a `service` note) never
   * reaches the card. The wait is transient by construction (a timer in this
   * process), so it rides the transient event, like `awaiting-human`: `at` is
   * when the retry fires, and the card counts down to it.
   */
  function broadcastRetryWait(task: Task, wait: { at: number; attempt: number; cap: number; free: boolean; end: TurnEndInfo }): void {
    try {
      deps.broadcast({
        type: "task:usage-live", projectId: task.projectId, taskId: task.id,
        turnStartedAt: Date.now(), baseMs: task.agentMs ?? 0, liveTokens: task.agentTokens ?? 0,
        model: task.model ?? null,
        retry: {
          at: wait.at, attempt: wait.attempt, cap: wait.cap, free: wait.free,
          reason: describeTurnEnd(wait.end), detail: wait.end.detail ?? null,
        },
      });
    } catch { /* best-effort */ }
  }

  function currentMachineBlock(): { key: string; reason: string } | null {
    const floor = ctx.admission.admissionVerdictNow();
    if (floor.reason) return { key: `resources:${floor.kind}`, reason: floor.reason };
    const day = ctx.admission.spendBrake.dayBlock();
    if (day) return { key: "spend", reason: daySpendSentence(day) };
    const pressure = ctx.admission.pressureBlock();
    return pressure ? { key: "pressure", reason: pressure } : null;
  }

  function noteCurrentMachineBlock(task: Task, block: { key: string; reason: string }): void {
    if (floorHeldNoted.get(task.id) === block.key) return;
    floorHeldNoted.set(task.id, block.key);
    ctx.hold.queueChip(task);
    try {
      deps.svc.addComment({
        taskId: task.id,
        author: "system",
        kind: "service",
        content: block.reason,
        replaces: [...RESUME_WAIT_OPENINGS],
        once: true,
      });
    } catch { /* the task may have moved */ }
  }

  function startLiveTurn(task: Task, sessionKey: string, t0: number, usage0: SessionUsage | null, model: string | null): void {
    const frame = (task.agentMs ?? 0) === 0 ? framingSnapshot(task.id) : null;
    liveTurns.set(task.id, {
      projectId: task.projectId, sessionKey, turnStartedAt: t0,
      baseMs: task.agentMs ?? 0, baseTokens: task.agentTokens ?? 0, usage0, model,
      triage: frame !== null, frame,
    });
    if (!shared.usageTicker) shared.usageTicker = setInterval(broadcastLiveUsage, deps.usageTickMs ?? 4000);
    broadcastLiveUsage(); // paint immediately, don't wait a full interval
  }

  function endLiveTurn(taskId: string): void {
    const lt = liveTurns.get(taskId);
    liveTurns.delete(taskId);
    if (liveTurns.size === 0 && shared.usageTicker) { clearInterval(shared.usageTicker); shared.usageTicker = null; }
    // The card drops its live chip on the NEXT `task:updated` whose chip is not
    // `working` — and a turn that dies and is retried never sends one: the chip
    // stays `working` by design. So the end is told here, on the same event,
    // or the stopwatch ticks on over a session that is not answering.
    if (!lt) return;
    try {
      deps.broadcast({
        type: "task:usage-live", projectId: lt.projectId, taskId,
        turnStartedAt: lt.turnStartedAt, baseMs: lt.baseMs, liveTokens: lt.baseTokens, model: lt.model,
        ended: true,
      });
    } catch { /* best-effort */ }
  }
  return { anchorUsage, bookUsageFloor, broadcastRetryWait, currentMachineBlock, endLiveTurn, forgetUsage, noteCurrentMachineBlock, recordTurnMs, sessionUsage, startLiveTurn };
}
