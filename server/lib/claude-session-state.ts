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
      const tool: ActiveTool | undefined = hook.tool_name
        ? { name: hook.tool_name, input: hook.tool_input, startedAt: now }
        : undefined;
      return transition(base, {
        phase: 'tool-running',
        lastTool: tool,
      }, now);
    }

    case 'PostToolUse':
      // Only meaningful if we were tool-running. If we missed the PreToolUse
      // (script timed out / network blip) just clear the field defensively.
      return transition(base, {
        phase: prev.phase === 'tool-running' ? 'running' : prev.phase,
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
 * Apply a single parsed JSONL event. This is the recovery / replay path.
 * Used at boot to reconstruct the phase that the live hook stream would have
 * produced, in case some hooks were missed (server was down, script error).
 *
 * Only conservative transitions: we never put a session into a phase the
 * hooks alone wouldn't have produced. JSONL gives us a strong "running" /
 * "tool-running" / "awaiting-user" signal but does NOT include permission
 * requests — those only exist as hooks (Notification).
 */
export function applyJsonlEvent(
  prev: ClaudeSessionState,
  event: JsonlEvent,
  now: number,
): ClaudeSessionState {
  // If we're terminal, don't undo it.
  if (TERMINAL_PHASES.has(prev.phase)) return prev;

  const base: ClaudeSessionState = { ...prev, updatedAt: now };

  switch (event.type) {
    case 'user':
      // User prompt → running. Mirrors UserPromptSubmit hook.
      return transition(base, {
        phase: 'running',
        pendingApproval: undefined,
      }, now);

    case 'assistant':
      // Assistant message produced. If we were tool-running and no PostToolUse
      // landed, this implies the tool completed (the assistant resumed). We
      // promote to running. The Stop hook will subsequently take us to
      // awaiting-user.
      if (prev.phase === 'tool-running') {
        return transition(base, { phase: 'running', lastTool: undefined }, now);
      }
      return base;

    case 'tool_use':
      return transition(base, {
        phase: 'tool-running',
        lastTool: { name: event.name || 'unknown', input: event.input, startedAt: now },
      }, now);

    case 'tool_result':
      if (prev.phase === 'tool-running') {
        return transition(base, { phase: 'running', lastTool: undefined }, now);
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
}

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  toolRunningTimeoutMs: 10 * 60 * 1000,
  awaitingApprovalTimeoutMs: 10 * 60 * 1000,
  startTimeoutMs: 5 * 60 * 1000,
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
  | { type: 'user'; raw: unknown }
  | { type: 'assistant'; raw: unknown }
  | { type: 'tool_use'; name?: string; input?: unknown; raw: unknown }
  | { type: 'tool_result'; raw: unknown }
  | { type: 'summary'; raw: unknown }
  | { type: 'other'; raw: unknown };

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

  if (t === 'summary') return { type: 'summary', raw: obj };

  if (t === 'assistant') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      const tu = content.find((c: any) => c && c.type === 'tool_use');
      if (tu) {
        return { type: 'tool_use', name: tu.name, input: tu.input, raw: obj };
      }
    }
    return { type: 'assistant', raw: obj };
  }

  if (t === 'user') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      const tr = content.find((c: any) => c && c.type === 'tool_result');
      if (tr) return { type: 'tool_result', raw: obj };
    }
    return { type: 'user', raw: obj };
  }

  return { type: 'other', raw: obj };
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
