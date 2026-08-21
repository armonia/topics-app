/**
 * Pure state-derivation primitives for Claude Code sessions.
 *
 * No IO, no DB, no logging. Every function is deterministic and unit-testable
 * with `bun:test`. The service layer in `claude-session-tracker.ts` composes
 * these with persistence + broadcast.
 *
 * Phase semantics: see openspec/changes/claude-session-tracker/design.md.
 */

// Fase e forma dell'errore stanno in `shared/types.ts`: il client li legge
// dal broadcast `session:state` e non deve riscriverne l'elenco.
export type { ClaudeSessionPhase, ClaudeSessionError } from "../../shared/types";
import type { ClaudeSessionPhase, ClaudeSessionError } from "../../shared/types";

export const ALL_PHASES: ReadonlyArray<ClaudeSessionPhase> = [
  'starting', 'running', 'tool-running', 'awaiting-user',
  'awaiting-approval', 'paused', 'completed', 'error', 'dormant', 'watching',
];

const TERMINAL_PHASES = new Set<ClaudeSessionPhase>(['completed', 'error']);
const ACTIVE_PHASES = new Set<ClaudeSessionPhase>([
  'starting', 'running', 'tool-running', 'awaiting-user', 'awaiting-approval', 'watching',
]);

export function isTerminalPhase(p: ClaudeSessionPhase): boolean {
  return TERMINAL_PHASES.has(p);
}

export function isActivePhase(p: ClaudeSessionPhase): boolean {
  return ACTIVE_PHASES.has(p);
}

/**
 * Phases the client renders as an in-progress "working" spinner (loading dots).
 * A session frozen in one of these AFTER its turn's process has died — the
 * ai-bridge child was killed by a server outage — is a PHANTOM: the persisted
 * phase never returns to a terminal state and the UI spins forever. The reaper
 * only clears it after `abandonedTimeoutMs` (~an hour); the boot reconcile
 * clears it immediately once the broker CONFIRMS the child is gone.
 *
 * NOT included: `awaiting-user`/`awaiting-approval`/`paused` are legitimate
 * resting/attention states (they can last as long as the human is away), not
 * spinners — demoting them on a broker miss would erase a real "your turn".
 */
export const BUSY_SPINNER_PHASES: ReadonlyArray<ClaudeSessionPhase> = [
  'starting', 'running', 'tool-running',
];

const BUSY_SPINNER_SET = new Set<ClaudeSessionPhase>(BUSY_SPINNER_PHASES);

export function isBusySpinnerPhase(p: ClaudeSessionPhase): boolean {
  return BUSY_SPINNER_SET.has(p);
}

/**
 * Le fasi che sono LAVORO IN CORSO, per l'unico scopo di datare l'inizio del
 * turno (`turnStartedAt`). Sono le stesse tre che il client tratta come
 * "working" (`ACTIVE_CLAUDE_PHASES` in client/src/state/signals.ts): un cronometro
 * che parte quando la UI mostra lo spinner e si ferma quando lo toglie.
 *
 * `starting` è ESCLUSA di proposito, ed è la differenza con
 * `BUSY_SPINNER_PHASES`: una sessione appena aperta ci resta finché l'umano non
 * scrive, che possono essere ore. Farla partire da lì darebbe «sta lavorando da
 * 3 ore» a un turno cominciato dieci secondi fa.
 */
const TURN_WORK_PHASES = new Set<ClaudeSessionPhase>(['running', 'tool-running', 'watching']);

export function isTurnWorkPhase(p: ClaudeSessionPhase): boolean {
  return TURN_WORK_PHASES.has(p);
}

// Le tre forme dello stato vivono in shared/types.ts: il payload di
// `session:state` è una COPIA INTEGRALE di `ClaudeSessionState`, quindi il
// client legge lo stesso tipo invece di ritagliarsene una versione ridotta.
// Ri-esportate coi nomi storici — i call site del server non cambiano.
export type {
  ClaudeSessionPendingApproval as PendingApproval,
  ClaudeSessionActiveTool as ActiveTool,
  ClaudeSessionState,
} from "../../shared/types";
import type {
  ClaudeSessionPendingApproval as PendingApproval,
  ClaudeSessionActiveTool as ActiveTool,
  ClaudeSessionState,
} from "../../shared/types";

/**
 * A Claude Code hook payload. Only the fields we read are typed; the rest is
 * tolerated. Hook scripts post `{ hook_event_name, session_id, ... }`.
 */
export interface HookPayload {
  hook_event_name: HookEventName;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  timestamp?: number;
  // PreToolUse / PostToolUse:
  tool_name?: string;
  tool_input?: unknown;
  // Notification:
  title?: string;
  message?: string;
  permission_request?: {
    kind?: string;
    prompt?: string;
  };
  // Allow forward-compat unknown fields.
  [key: string]: unknown;
}

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'MonitorArmed'
  | 'MonitorClosed';

export const KNOWN_HOOK_EVENTS: ReadonlyArray<HookEventName> = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'MonitorArmed', 'MonitorClosed',
];

export function isKnownHookEvent(name: string): name is HookEventName {
  return (KNOWN_HOOK_EVENTS as ReadonlyArray<string>).includes(name);
}

/**
 * Built-in tools whose PreToolUse means "Claude is now BLOCKED on a human
 * answer", not "Claude is doing work". They must drive the amber act-now tier
 * (awaiting-approval), never the working spinner (tool-running):
 *
 *   - AskUserQuestion — the model is asking the user a multiple-choice question
 *     and cannot continue until it's answered. Claude Code fires ONLY a
 *     PreToolUse for this (no Notification hook, unlike a Bash/Edit permission
 *     prompt), so this PreToolUse is our sole signal — if we let it fall through
 *     to tool-running the tab shows a spinner while Claude actually waits on you.
 *   - ExitPlanMode — the model finished planning and is requesting approval of
 *     the plan before it may act. Same "waiting on you" semantics.
 *
 * PostToolUse for either arrives once the user has answered/approved and takes
 * us back to running (see the PostToolUse case).
 */
const HUMAN_INPUT_TOOLS = new Set<string>(['AskUserQuestion', 'ExitPlanMode']);

/**
 * I tool che ARMANO UN'ATTESA: partono e non finiscono con la loro chiamata.
 *
 * `Monitor` torna subito — la sua risposta è la ricevuta dell'armamento
 * («Monitor started, task …») — e poi il turno chiude. Ma la sessione non è
 * inattiva: c'è qualcosa che sorveglia un build, e la risposta arriverà come
 * turno NUOVO (il risveglio, `providers/claude/woken-turn.ts`). Senza saperlo,
 * lo `Stop` che segue la spegne ad `awaiting-user` e la chat che sta aspettando
 * si legge uguale a una chat che ha smesso di rispondere.
 *
 * PERCHÉ DA QUI E NON DAGLI HOOK. La fase `watching` esisteva già, accesa da
 * due eventi `MonitorArmed`/`MonitorClosed` che Claude Code NON EMETTE PIÙ:
 * verificato sul binario 2.1.237, la sua lista di eventi hook ne conta 31 e
 * nessuno dei due c'è. Erano quindi una spia cablata a un interruttore staccato,
 * e la fase non si accendeva mai. I due eventi restano riconosciuti (un CLI più
 * vecchio potrebbe mandarli, e ignorarli sarebbe una regressione gratuita), ma
 * il segnale VIVO è il `PreToolUse` di `Monitor`, che arriva sempre.
 */
const WATCH_ARMING_TOOLS = new Set<string>(['Monitor']);

/** Questo tool, partendo, lascia un'attesa aperta dietro di sé? */
export function armsBackgroundWatch(toolName: string | undefined): boolean {
  return !!toolName && WATCH_ARMING_TOOLS.has(toolName);
}

export function isHumanInputTool(toolName: string | undefined): boolean {
  return !!toolName && HUMAN_INPUT_TOOLS.has(toolName);
}

/**
 * Map a human-input tool to the PendingApproval it represents, extracting a
 * best-effort prompt string from its input so the UI can echo what's being
 * asked. Tolerant of missing/odd shapes — we only ever read strings we find.
 * Shared by BOTH signal paths for these tools: the PreToolUse hook and the
 * transcript's tool_use line (whichever lands first must produce the same
 * amber state, so they converge instead of fighting).
 */
function humanInputApproval(toolName: string | undefined, toolInput: unknown, now: number): PendingApproval {
  if (toolName === 'ExitPlanMode') {
    const plan = (toolInput as { plan?: unknown } | undefined)?.plan;
    return {
      kind: 'plan',
      prompt: typeof plan === 'string' && plan.trim() ? plan : 'Approve plan?',
      requestedAt: now,
    };
  }
  // AskUserQuestion — surface the first question's text when present.
  const questions = (toolInput as { questions?: unknown } | undefined)?.questions;
  let prompt = 'Claude is asking a question';
  if (Array.isArray(questions) && questions.length > 0) {
    const q = questions[0] as { question?: unknown } | undefined;
    if (q && typeof q.question === 'string' && q.question.trim()) prompt = q.question;
  }
  return { kind: 'other', prompt, requestedAt: now };
}

/**
 * Apply a hook event to a session state. Returns a *new* state object with
 * `rev` bumped on every accepted transition. If the hook is a no-op for the
 * current phase, returns the input reference unchanged (cheap dedup signal).
 *
 * The caller is responsible for:
 *   - persisting the result,
 *   - broadcasting if `result !== prev`,
 *   - rejecting out-of-order hooks (we trust `now` to be monotonic per call).
 */
export function applyHook(
  prev: ClaudeSessionState,
  hook: HookPayload,
  now: number,
): ClaudeSessionState {
  const base: ClaudeSessionState = {
    ...prev,
    lastHookAt: now,
    updatedAt: now,
  };

  switch (hook.hook_event_name) {
    case 'SessionStart':
      // Re-fire of SessionStart can happen on `--resume`. Reset transient
      // fields but keep cumulative metadata (rev, offset). A fresh/resumed
      // session has no armed monitor yet — clear the flag so a stale one from a
      // prior incarnation can't pin `watching` on the next Stop.
      return transition(base, {
        phase: 'starting',
        pendingApproval: undefined,
        lastTool: undefined,
        error: undefined,
        monitorArmed: false,
        jsonlPath: typeof hook.transcript_path === 'string' ? hook.transcript_path : prev.jsonlPath,
      }, now);

    case 'UserPromptSubmit':
      // Always advances to running and clears any prior approval/tool state.
      // Also clears a stale error: submitting a new prompt is the user
      // resuming after a failure, so the error must not linger on the now-
      // running session (mirrors SessionStart). transition() treats
      // error:undefined as a no-op when there was no error, so rev only bumps
      // when a real error is actually cleared.
      return transition(base, {
        phase: 'running',
        pendingApproval: undefined,
        error: undefined,
        // Leave lastTool unchanged — a PostToolUse may still be in flight.
      }, now);

    case 'PreToolUse': {
      // A tool that asks the human (AskUserQuestion / ExitPlanMode) is NOT work
      // in progress — Claude is blocked on your answer. Route it to the amber
      // act-now tier (awaiting-approval) instead of the working spinner. This is
      // our only signal for these (Claude Code fires no Notification hook for
      // them), so getting it right here is what flips the tab from "sta
      // lavorando" to "tocca a te".
      if (isHumanInputTool(hook.tool_name)) {
        return transition(base, {
          phase: 'awaiting-approval',
          pendingApproval: humanInputApproval(hook.tool_name, hook.tool_input, now),
          // Clear any lingering tool — we're waiting on the user, not running.
          lastTool: undefined,
        }, now);
      }
      const tool: ActiveTool | undefined = hook.tool_name
        ? { name: hook.tool_name, input: hook.tool_input, startedAt: now }
        : undefined;
      return transition(base, {
        phase: 'tool-running',
        lastTool: tool,
        // Un `Monitor` che parte lascia un'ATTESA dietro di sé: si segna qui,
        // perché è l'unico segnale che la CLI manda davvero (vedi
        // `armsBackgroundWatch`). Non tocca la fase — il tool sta partendo, ed è
        // `tool-running` come ogni altro — ma sopravvive fino allo `Stop` di
        // fine turno, che senza questo flag spegnerebbe la sessione ad
        // `awaiting-user` mentre qualcosa sorveglia ancora.
        //
        // Non si SPEGNE mai qui: un secondo tool nello stesso turno non
        // disarma il monitor del primo. Lo spengono `SessionStart`/`SessionEnd`
        // (una sessione nuova non eredita attese) e `MonitorClosed`, quando un
        // CLI abbastanza vecchio da mandarlo lo manda.
        ...(armsBackgroundWatch(hook.tool_name) ? { monitorArmed: true } : {}),
        // Clear any lingering approval: if we were parked at awaiting-approval
        // (a permission was DENIED and Claude moved straight on to a different
        // tool, so no PostToolUse cleared it) the old pendingApproval would
        // otherwise ride along into tool-running as dead state. No surface reads
        // it while tool-running, but keeping it stale is a latent trap.
        pendingApproval: undefined,
      }, now);
    }

    case 'PostToolUse':
      // The user answered / the tool finished → back to work. Handles both the
      // normal tool-running→running return AND the human-input case where the
      // PreToolUse parked us at awaiting-approval (the user just answered
      // AskUserQuestion / approved the plan): clear the pending approval and
      // resume running. If we somehow missed the PreToolUse, leave the phase as
      // it was but still clear the transient tool/approval fields defensively.
      if (prev.phase === 'tool-running' || prev.phase === 'awaiting-approval') {
        return transition(base, {
          phase: 'running',
          lastTool: undefined,
          pendingApproval: undefined,
        }, now);
      }
      return transition(base, {
        phase: prev.phase,
        lastTool: undefined,
      }, now);

    case 'Notification': {
      const isApproval = detectApproval(hook);
      if (!isApproval) {
        // Plain notification — only stamp the last_hook_at, no phase change.
        return base;
      }
      const pa: PendingApproval = {
        kind: normaliseApprovalKind(hook),
        prompt: extractApprovalPrompt(hook),
        requestedAt: now,
      };
      return transition(base, {
        phase: 'awaiting-approval',
        pendingApproval: pa,
      }, now);
    }

    case 'Stop':
      // Turn ended. If a Monitor is still armed, the session is not idle — it's
      // parked WATCHING for a background event, so keep the ring on. Otherwise
      // the turn simply finished → awaiting-user. This is the guard that makes
      // 'watching' survive: the monitor is armed DURING the turn (MonitorArmed),
      // then Stop fires; without consulting the flag, Stop would clobber it.
      return transition(base, {
        phase: prev.monitorArmed ? 'watching' : 'awaiting-user',
        pendingApproval: undefined,
        lastTool: undefined,
      }, now);

    case 'SubagentStop':
      // Subagent completions are recorded but don't move the parent's phase.
      return base;

    case 'MonitorArmed':
      // A Monitor/watch is now active in the background. Remember it (monitorArmed)
      // so the Stop that ends this turn keeps the session in 'watching' instead of
      // dropping to awaiting-user. Do NOT clobber awaiting-approval: a pending
      // permission is a stronger "needs you" signal than a background watch, so
      // only flip the phase to 'watching' when we aren't blocked on the human.
      // 'watching' is semi-active — it shows the ring (unlike resting awaiting-user)
      // without implying Claude is currently producing output. Clears transient
      // tool state as the session is parked.
      if (prev.phase === 'awaiting-approval') {
        return transition(base, { monitorArmed: true }, now);
      }
      return transition(base, {
        phase: 'watching',
        monitorArmed: true,
        pendingApproval: undefined,
        lastTool: undefined,
      }, now);

    case 'MonitorClosed':
      // The Monitor/watch was closed (completed, cancelled, or timed out). Clear
      // the armed flag. If we were WATCHING, the session is now idle → awaiting-user;
      // otherwise the phase already reflects live work (a woken turn), so leave it
      // and just drop the flag.
      if (prev.phase === 'watching') {
        return transition(base, {
          phase: 'awaiting-user',
          monitorArmed: false,
          pendingApproval: undefined,
          lastTool: undefined,
        }, now);
      }
      return transition(base, { monitorArmed: false }, now);

    case 'SessionEnd':
      return transition(base, {
        phase: 'completed',
        monitorArmed: false,
        pendingApproval: undefined,
        lastTool: undefined,
      }, now);

    default:
      // Unknown event — keep advancing last_hook_at without changing phase.
      return base;
  }
}

/**
 * Apply a single parsed JSONL event. Runs in two contexts:
 *   - boot recovery (replay what the hook stream missed while the server was
 *     down), and
 *   - the LIVE tail loop, where the transcript is the only signal for turns
 *     started by non-hook events — a Monitor's task-notification, a background
 *     task completing, a teammate message, any injected prompt. None of those
 *     fire UserPromptSubmit, and a text-only turn fires nothing until Stop, so
 *     without this path a woken session stays parked at `awaiting-user` (a
 *     RESTING phase that also suppresses the client's pty fallback): no
 *     spinner, no aura, no rollup, and no banner on re-park.
 *
 * Causal gate: hooks are push (ms latency), the tail is pull (~1.5s). A line
 * can therefore be READ after a hook that was FIRED after the line was
 * written — e.g. an `assistant` line written just before the `Stop` hook that
 * parked the session. Applying it blind would wrongly revive the session, so
 * an event whose own wall-clock timestamp is strictly OLDER than the last
 * authoritative phase change (`phaseUpdatedAt`) is stale news and a no-op.
 * Events with no timestamp (legacy line shapes) apply ungated, matching the
 * historical boot-replay behaviour. Transitions stamp the EVENT time, not the
 * read time, so lines applied in one batch stay causally ordered among
 * themselves and against later hooks.
 *
 * Only conservative transitions: we never put a session into a phase the
 * hooks alone wouldn't have produced. JSONL gives us a strong "running" /
 * "tool-running" signal but does NOT include permission requests — those only
 * exist as hooks (Notification).
 */
export function applyJsonlEvent(
  prev: ClaudeSessionState,
  event: JsonlEvent,
  now: number,
): ClaudeSessionState {
  // If we're terminal, don't undo it.
  if (TERMINAL_PHASES.has(prev.phase)) return prev;
  // Causal gate — see doc comment above.
  if (event.ts !== undefined && event.ts < prev.phaseUpdatedAt) return prev;
  const at = event.ts ?? now;

  const base: ClaudeSessionState = { ...prev, updatedAt: at };

  switch (event.type) {
    case 'user':
      // A qualifying user-role line (typed prompt, task-notification, teammate
      // message — parseJsonlLine already filtered meta/local-command/compact/
      // interrupt lines into `meta`) means a new turn is in flight → running.
      // Mirrors UserPromptSubmit for typed prompts and is the ONLY signal for
      // injected turns.
      return transition(base, {
        phase: 'running',
        pendingApproval: undefined,
      }, at);

    case 'assistant':
      // The model is literally producing output — a turn is in flight
      // regardless of what we thought (its opening user line may have been
      // gated or missed). Promote to running: from tool-running it means the
      // tool completed and no PostToolUse landed; from a resting phase
      // (awaiting-user / paused / dormant / starting) it is the wake-up
      // evidence itself. Clear transient fields — a stale pendingApproval
      // (paused keeps it for display) is dead once the model demonstrably
      // moved on.
      //
      // EXCEPT awaiting-approval: Claude is parked on a question/permission and
      // the questions are literally on screen — a spinner would lie. The trap
      // is the SAME assistant message that asked: its text blocks land as
      // separate transcript lines with timestamps a breath apart from the
      // PreToolUse hook that set the amber, so the causal gate alone can't be
      // trusted to order them. Only a hook (PostToolUse/UserPromptSubmit), a
      // user line, or the answer's tool_result may resolve the amber state.
      if (prev.phase !== 'running' && prev.phase !== 'awaiting-approval') {
        return transition(base, {
          phase: 'running',
          lastTool: undefined,
          pendingApproval: undefined,
        }, at);
      }
      return base;

    case 'tool_use':
      // A human-input tool (AskUserQuestion / ExitPlanMode) is NOT work in
      // progress — Claude is blocked on your answer. Mirror the PreToolUse
      // hook's special case so BOTH signal paths produce the same amber
      // "tocca a te" state: if the transcript line lands after the hook they
      // converge (same phase, no fight); if the hooks are silent the tail
      // alone still raises the amber instead of a lying spinner.
      if (isHumanInputTool(event.name)) {
        return transition(base, {
          phase: 'awaiting-approval',
          pendingApproval: humanInputApproval(event.name, event.input, at),
          lastTool: undefined,
        }, at);
      }
      return transition(base, {
        phase: 'tool-running',
        lastTool: { name: event.name || 'unknown', input: event.input, startedAt: at },
      }, at);

    case 'tool_result':
      // Mirrors PostToolUse: the tool finished — or, from awaiting-approval,
      // the user just ANSWERED the question / approved the plan (the answer
      // arrives as the human-input tool's tool_result) → back to work.
      if (prev.phase === 'tool-running' || prev.phase === 'awaiting-approval') {
        return transition(base, { phase: 'running', lastTool: undefined, pendingApproval: undefined }, at);
      }
      return base;

    default:
      return base;
  }
}

/**
 * Reaper rules applied to a single session. Returns a transitioned state if
 * the session is stale, else the original ref.
 *
 * `now` is supplied so tests can pin time.
 */
export function reapStaleSession(
  prev: ClaudeSessionState,
  now: number,
  config: ReaperConfig = DEFAULT_REAPER_CONFIG,
  /**
   * Milliseconds since this session's PTY last produced (non-cosmetic) output,
   * or null when there is no PTY signal (a chat/repo session, or a terminal
   * session we have no activity record for). Drives the `running` rule: a phase
   * pinned at `running` is only "stale" if the PTY has ALSO gone quiet — a
   * genuinely long turn keeps the PTY busy, so it is never reaped. Omitted →
   * treated as null → the `running` rule is a no-op (preserves prior behaviour
   * for non-terminal sessions).
   */
  ptyIdleMs: number | null = null,
): ClaudeSessionState {
  if (TERMINAL_PHASES.has(prev.phase)) return prev;

  const age = now - prev.phaseUpdatedAt;

  switch (prev.phase) {
    case 'tool-running':
      if (age >= config.toolRunningTimeoutMs) {
        return transition({ ...prev, updatedAt: now }, {
          phase: 'running',
          lastTool: undefined,
        }, now);
      }
      return prev;

    case 'running':
      // A session stuck at `running` while its PTY is alive (still in the
      // roster) but SILENT for a long time is a missed `Stop` hook, not work in
      // progress — Claude Code hooks fire unreliably and PreToolUse/PostToolUse
      // were dropped, so nothing else moves it out of `running`. Left alone it
      // pins the loading dots (and the project rollup) forever.
      //
      // Gate strictly on PTY idleness, NOT on `age`: for a live `running`
      // session `age` is just "time since the prompt was submitted", which is
      // large for any long turn and would wrongly reap real work. ptyIdleMs is
      // the honest "nothing is happening" signal. Demote to `dormant` (the
      // client then lets the PTY decide, and there's no false attention badge or
      // completion toast). If the turn was merely silent and resumes, the PTY's
      // next frame revives it via reviveOnPtyActivity → running.
      if (ptyIdleMs != null && ptyIdleMs >= config.runningTimeoutMs) {
        return transition({ ...prev, updatedAt: now }, {
          phase: 'dormant',
          lastTool: undefined,
          pendingApproval: undefined,
        }, now);
      }
      // No PTY signal at all — a headless/chat session (dispatcher tasks run
      // `claude --print` with no PTY) or one whose PTY vanished without the
      // exit signal (bridge died, server crashed). For these, updatedAt is the
      // only life signal we have, and it DOES move while real work happens:
      // every hook and every consumed transcript line advances it (the live
      // tail sweeps ~1.5s). A session claiming `running` whose updatedAt has
      // been frozen for the whole abandoned window is a corpse pinning the
      // active count, not a long turn. Demote to `dormant`, never terminal:
      // the tail still covers dormant sessions, so a merely-quiet one is
      // revived by its next transcript line (or PTY frame) → running.
      if (ptyIdleMs == null && now - prev.updatedAt >= config.abandonedTimeoutMs) {
        return transition({ ...prev, updatedAt: now }, {
          phase: 'dormant',
          lastTool: undefined,
          pendingApproval: undefined,
        }, now);
      }
      return prev;

    case 'awaiting-approval':
      if (age >= config.awaitingApprovalTimeoutMs) {
        return transition({ ...prev, updatedAt: now }, {
          phase: 'paused',
          // Keep pendingApproval so the UI can still display what was being asked.
        }, now);
      }
      return prev;

    case 'starting':
      if (age >= config.startTimeoutMs) {
        return transition({ ...prev, updatedAt: now }, {
          phase: 'error',
          error: { code: 'start-timeout', message: 'Session never produced its first event', failedAt: now },
        }, now);
      }
      return prev;

    default:
      return prev;
  }
}

export interface ReaperConfig {
  toolRunningTimeoutMs: number;
  awaitingApprovalTimeoutMs: number;
  startTimeoutMs: number;
  /** Max PTY-idle time a `running` session may accrue before it's treated as a
   *  missed Stop hook and demoted to dormant. Generous because it's gated on
   *  real PTY silence — only a session producing NO output for this long. */
  runningTimeoutMs: number;
  /** Max time a `running` session with NO PTY signal (ptyIdleMs null: headless
   *  task, chat session, PTY vanished with the bridge) may go without ANY life
   *  signal — no hook, no consumed transcript line (both advance updatedAt) —
   *  before it's treated as abandoned and demoted to dormant. Very generous:
   *  a genuinely working session moves updatedAt every few seconds. */
  abandonedTimeoutMs: number;
}

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  toolRunningTimeoutMs: 10 * 60 * 1000,
  awaitingApprovalTimeoutMs: 10 * 60 * 1000,
  startTimeoutMs: 5 * 60 * 1000,
  runningTimeoutMs: 10 * 60 * 1000,
  abandonedTimeoutMs: 60 * 60 * 1000,
};

/**
 * Mark a session as errored. Used by the PTY-exit signal path; not derivable
 * from hooks alone (the whole point of "crash" is the hook never arrived).
 */
export function markPtyCrash(
  prev: ClaudeSessionState,
  exitCode: number,
  now: number,
): ClaudeSessionState {
  if (TERMINAL_PHASES.has(prev.phase)) return prev;
  return transition({ ...prev, updatedAt: now }, {
    phase: 'error',
    error: { code: 'pty-crashed', message: `PTY exited with code ${exitCode}`, failedAt: now },
    lastTool: undefined,
    pendingApproval: undefined,
  }, now);
}

/**
 * Mark a session as dormant — its PTY is gone but the claude_session_id is
 * still resumable via `claude --resume`.
 */
export function markDormant(
  prev: ClaudeSessionState,
  now: number,
): ClaudeSessionState {
  if (prev.phase === 'dormant' || TERMINAL_PHASES.has(prev.phase)) return prev;
  return transition({ ...prev, updatedAt: now }, {
    phase: 'dormant',
    lastTool: undefined,
    pendingApproval: undefined,
  }, now);
}

/**
 * Revive a dormant session because its PTY just produced output. This is the
 * counterpart to the `running`-reaper: if the reaper demoted a merely-silent
 * (not finished) turn to `dormant`, the next non-cosmetic PTY frame proves it
 * was still working, so we put it back to `running` and the loading dots return.
 *
 * ONLY revives from `dormant` — never clobbers awaiting-user / awaiting-approval
 * / paused (a TUI repaint there is not a new turn) nor a terminal phase. No-op
 * (returns the input ref) for every other phase, so it's cheap to call on every
 * frame.
 */
export function reviveOnPtyActivity(
  prev: ClaudeSessionState,
  now: number,
): ClaudeSessionState {
  if (prev.phase !== 'dormant') return prev;
  return transition({ ...prev, updatedAt: now }, { phase: 'running' }, now);
}

/**
 * Initial state for a brand-new session.
 */
export function makeInitialState(
  claudeSessionId: string,
  sessionKey: string | null,
  now: number,
  jsonlPath?: string,
): ClaudeSessionState {
  return {
    claudeSessionId,
    sessionKey,
    phase: 'starting',
    phaseUpdatedAt: now,
    jsonlPath,
    jsonlOffset: 0,
    rev: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL parsing
// ─────────────────────────────────────────────────────────────────────────────

export type JsonlEvent =
  | { type: 'user'; ts?: number; raw: unknown }
  | { type: 'assistant'; ts?: number; raw: unknown }
  | { type: 'tool_use'; name?: string; input?: unknown; ts?: number; raw: unknown }
  | { type: 'tool_result'; ts?: number; raw: unknown }
  | { type: 'summary'; ts?: number; raw: unknown }
  /** A user-ROLE line that is not a turn: isMeta commentary, a local-command
   *  echo, a compact summary, an interrupt marker. Never moves the phase. */
  | { type: 'meta'; ts?: number; raw: unknown }
  | { type: 'other'; ts?: number; raw: unknown };

/** Epoch ms from a line's ISO `timestamp`, or undefined when absent/invalid. */
function lineTs(obj: any): number | undefined {
  const raw = obj?.timestamp;
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Best-effort text of a user line: string content, or the first text block. */
function userLineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const tb = content.find((c: any) => c && c.type === 'text' && typeof c.text === 'string');
    if (tb) return (tb as { text: string }).text;
  }
  return '';
}

/**
 * User-role lines that must NOT count as a turn starting. Ground-truthed
 * against real transcripts (see design.md of claude-session-live-tail):
 *   - `isMeta` — harness commentary ("Stop hook active…", command caveats).
 *   - `isCompactSummary` — the post-compaction context restatement.
 *   - `<command-name>` / `<local-command…` — a local slash-command echo; no
 *     model turn follows, so treating it as `running` would pin a false
 *     spinner until the reaper's 10-minute demotion.
 *   - `[Request interrupted…` — the user STOPPING a turn, not starting one.
 * The check is exclusion-based on purpose: an unrecognised injected-turn
 * flavour (new origin kinds) defaults to a real turn, erring toward showing
 * work rather than hiding it — hiding is the bug class this exists to fix.
 */
function isMetaUserLine(obj: any): boolean {
  if (obj.isMeta === true || obj.isCompactSummary === true) return true;
  const text = userLineText(obj.message?.content).trimStart();
  return text.startsWith('<command-name>')
    || text.startsWith('<local-command')
    || text.startsWith('[Request interrupted');
}

/**
 * Parse a single JSONL line. Tolerant of unknown shapes: returns `type:'other'`
 * rather than throwing, so the offset can advance safely.
 */
export function parseJsonlLine(line: string): JsonlEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return { type: 'other', raw: trimmed }; }
  if (!obj || typeof obj !== 'object') return { type: 'other', raw: obj };

  // Claude Code transcript v1 shapes (observed):
  //   { type: 'user', message: {...} }
  //   { type: 'assistant', message: { content: [{type:'text',...} | {type:'tool_use',...}] } }
  //   { type: 'user', message: { content: [{type:'tool_result',...}] } }
  //   { type: 'summary', ... }
  // We collapse them into the simpler categorisation above.
  const t = obj.type;
  const ts = lineTs(obj);

  if (t === 'summary') return { type: 'summary', ts, raw: obj };

  if (t === 'assistant') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      const tu = content.find((c: any) => c && c.type === 'tool_use');
      if (tu) {
        return { type: 'tool_use', name: tu.name, input: tu.input, ts, raw: obj };
      }
    }
    return { type: 'assistant', ts, raw: obj };
  }

  if (t === 'user') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      const tr = content.find((c: any) => c && c.type === 'tool_result');
      if (tr) return { type: 'tool_result', ts, raw: obj };
    }
    if (isMetaUserLine(obj)) return { type: 'meta', ts, raw: obj };
    return { type: 'user', ts, raw: obj };
  }

  return { type: 'other', ts, raw: obj };
}

/**
 * Canonical transcript path for a Claude Code session:
 *   <home>/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl
 * where the cwd encoding replaces every character outside [A-Za-z0-9] with `-`
 * (verified against real dirs: `/Users/x/.claude/jarvis` → `-Users-x--claude-jarvis`).
 * Lets the tracker tail a terminal session's transcript WITHOUT waiting for a
 * SessionStart hook that may never fire. Pure — home is injected.
 */
export function deriveTranscriptPath(home: string, cwd: string, claudeSessionId: string): string {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return `${home}/.claude/projects/${encoded}/${claudeSessionId}.jsonl`;
}

/**
 * Split a chunk read from a JSONL file into complete lines + remainder.
 * The remainder (partial last line) MUST be preserved across reads.
 */
export function splitJsonlChunk(chunk: string): { lines: string[]; remainder: string } {
  const idx = chunk.lastIndexOf('\n');
  if (idx === -1) return { lines: [], remainder: chunk };
  const head = chunk.slice(0, idx);
  const remainder = chunk.slice(idx + 1);
  const lines = head.split('\n').filter((l) => l.length > 0);
  return { lines, remainder };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface Transition {
  phase?: ClaudeSessionPhase;
  pendingApproval?: PendingApproval | undefined;
  lastTool?: ActiveTool | undefined;
  jsonlPath?: string;
  error?: ClaudeSessionError | undefined;
  monitorArmed?: boolean;
}

function transition(
  base: ClaudeSessionState,
  delta: Transition,
  now: number,
): ClaudeSessionState {
  // Detect whether anything actually changed. If the phase is the same and no
  // structural fields moved, return the base ref so callers can cheaply check
  // identity for "no-op" handling.
  const phaseChanged = delta.phase !== undefined && delta.phase !== base.phase;
  const approvalChanged = 'pendingApproval' in delta && !approvalsEqual(delta.pendingApproval, base.pendingApproval);
  const toolChanged = 'lastTool' in delta && !toolsEqual(delta.lastTool, base.lastTool);
  const jsonlChanged = delta.jsonlPath !== undefined && delta.jsonlPath !== base.jsonlPath;
  const errorChanged = 'error' in delta && !errorsEqual(delta.error, base.error);
  const monitorChanged = 'monitorArmed' in delta && !!delta.monitorArmed !== !!base.monitorArmed;

  if (!phaseChanged && !approvalChanged && !toolChanged && !jsonlChanged && !errorChanged && !monitorChanged) {
    return base;
  }

  // Inizio del turno: si data solo il FRONTE DI SALITA verso il lavoro. Dentro
  // un turno la fase rimbalza fra `running` e `tool-running` a ogni tool, e
  // ridatare a ogni rimbalzo trasformerebbe il cronometro del turno in quello
  // dell'ultima azione (che è già `lastTool.startedAt`). Uscendo dal lavoro il
  // valore NON viene cancellato: a turno finito nessuno lo legge, e tenerlo
  // permette di dire quanto è durato senza un secondo campo.
  const nextPhase = delta.phase ?? base.phase;
  const turnStarted = phaseChanged && isTurnWorkPhase(nextPhase) && !isTurnWorkPhase(base.phase);

  return {
    ...base,
    phase: nextPhase,
    phaseUpdatedAt: phaseChanged ? now : base.phaseUpdatedAt,
    turnStartedAt: turnStarted ? now : base.turnStartedAt,
    pendingApproval: 'pendingApproval' in delta ? delta.pendingApproval : base.pendingApproval,
    lastTool: 'lastTool' in delta ? delta.lastTool : base.lastTool,
    jsonlPath: delta.jsonlPath ?? base.jsonlPath,
    error: 'error' in delta ? delta.error : base.error,
    monitorArmed: 'monitorArmed' in delta ? delta.monitorArmed : base.monitorArmed,
    rev: base.rev + 1,
    updatedAt: now,
  };
}

function approvalsEqual(a?: PendingApproval, b?: PendingApproval): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.prompt === b.prompt && a.requestedAt === b.requestedAt;
}

function toolsEqual(a?: ActiveTool, b?: ActiveTool): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.startedAt === b.startedAt;
}

function errorsEqual(a?: ClaudeSessionError, b?: ClaudeSessionError): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.code === b.code && a.message === b.message && a.failedAt === b.failedAt;
}

function detectApproval(hook: HookPayload): boolean {
  if (hook.permission_request) return true;
  const title = typeof hook.title === 'string' ? hook.title.toLowerCase() : '';
  if (/permission|approval|approve/.test(title)) return true;
  return false;
}

function normaliseApprovalKind(hook: HookPayload): PendingApproval['kind'] {
  const k = (hook.permission_request?.kind || '').toLowerCase();
  if (k === 'plan' || k === 'edit' || k === 'bash') return k;
  // Fall back to title sniffing.
  const title = (typeof hook.title === 'string' ? hook.title : '').toLowerCase();
  if (title.includes('plan')) return 'plan';
  if (title.includes('edit') || title.includes('write')) return 'edit';
  if (title.includes('bash') || title.includes('command')) return 'bash';
  return 'other';
}

function extractApprovalPrompt(hook: HookPayload): string {
  if (hook.permission_request?.prompt) return String(hook.permission_request.prompt);
  if (typeof hook.message === 'string') return hook.message;
  if (typeof hook.title === 'string') return hook.title;
  return 'Approval requested';
}
