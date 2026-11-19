/**
 * The pooled CLI child as the provider sees it: its shape (`PersistentProcess`),
 * its stdin/signal/kill surface (direct pipes or broker socket), why it was
 * killed, and the read-only rules every clock asks before touching it.
 *
 * Moved out of `claude-code.ts` unchanged: these are types and pure predicates
 * over one process record, with no state of the provider class.
 */

import type { ChildProcess } from "child_process";
import type { Interface } from "readline";
import { childExited } from "../child-exit";
import type { AiBridgeClient } from "../../lib/ai-bridge-client";
import type { AbortReason, StreamHandler } from "../types";
import type { SidechainTracker } from "./sidechain-tracker";
import type { RowTurns } from "./row-turn";
import type { HeldEvent } from "./woken-turn";
import { datedByLastWrite, isBackgroundWorkAlive, type BackgroundWork } from "./background-work";
import type { ApiRetryMark } from "./api-outage";
import { humanHoldReleasedAt } from "../../lib/human-hold-events";
import type { TurnDeadline } from "../../lib/turn-deadline";
import { cancelled } from "../stop-reason";

export const KILL_GRACE_MS = 3_000;                       // 3s between SIGTERM and SIGKILL

/**
 * The stdin/signal/kill surface of a session — the ONLY child-coupled operations
 * left after the pool state (streamHandler, pending promises, tool state, timers)
 * was made transport-agnostic. Direct mode drives the spawned child's pipes;
 * broker mode drives the daemon over the socket. Everything else (stdout parsing,
 * stderr scan, close handling) is shared via the extracted methods.
 */
export interface SessionIO {
  writeStdin(data: string, mark?: string): void;
  signal(sig: string): void;
  kill(): void;
  /** Direct mode only: settles when the child has exited after `kill()`. */
  exited?(capMs: number): Promise<void>;
}

export function directIO(proc: ChildProcess): SessionIO {
  return {
    writeStdin: (data) => { try { proc.stdin?.write(data); } catch { /* PROCESS_DEAD handled by callers */ } },
    signal: (sig) => { try { proc.kill(sig as NodeJS.Signals); } catch { /* already gone */ } },
    kill: () => {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
    },
    exited: (capMs) => childExited(proc, capMs),
  };
}

export function brokerIO(client: AiBridgeClient, sessionKey: string): SessionIO {
  return {
    writeStdin: (data, mark) => client.write(sessionKey, data, mark),
    signal: (sig) => client.signal(sessionKey, sig),
    kill: () => client.kill(sessionKey),
  };
}

/** Who killed a child on purpose. Travels with the rejection of the send that
 *  was waiting on it, so the chat says what ended the turn. */
export type KillCause = "lifetime" | "idle" | "clear" | "config" | "watchdog" | "stopped-child" | "dead" | "shutdown";
export type ClosedWhy = "silent" | "stuck-turn" | "deadline" | "superseded";
export type BackgroundClosedObserver = (sessionKey: string, tasks: string[], why: ClosedWhy, cron?: true) => void;
export type OwedChange = "autonomy" | "model" | "effort";

export const KILL_CAUSE_TEXT: Record<KillCause, string> = {
  lifetime: "the 2 hour lifetime cap",
  idle: "the idle reaper",
  clear: "/clear",
  config: "a configuration change",
  watchdog: "the turn watchdog",
  "stopped-child": "a stop that did not complete",
  dead: "the cleanup of a dead process",
  shutdown: "the server shutting down",
};

/**
 * The rejection `killProcess` hands to the send waiting on the child. Its
 * message is the marker `sendChatInternal` switches on, like `ABORTED` or
 * `TIMEOUT`; the cause rides along for the text the chat shows.
 */
export class ProcessKilledError extends Error {
  constructor(readonly killCause: KillCause) {
    super("KILLED");
  }
  get notice(): string {
    return `Turn ended: the Claude Code process was stopped by ${KILL_CAUSE_TEXT[this.killCause]}.`;
  }
}

/**
 * How a turn whose child was killed ends on its handler. `/clear` is the person
 * throwing the turn away, the same gesture as Stop: a cancel by the user, so no
 * error notice and no error push. A shutdown says so. Any other kill is the
 * machine giving up on a turn: once the guards spare every turn in flight, the
 * one left is the lifetime cap on a turn silent past the watchdog window, a
 * stall. It ends with the cause the route's own watchdog writes, which the
 * resume reads as "the agent stopped answering" and acts on; a bare `onError`
 * carried no cause, so nothing resumed it.
 */
export function endKilledTurn(handler: StreamHandler, err: ProcessKilledError): void {
  if (!handler.onAborted) { handler.onError(err.notice); return; }
  if (err.killCause === "clear") handler.onAborted({ turnEnd: cancelled("user") });
  else if (err.killCause === "shutdown") handler.onAborted({ turnEnd: cancelled("server-shutdown") });
  else handler.onAborted({ turnEnd: cancelled("watchdog", err.notice) });
}

/**
 * A child in the middle of a turn: a stream handler (sent, woken or reattached
 * turn), a send still waiting on it (a turn the route stopped watching while
 * the CLI works on), or a spontaneous turn waiting for its adopter or declined
 * (both flags clear on the turn's own `result`). The one rule for every clock
 * that may kill the child: the lifetime cap, the idle reaper, a config change.
 */
export function turnInFlight(pp: PersistentProcess): boolean {
  return !!pp.streamHandler || !!pp.pendingReject || pp.wokenBuffer != null || pp.declinedTurn === true;
}

/**
 * The CLI is busy with a turn that is not this send's: one it opened by itself
 * (between its `system/init` and its `result`), one waiting for its adopter, or
 * one declined and still running. A message written to stdin now is read by the
 * CLI in the middle of that turn and answered in it, with one `result` for
 * both (CLI 2.1.280): the send waits for the turn's end instead.
 */
export function cliBusyForSend(pp: PersistentProcess, handler: StreamHandler, now = Date.now()): boolean {
  if (pp.streamHandler === handler) return false;
  return cliInOwnTurn(pp) || wakeAboutToStart(pp, now);
}

/** The CLI is running a turn nobody's send wrote: opened by itself, held for its adopter, or declined and still going. */
export function cliInOwnTurn(pp: PersistentProcess): boolean {
  return pp.cliTurnOpen === true || pp.wokenBuffer != null || pp.declinedTurn === true;
}

/** A send with no child to write to yet (`processForTurn`), or parked behind the CLI's own turn (`waitOutCliTurn`). */
export interface WaitingSend {
  handler: StreamHandler;
  cancelled: boolean;
  wake?: () => void;
  /** Parked behind a turn the CLI is running: a Stop stops that turn too. */
  behindCliTurn?: boolean;
}

/**
 * The CLI has queued a turn of its own and its `system/init` has not come yet:
 * a background task reported (init 0.3 to 1.1 s later, recorded) or a cron
 * fired, which the CLI holds until the `result` of the turn before and then
 * starts 11 ms after it (init 182 ms later). A queue drained on that `result`
 * reached stdin in this gap, and the CLI took the message into the turn it was
 * starting. Bounded: a report the CLI folded into a running turn opens no new
 * one, and the send must not wait for it longer than the recorded gap.
 */
function wakeAboutToStart(pp: PersistentProcess, now: number): boolean {
  const at = pp.background?.wakeQueuedAt;
  return at != null && now - at < WAKE_START_GRACE_MS;
}

/** The longest recorded gap between a queued wake and its `system/init` (1.1 s), with margin. */
const WAKE_START_GRACE_MS = 2_000;

/** Past the instant a queued wake stops counting, so the re-read finds it gone. */
export const WAKE_EXPIRY_SLACK_MS = 5;

/** How often a send parked behind the CLI's own turn looks again, besides the wake at the turn's `result`. */
export const CLI_TURN_RECHECK_MS = 250;

/**
 * A replay's background news, dated by the daemon's record of the child's last
 * write. A daemon older than that record (protocol 1, still holding the CLIs
 * of a server deployed before it) cannot date it: the replay's news then counts
 * from the reattach, so a job silent for hours gets two more hours after each
 * restart. Said once per server process, not per attach.
 */
let oldDaemonDeclared = false;
export function dateReplay(pp: PersistentProcess, scan: { lastDataAt?: number; protocol?: number }): void {
  if ((scan.protocol ?? 2) < 2 && !oldDaemonDeclared) {
    oldDaemonDeclared = true;
    console.warn(`[claude-code] the ai-bridge daemon speaks protocol ${scan.protocol}, before lastDataAt: background work found at a reattach is dated from the reattach, not from its last output. Restart the daemon when it holds no live CLI to date it exactly.`);
  }
  if (pp.background && typeof scan.lastDataAt === "number") datedByLastWrite(pp.background, scan.lastDataAt);
}

/** Killing this child would also kill the Agent, Bash or Monitor its last turn left running. */
export function backgroundAlive(pp: PersistentProcess): boolean {
  return isBackgroundWorkAlive(pp.background, Date.now());
}

/**
 * Since when the child counts as quiet: its last event, its last retry of the
 * API, or the moment a person last answered it, whichever is later. The CLI
 * prints nothing while a permission prompt or a question is open, nor while the
 * command just approved runs, and a clock counting from the tool_use that asked
 * killed that command. Nor while it retries the API, and it gives up by itself.
 * Read by the lifetime cap and by the send watchdog.
 */
export function quietSince(pp: PersistentProcess, sessionKey: string): number {
  return Math.max(pp.lastEventAt, pp.lastApiRetry?.at ?? 0, humanHoldReleasedAt(sessionKey) ?? 0);
}

export interface PersistentProcess {
  /** Set in DIRECT mode only (the spawned child); null in broker mode. */
  proc: ChildProcess | null;
  /** stdout line parser — over proc.stdout (direct) or a PassThrough fed by the
   *  broker's `data` frames (broker). null only transiently during construction. */
  readline: Interface | null;
  /** stdin/signal/kill surface — direct child pipes or broker socket RPCs. */
  io: SessionIO;
  /** Resolves when the child is up (broker: spawn ack; direct: immediately).
   *  The first stdin write awaits this so a write never races ahead of spawn. */
  ready: Promise<void>;
  /** The topics sessionKey (also the broker session id). */
  sessionKey: string;
  /** Byte cursor consumed from the broker store (for reattach). Direct: unused. */
  consumedOffset: number;
  /** The re-attach in flight (`resyncStream`): a second caller joins it instead of sending its own. */
  resyncing?: Promise<boolean>;
  /** A gap the lag probe saw: the daemon held bytes past `from` that we had not folded (`probeStreamLag`). */
  lag?: { from: number; seenAt: number; triedAt?: number };
  /** True from a broker spawn until its ack, and for an adopted (`resumed`) child until
   *  `attachLive` lands: `consumedOffset` (0) is not our place in the store yet, so no
   *  resync may start from it. One from 0 replays the child's whole history, and folded
   *  with the live attach's reply it became the new turn's answer (T18, verification). */
  attachPending?: boolean;
  rewindFrom?: number; // the one rewind below `consumedOffset` the reattach asked for, until it lands (`admitFrame`)
  reattachLive?: boolean; // left by a scan cut short: the cursor is inside the history, the next resync is live unless a frame folds first
  exitTail?: Promise<void>; // the tail of a child that exited while we were detached, until it is folded (`closeAfterTail`)
  readopting?: boolean; // `reattach` is still driving this pp: the child may be gone already, its row is not closed yet
  /** True while replaying buffered NDJSON on reattach — suppresses live-only
   *  client side effects (onUserInputRequired) while in-memory state rebuilds. */
  replaySilent?: boolean;
  /** True during reattach's SCAN pass: every handler emission is suppressed
   *  and only the store's tail shape is recorded (see fields below). A broker
   *  store spans the child's LIFETIME — multiple turns — so replaying it
   *  unmuted from 0 both re-streams old turns into the fresh bubble AND lets
   *  an OLD turn's `result` null the handler, misclassifying an open turn as
   *  "completed" (observed live: the adopted turn kept running headless). */
  replayMute?: boolean;
  /** Scan outcome: true when meaningful events follow the last `result` in
   *  the store — i.e. a turn is in flight. */
  replayTailOpen?: boolean;
  /** Scan outcome: the last replayed `result` event (delivered synthetically
   *  through onDone when the turn completed while we were detached). */
  replayLastResult?: unknown;
  /** Scan outcome: consumed-store offset right after the last `result` —
   *  where the LIVE second attach starts so old turns are never re-emitted. */
  replayAfterLastResultOffset?: number;
  /** Scan outcome: where each marked row's own turn lies in the store (`claude/row-turn.ts`). */
  replayRowTurns?: RowTurns;
  /** Offset assoluto appena DOPO l'ultima riga NDJSON piegata. Non è
   *  `consumedOffset`, che si muove a CHUNK e per giunta solo a fold finito:
   *  qui si è precisi alla riga, mentre la riga passa. È ciò che fa ripartire
   *  la fase 2 esattamente dopo il `result`. Vedi `createLineFolder`. */
  lineEndOffset?: number;
  lineStartOffset?: number; // where that line began: a wake's turn starts there (`claude/woken-turn.ts`)
  /** Accumulated stderr tail for the rate-limit / missing-session scan. */
  stderrBuf: string;
  /** Spawn-time facts the stderr scan + reattach need. */
  spawnMeta: { claudeSessionId: string; isNewSession: boolean; forkFrom?: { sessionId: string; atUuid: string } | null };
  /** A forking start's fork is consumed in `chat_forks` (its first `system/init`). `forkFrom` stays: the fork's refusals may come after. */
  forkConsumed?: boolean;
  createdAt: number;
  lastActivity: number;
  alive: boolean;
  /** Set by abort() before it SIGINTs the child, so the subsequent process
   *  exit is recognised as a user-requested stop (a clean end, NOT a crash) —
   *  the CLI exits code 0 on SIGINT, and without this flag onSessionClosed
   *  surfaced it as "⚠️ Process exited with code 0". */
  aborting?: boolean;
  /**
   * Resolved when this child exits. Created by `abort()`: in stream-json mode
   * the CLI does not survive a SIGINT (it prints the stopped turn's tail and
   * exits 0 within a second, measured 24/09 with CLI 2.1.280), so a stopped
   * child is never reused. `processForTurn` waits on this instead, and
   * `handleStreamEvent` drops the tail while it is set.
   */
  stoppedExit?: { done: Promise<void>; resolve: () => void };
  /** Who asked for the abort — "user" (default) or "watchdog" (stream
   *  timeout). Only affects the exit log label so a watchdog kill is never
   *  misread as the human pressing stop. */
  abortReason?: AbortReason;
  /** Set when a `--resume` failed because the session is gone (we've already
   *  forgotten it, next spawn is fresh). The turn can't finish, but it's a
   *  recoverable reset — onSessionClosed surfaces a clear "resend" note instead
   *  of a raw "Process exited with code N". */
  recovering?: boolean;
  /** Current streaming handler (set during sendChat, null otherwise) */
  streamHandler: StreamHandler | null;
  /**
   * Gli eventi di un turno che la CLI ha aperto DA SOLA, tenuti da parte finché
   * non arriva un handler che li possa ricevere.
   *
   * Serve perché fra «la CLI ricomincia a parlare» e «il server ha aperto una
   * riga e registrato un handler» passano un giro di event loop e una INSERT, e
   * in quel buco ci passano i primi eventi del turno. Buttarli per una questione
   * di tempistica sarebbe lo stesso difetto di prima, più piccolo e più
   * difficile da vedere.
   *
   * `null` = non aspettiamo nessuno; un array = c'è un'adozione in volo e questi
   * eventi vanno ripiegati appena arriva l'handler, NELL'ORDINE.
   */
  wokenBuffer?: HeldEvent[] | null;
  /** See `WokenSlot` in `claude/woken-turn.ts`. */
  declinedTurn?: boolean;
  bufferedTurnEnded?: boolean;
  wokenFrom?: number; // see `WokenSlot`
  /** Pending promise resolvers for sendChat */
  pendingResolve: ((result: { runId: string }) => void) | null;
  pendingReject: ((err: Error) => void) | null;
  /** Text already sent from `text_delta` partials, not yet matched by its snapshot. */
  streamedText?: string;
  /** Accumulated full text for onTextDelta */
  fullText: string;
  /** The command the message of this turn invokes (`/output-style` → `output-style`), or null. */
  commandTurn?: string | null;
  /** The `<synthetic>` text of a command turn, held until its `result` says whose it is (CMDUI-04). */
  syntheticHeld?: string;
  /** `/compact`'s outcome as the CLI reported it in this turn (`system/status`). */
  commandOutcome?: { ok: boolean; error?: string };
  /** Tool calls announced but not yet resulted. */
  activeToolCalls: Set<string>;
  /** Tool calls that have already had their result emitted — the Claude CLI
   *  re-emits them on every cumulative `assistant` snapshot, so we need a
   *  set to skip duplicates and prevent push-without-dedup downstream. */
  settledToolCalls?: Set<string>;
  /** I `message.id` delle chiamate API già FATTURATE in questo turno.
   *
   *  Stessa trappola di `settledToolCalls`, sull'altra grandezza: la CLI emette
   *  un evento `assistant` per BLOCCO di contenuto e ognuno ripete la stessa
   *  `message.usage`. `onCallUsage` accumula, quindi senza questo Set un turno
   *  con 24 eventi su 4 chiamate fatturava 4.893.590 token invece di 925.774
   *  (5,29×) e $22,80 invece di $3,66 — numeri misurati sul topic dec44329. */
  billedCallIds?: Set<string>;
  /** In-flight tool inputs from `--include-partial-messages` stream_events,
   *  keyed by content-block index: id/name captured at content_block_start,
   *  `buf` accumulates input_json_delta.partial_json until block stop.
   *  `lastEmitAt`/`emittedPrimary` throttle the provisional filename/command
   *  emit + timer keep-alive during a long input stream. */
  streamingToolInputs?: Map<number, { id: string; name: string; buf: string; lastEmitAt?: number; emittedPrimary?: string }>;
  /** Tool ids whose COMPLETE input has been delivered (onToolArgsUpdate fired
   *  or announced directly with full args). Keeps the late-args path
   *  idempotent across block stop + every cumulative snapshot re-emission. */
  argsFinalized?: Set<string>;
  /** Content-block indexes of the reasoning blocks open right now (partial
   *  stream_events), so the block stop can close the right one. */
  streamingThinking?: Set<number>;
  /** Le chiamate al tool `Skill`, per nome. Serve a riconoscere, quando arriva
   *  il loro `tool_result`, che il prossimo testo iniettato dalla CLI è il
   *  corpo di QUELLA skill e non una risposta del modello. */
  skillToolNames?: Map<string, string>;
  /** Le `Skill` che hanno consegnato il risultato e aspettano il loro corpo,
   *  in ordine di arrivo. Una coda e non uno slot perché il modello può
   *  chiamarne due nello stesso messaggio. Si svuota al primo evento
   *  `assistant`: se il modello ha ripreso a parlare, nessun corpo sta più
   *  arrivando, e uno slot rimasto armato si mangerebbe il prossimo testo
   *  iniettato (un `<system-reminder>` finito nella card di una skill). */
  pendingSkillToolIds?: string[];
  /** Tool ids that already received their per-action usage attribution
   *  (`onToolUsage`). The CLI's `assistant` events are cumulative, so a
   *  tool_use recurs on later snapshots; this set makes the attribution
   *  exactly-once — the FIRST call whose snapshot carried it is the call that
   *  decided it, and no action inherits an earlier action's cost. */
  attributedToolCalls?: Set<string>;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Tetto di vita del figlio. Non è un `setTimeout` nudo ma un
   * `armTurnDeadline`, perché deve saper stare fermo mentre una domanda è a
   * schermo: si spegne con `.clear()`, non con `clearTimeout`.
   */
  lifetimeTimer: TurnDeadline | null;
  /**
   * Per-stream heartbeat interval that re-emits `onSubAgentUpdate` snapshots
   * for any pending Task() parents when no provider event has occurred for
   * ≥ HEARTBEAT_INTERVAL_MS. Prevents the route's stream inactivity timer
   * from firing during long sub-agent tool runs (Bash builds, WebFetch, etc.)
   * where the SDK is silent for minutes by design.
   *
   * Idempotent: emits the LAST KNOWN snapshot, so a client that already
   * rendered the same actions sees no change beyond the keep-alive bump.
   * Cleared on every stream finalization path (done/error/aborted/exit).
   */
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  /**
   * Accorpamento degli aggiornamenti di sub-agent, per parent tool_use_id.
   *
   * Ogni azione di un sub-agent faceva partire tre operazioni O(n) sull'INTERO
   * elenco delle azioni: la copia profonda in `sidechain.snapshot()`, una
   * scrittura su DB del `detail` completo e un broadcast del medesimo. Con il
   * tetto di 200 azioni sono ~20.100 elementi copiati, riscritti e spediti per
   * una sola invocazione di Task() — quadratico in qualcosa che l'utente vede
   * come una lista che si allunga.
   *
   * Il contenuto e' uno SNAPSHOT, non un delta: il renderer collassa per
   * `callId` e mostra sempre l'ultimo stato, quindi i fotogrammi intermedi sono
   * scartabili per costruzione. Qui se ne emette al piu' uno ogni
   * SUBAGENT_COALESCE_MS, con il bordo di CODA — se un aggiornamento viene
   * saltato, un timer garantisce che l'ultimo stato arrivi comunque entro la
   * finestra, invece di restare fermo fino al prossimo evento (o ai 30s del
   * heartbeat).
   */
  subAgentEmit: Map<string, { lastAt: number; timer: ReturnType<typeof setTimeout> | null }>;
  /** Wall-clock time of the last event emitted to the StreamHandler (text,
   *  tool, sub-agent). Used by the heartbeat to decide whether to fire. */
  lastEventAt: number;
  /**
   * Che COSA era l'ultimo evento arrivato (`assistant`, `system/compact_boundary`,
   * `tool_result`…). Non serve al watchdog: serve a chi legge il log quando il
   * watchdog uccide. «Nessuna attività per 30 minuti» non dice se il figlio era
   * piantato o stava compattando — e i due casi vogliono due risposte opposte
   * (uccidere è giusto nel primo, è un turno sano buttato via nel secondo).
   * Misurato il 03/08: 7 turni troncati in un giorno su 5 topic, 4 dei quali con
   * questo messaggio, uno subito dopo un `/compact`.
   */
  lastEventKind?: string;
  /** The CLI's last `system/api_retry` (`claude/api-outage.ts`): the child
   *  working, not silence, for `quietSince`; its last word, for the watchdog. */
  lastApiRetry?: ApiRetryMark;
  /** Which ai-bridge daemon holds this child (`AiBridgeClient.daemonPid`):
   *  missing under another one at a resync is a daemon death, not a child's. */
  daemonPid?: number | null;
  /**
   * A `system/task_notification` arrived and its turn has not ended yet: the
   * next empty `result` with no model turn in it is the notification's answer,
   * not the end of the turn the person is waiting on. See the `noise` branch
   * of `handleStreamEvent`.
   */
  notificationTurnPending?: boolean;
  /** What the CLI last said about the work a closed turn left running (see `claude/background-work.ts`). */
  background?: BackgroundWork;
  /** The re-read at the instant a queued wake stops counting (`armWakeExpiry`), and that instant. */
  wakeExpiryTimer?: ReturnType<typeof setTimeout> | null;
  wakeExpiryAt?: number | null;
  /** A config change this child was too busy to take: the next send that finds it idle, its background work over, respawns it. */
  configStale?: boolean;
  /** The chat was already told this child's background work is closed. */
  backgroundClosedSaid?: boolean;
  /** Config changes owed by a turn in flight, said in the chat if that turn leaves background work. */
  owedChanges?: Set<OwedChange>;
  /** The topic's choices this child was spawned with: a change back to one of them is owed by nobody. */
  spawnedWith?: Record<OwedChange, string | null>;
  /** Scan outcome: the tail is open only because a `system/init` started a turn with nothing after it yet. */
  replayTailInitOnly?: boolean;
  /**
   * The CLI is in a turn: from its live `system/init` (or the first line of a
   * turn it opened by itself) to that turn's `result`, or its exit. Whoever
   * started the turn. Read by `cliBusyForSend` and reported to the turn ledger
   * (`observeCliTurns`).
   */
  cliTurnOpen?: boolean;
  /** Wakes the one send parked behind the CLI's own turn (`waitOutCliTurn`). */
  cliIdleWake?: () => void;
  /** The handler the route registered for a message not written yet (`registerStreamHandler`): it owns no turn until its send writes. */
  preRegistered?: StreamHandler | null;
  /**
   * Set when this process was spawned with `--session-id` because the prior
   * `claude_session_id` was either missing on disk or never existed, but the
   * topics-app DB *does* contain prior user/assistant turns for this
   * sessionKey. The next sendChat will prepend a markdown recap so the model
   * doesn't lose the conversation thread. Cleared after one use.
   */
  needsHistoryReplay: boolean;
  /**
   * Sidechain (Task tool sub-agent) tracker. The Claude Code CLI emits
   * sub-agent events with a `parent_tool_use_id` field on the same NDJSON
   * stream as the parent. We intercept those events and aggregate them into
   * the parent Task call's `detail.sub_agent.actions[]` log instead of
   * letting them be silently routed to the parent agent's text/tool
   * handlers. One tracker per process — sub-agents are scoped to a single
   * topic/session so this is the right granularity.
   */
  sidechain: SidechainTracker;
  /**
   * Tool calls that asked the user for input via `AskUserQuestion` /
   * MCP elicitation. Keyed by `tool_use.id`. Each entry pins the
   * sessionKey (for cross-stream lookup from the route handler) and the
   * resolved schema so we can rebuild the WS broadcast if a client
   * reconnects mid-pause. The heartbeat treats these the same as a
   * running Task() parent — keeps the soft timer suspended while we
   * wait for the human.
   *
   * The provider is the source of truth; the route handler queries this
   * map via `resumeWithToolResponse` to validate that a submission
   * matches a still-pending request, then drops the entry once the
   * `tool_result` line is written to stdin.
   */
  pendingInputs: Map<string, { sessionKey: string; schema: import("../../types").UserInputSchema; awaitingSince: number }>;
}
