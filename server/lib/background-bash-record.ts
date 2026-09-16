/**
 * WHICH OF AN AGENT'S COMMANDS IS IN THE BACKGROUND, FROM THE TOOL CALL ITSELF.
 *
 * Every Claude Code CLI on this machine posts `PreToolUse` with its `tool_input`
 * to Topics (`~/.claude/settings.json`, installed by
 * `scripts/install-claude-hooks.ts`), and `run_in_background` is in that payload.
 * That is the ONLY honest way to tell the two apart, and the difference decides
 * whether a command may be frozen at all:
 *
 *  - a BACKGROUND shell has no tool timeout; the agent reads it with `BashOutput`
 *    whenever it likes, so a pause costs it nothing but time;
 *  - a FOREGROUND command is killed by its own CLI at the tool timeout, on a wall
 *    clock that keeps running while the process is stopped. Freezing it spends
 *    the command's remaining time, and no thaw rule can give it back because
 *    nobody knows how much it still needs. That is a kill by Topics with extra
 *    steps, so a foreground command is never a candidate - and a payload we
 *    cannot read is treated as foreground, never as an opportunity.
 *
 * The records are per CLAUDE SESSION id (what the hook carries); the freezer
 * joins them to a session's CLI pid. Nothing here is persisted: a pid and a
 * command that survived a restart would be a claim about processes we never saw.
 */

export interface BackgroundBashRecord {
  command: string;
  startedAt: number;
}

/** What a `PreToolUse` says about a Bash call, and nothing more. */
export type BashHookReading =
  | { kind: "background"; command: string }
  | { kind: "foreground"; command: string }
  | { kind: "other" };

/** The last commands kept per session: more than this and the oldest is not coming back anyway. */
const MAX_PER_SESSION = 20;
/** And this many sessions, so a long-lived server cannot grow the map without bound. */
const MAX_SESSIONS = 200;

export function readBashHook(toolName: string | undefined, toolInput: unknown): BashHookReading {
  if (toolName !== "Bash") return { kind: "other" };
  const input = (toolInput ?? {}) as { command?: unknown; run_in_background?: unknown };
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return { kind: "other" };
  return input.run_in_background === true
    ? { kind: "background", command }
    : { kind: "foreground", command };
}

interface SessionRecord {
  background: BackgroundBashRecord[];
  foreground: string | null;
  touchedAt: number;
}

const sessions = new Map<string, SessionRecord>();

function recordFor(claudeSessionId: string, now: number): SessionRecord {
  let found = sessions.get(claudeSessionId);
  if (!found) {
    found = { background: [], foreground: null, touchedAt: now };
    sessions.set(claudeSessionId, found);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
  }
  found.touchedAt = now;
  return found;
}

/** A `PreToolUse`: a background command is remembered, a foreground one is marked as in flight. */
export function noteBashToolCall(claudeSessionId: string, toolName: string | undefined, toolInput: unknown, now = Date.now()): void {
  if (!claudeSessionId) return;
  const reading = readBashHook(toolName, toolInput);
  if (reading.kind === "other") return;
  const entry = recordFor(claudeSessionId, now);
  if (reading.kind === "foreground") { entry.foreground = reading.command; return; }
  entry.foreground = null;
  entry.background = [...entry.background.filter((b) => b.command !== reading.command), { command: reading.command, startedAt: now }]
    .slice(-MAX_PER_SESSION);
}

/** A `PostToolUse` (or anything that ends the turn): no foreground command is in flight any more. */
export function clearForegroundBash(claudeSessionId: string): void {
  const entry = sessions.get(claudeSessionId);
  if (entry) entry.foreground = null;
}

export function backgroundBashFor(claudeSessionId: string): BackgroundBashRecord[] {
  return sessions.get(claudeSessionId)?.background ?? [];
}

export function foregroundBashFor(claudeSessionId: string): string | null {
  return sessions.get(claudeSessionId)?.foreground ?? null;
}

/** A session that ended keeps nothing: its shells died with its CLI. */
export function forgetBashRecords(claudeSessionId: string): void {
  sessions.delete(claudeSessionId);
}
