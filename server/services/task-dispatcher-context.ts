/**
 * Shared context of the task dispatcher: the members every extracted part
 * (task-dispatcher-*.ts) publishes, merged into one object so a part can call a
 * function owned by another without importing it (the parts call each other in
 * both directions). It is filled once, in order, by createTaskDispatcher.
 */
import { type SessionUsage } from "./transcript-usage";
import { type SessionLedger } from "./task-dispatcher-spend-cap";
import { type NodeSlot } from "./task-dispatcher-remote-node";
import type { createDispatcherCore } from "./task-dispatcher-core";
import type { createAdmission } from "./task-dispatcher-admission";
import type { createProviderHold } from "./task-dispatcher-hold";
import type { createRunTracking } from "./task-dispatcher-runs";
import type { createOverflow } from "./task-dispatcher-overflow";
import type { createQueueSignals } from "./task-dispatcher-queue";
import type { createUsageLedger } from "./task-dispatcher-usage";
import type { createKickoff } from "./task-dispatcher-kickoff";
import type { createLaunch } from "./task-dispatcher-launch";
import type { createFanOut } from "./task-dispatcher-fanout";
import type { createRest } from "./task-dispatcher-rest";

/**
 * One in-flight run: a turn being set up, running, or winding down.
 *
 * `runId` exists because a run can now be BURIED by the liveness net while its
 * promise is still pending (a dead child whose stream never closed). The zombie
 * eventually settles — minutes later, on the wall-clock timeout — and must not
 * then run the end-of-turn accounting a second time nor delete the slot of the
 * NEW run that replaced it. Every owner checks its own id before touching
 * anything: identity, not mere presence.
 */
export interface RunSlot {
  runId: number;
  /** Empty during setup (worktree/topic creation): nothing to probe yet. */
  sessionKey: string;
  /** When the session was bound — the liveness grace counts from here. */
  sessionAt: number;
  /** Consecutive sweeps that found the process dead (hysteresis, see LIVENESS_DEAD_SWEEPS). */
  deadSweeps: number;
  /** Set only on a REMOTE slot: the run this card is riding on a node. */
  node?: NodeSlot;
}

// ── Il registro dei token: assoluto, monotono, per SESSIONE ────────────────
//
// Un task può bruciare token su più sessioni (il fan-out ne apre N, un
// retry ne apre un'altra) e ogni sessione ha il suo contatore, che parte da
// dove era quando questo task se l'è presa. Il registro tiene UNA riga per
// sessione: l'ancoraggio (la lettura al primo aggancio) e il massimo consumo
// visto da allora. Il totale del task è la somma delle righe più la base,
// cioè quello che il task aveva in tabella prima che il registro esistesse.
//
// Perché per sessione e non per task: con un solo slot, cambiare sessione
// RICREA l'ancoraggio, e uno zombie della sessione vecchia che si chiude
// durante un turno vivo lo sposta sotto i piedi di chi sta lavorando —
// 40.000 al posto di 90.000, misurato. Con una riga per sessione, ogni
// contatore si muove solo per conto proprio e solo verso l'alto.
//
// THE CENTS travel on the same row as the tokens, and the row itself
// (`SessionLedger`) plus the pricing of one session live in
// `task-dispatcher-spend-cap.ts`.
export interface TaskLedger { base: number; baseCacheRead: number; baseCents: number; sessions: Map<string, SessionLedger>; }

// ── Live per-turn usage (board card ticker) ──────────────────────────────
// recordUsage books the FINAL agent_ms/agent_tokens only at turn END. While a
// turn runs we broadcast a light preview every few seconds so the card shows,
// LIVE, the model + tokens-so-far + EXECUTION time-so-far. The time is
// execution-only by construction: `baseMs` is the accumulated agent_ms from
// PRIOR turns and the client adds only (now − turnStartedAt) for the CURRENT
// turn — the gaps between turns (queued / parked / asleep) are never counted.
// `task:usage-live` is transient (never persisted); the card falls back to the
// static agent_ms/agent_tokens chip the moment the turn ends.
export interface LiveTurn { projectId: string; sessionKey: string; turnStartedAt: number; baseMs: number; baseTokens: number; usage0: SessionUsage | null; model: string | null; triage: boolean; frame: FrameMark | null; }

// ── Il TRIAGE, cioè i primi minuti in cui non si vede niente ──────────────
//
// Il primo turno di un agente non comincia dal lavoro: comincia
// dall'inquadrarlo. Legge la card, si fa un'idea, riscrive il titolo grezzo,
// giudica la priorità che nessuno ha scelto, apre i passi. Per chi guarda la
// board sono minuti in cui la card è identica a com'era — stesso titolo
// buttato giù di fretta, nessun commento — e l'unica cosa che si muove è un
// cronometro. Sembra ferma proprio mentre sta facendo la parte che decide
// come andrà il resto.
//
// COSA CHIUDE IL TRIAGE: il primo SEGNO che l'agente lascia sulla card. Non
// un tempo, non un tetto arbitrario: il titolo riscritto, la priorità
// automatica risolta, il primo commento suo, il primo sottotask. Sono
// esattamente gli atti che il kickoff gli chiede «appena hai inquadrato il
// lavoro», quindi il chip si spegne quando la promessa è mantenuta, non
// quando scade un timer.
//
// SOLO AL PRIMO TURNO (`baseMs === 0`): una ripresa riprende un lavoro già
// inquadrato, e mostrarle «triage» direbbe una cosa falsa.
//
// Non torna mai indietro: una volta spento resta spento per il turno, anche
// se qualcuno rimette a mano il titolo di prima.
export interface FrameMark { text: string; priorityAuto: boolean; marks: number }

export interface DispatcherCtx {
  /** Published by createDispatcherCore. */
  core: ReturnType<typeof createDispatcherCore>;
  /** Published by createAdmission. */
  admission: ReturnType<typeof createAdmission>;
  /** Published by createProviderHold. */
  hold: ReturnType<typeof createProviderHold>;
  /** Published by createRunTracking. */
  runs: ReturnType<typeof createRunTracking>;
  /** Published by createOverflow. */
  overflow: ReturnType<typeof createOverflow>;
  /** Published by createQueueSignals. */
  queue: ReturnType<typeof createQueueSignals>;
  /** Published by createUsageLedger. */
  usage: ReturnType<typeof createUsageLedger>;
  /** Published by createKickoff. */
  kickoff: ReturnType<typeof createKickoff>;
  /** Published by createLaunch. */
  launch: ReturnType<typeof createLaunch>;
  /** Published by createFanOut. */
  fanout: ReturnType<typeof createFanOut>;
  /** Published by createRest. */
  rest: ReturnType<typeof createRest>;
}
