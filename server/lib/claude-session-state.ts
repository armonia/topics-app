/**
 * Pure state-derivation primitives for Claude Code sessions.
 *
 * No IO, no DB, no logging. Every function is deterministic and unit-testable
 * with `bun:test`. The service layer in `claude-session-tracker.ts` composes
 * these with persistence + broadcast.
 *
 * Phase semantics: see openspec/changes/claude-session-tracker/design.md.
 */

export type ClaudeSessionPhase =
  | 'starting'
  | 'running'
  | 'tool-running'
  | 'awaiting-user'
  | 'awaiting-approval'
  | 'paused'
  | 'completed'
  | 'error'
  | 'dormant';

export const ALL_PHASES: ReadonlyArray<ClaudeSessionPhase> = [
  'starting', 'running', 'tool-running', 'awaiting-user',
  'awaiting-approval', 'paused', 'completed', 'error', 'dormant',
];

const TERMINAL_PHASES = new Set<ClaudeSessionPhase>(['completed', 'error']);
const ACTIVE_PHASES = new Set<ClaudeSessionPhase>([
  'starting', 'running', 'tool-running', 'awaiting-user', 'awaiting-approval',
]);

export function isTerminalPhase(p: ClaudeSessionPhase): boolean {
  return TERMINAL_PHASES.has(p);
}

export function isActivePhase(p: ClaudeSessionPhase): boolean {
  return ACTIVE_PHASES.has(p);
}

export interface PendingApproval {
  kind: 'plan' | 'edit' | 'bash' | 'other';
  prompt: string;
  requestedAt: number;
}

export interface ActiveTool {
  name: string;
  input?: unknown;
  startedAt: number;
}

export interface ClaudeSessionError {
  code: string;
  message: string;
  failedAt: number;
}

/**
 * The canonical state object. This is what consumers see — the DB row is an
 * encoding of it (with JSON columns flattened) and the WS payload is a copy.
 */
export interface ClaudeSessionState {
  sessionKey: string | null;
  claudeSessionId: string;
  phase: ClaudeSessionPhase;
  phaseUpdatedAt: number;
  jsonlPath?: string;
  jsonlOffset: number;
  pendingApproval?: PendingApproval;
  lastTool?: ActiveTool;
  lastHookAt?: number;
  rev: number;
  error?: ClaudeSessionError;
  createdAt: number;
  updatedAt: number;
}

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
  | 'SubagentStop';

export const KNOWN_HOOK_EVENTS: ReadonlyArray<HookEventName> = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
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

export function isHumanInputTool(toolName: string | undefined): boolean {
  return !!toolName && HUMAN_INPUT_TOOLS.has(toolName);
}

/**
 * Map a human-input tool to the PendingApproval it represents, extracting a
 * best-effort prompt string from its tool_input so the UI can echo what's being
 * asked. Tolerant of missing/odd shapes — we only ever read strings we find.
 */
function humanInputApproval(hook: HookPayload, now: number): PendingApproval {
  if (hook.tool_name === 'ExitPlanMode') {
    const plan = (hook.tool_input as { plan?: unknown } | undefined)?.plan;
    return {
      kind: 'plan',
      prompt: typeof plan === 'string' && plan.trim() ? plan : 'Approve plan?',
      requestedAt: now,
    };
  }
  // AskUserQuestion — surface the first question's text when present.
  const questions = (hook.tool_input as { questions?: unknown } | undefined)?.questions;
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
      // fields but keep cumulative metadata (rev, offset).
      return transition(base, {
        phase: 'starting',
        pendingApproval: undefined,
        lastTool: undefined,
        error: undefined,
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
          pendingApproval: humanInputApproval(hook, now),
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
      return transition(base, {
        phase: 'awaiting-user',
        pendingApproval: undefined,
        lastTool: undefined,
      }, now);

    case 'SubagentStop':
      // Subagent completions are recorded but don't move the parent's phase.
      return base;

    case 'SessionEnd':
      return transition(base, {
        phase: 'completed',
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
      // gated or missed). Promote ANY non-terminal phase to running: from
      // tool-running it means the tool completed and no PostToolUse landed;
      // from a resting phase (awaiting-user / paused / dormant / starting) it
      // is the wake-up evidence itself. Clear transient fields — a stale
      // pendingApproval (paused keeps it for display) is dead once the model
      // demonstrably moved on.
      if (prev.phase !== 'running') {
        return transition(base, {
          phase: 'running',
          lastTool: undefined,
          pendingApproval: undefined,
        }, at);
      }
      return base;

    case 'tool_use':
      return transition(base, {
        phase: 'tool-running',
        lastTool: { name: event.name || 'unknown', input: event.input, startedAt: at },
      }, at);

    case 'tool_result':
      if (prev.phase === 'tool-running') {
        return transition(base, { phase: 'running', lastTool: undefined }, at);
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
}

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  toolRunningTimeoutMs: 10 * 60 * 1000,
  awaitingApprovalTimeoutMs: 10 * 60 * 1000,
  startTimeoutMs: 5 * 60 * 1000,
  runningTimeoutMs: 10 * 60 * 1000,
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

  if (!phaseChanged && !approvalChanged && !toolChanged && !jsonlChanged && !errorChanged) {
    return base;
  }

  return {
    ...base,
    phase: delta.phase ?? base.phase,
    phaseUpdatedAt: phaseChanged ? now : base.phaseUpdatedAt,
    pendingApproval: 'pendingApproval' in delta ? delta.pendingApproval : base.pendingApproval,
    lastTool: 'lastTool' in delta ? delta.lastTool : base.lastTool,
    jsonlPath: delta.jsonlPath ?? base.jsonlPath,
    error: 'error' in delta ? delta.error : base.error,
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
