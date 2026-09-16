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
 *
 * THE FOREGROUND IS A LIST, ONE ENTRY PER TOOL CALL, and that is the fix for a
 * measured hole. It used to be a single box, overwritten by the next Bash and
 * EMPTIED by any `PostToolUse` at all (the hook is installed on every matcher)
 * and by the arrival of a background Bash. Each of those three is an ordinary
 * turn - a `Read` finishing while a `bun test` runs, two Bash calls in one
 * response - and each left a command in flight with nothing naming it, so a
 * stale background record (there is no expiry, only a cap of 20) claimed its pid
 * and the freezer had a foreground command as a candidate. An entry is now
 * removed by the `PostToolUse` OF THAT SAME CALL: by `tool_use_id` when the
 * payload carries one, otherwise by the command text, which still tells two
 * parallel calls apart whenever they differ.
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

/** One foreground Bash in flight: the call that opened it, and what it runs. */
interface ForegroundCall {
  /** The CLI's `tool_use_id` when the payload carries one; `null` otherwise. */
  id: string | null;
  command: string;
}

interface SessionRecord {
  background: BackgroundBashRecord[];
  foreground: ForegroundCall[];
  touchedAt: number;
}

const sessions = new Map<string, SessionRecord>();

function recordFor(claudeSessionId: string, now: number): SessionRecord {
  let found = sessions.get(claudeSessionId);
  if (!found) {
    found = { background: [], foreground: [], touchedAt: now };
    sessions.set(claudeSessionId, found);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
  }
  found.touchedAt = now;
  return found;
}

/** The `tool_use_id` of a hook payload, when it carries one we can use as a key. */
function toolUseIdOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** A `PreToolUse`: a background command is remembered, a foreground one goes in flight. */
export function noteBashToolCall(
  claudeSessionId: string,
  toolName: string | undefined,
  toolInput: unknown,
  now = Date.now(),
  toolUseId?: unknown,
): void {
  if (!claudeSessionId) return;
  const reading = readBashHook(toolName, toolInput);
  if (reading.kind === "other") return;
  const entry = recordFor(claudeSessionId, now);
  if (reading.kind === "foreground") {
    // The cap is the only bound: a `PostToolUse` that never arrives (a CLI
    // killed mid-tool) would otherwise keep its entry for the life of the
    // session. Keeping the NEWEST is the safe end - the oldest entry is the one
    // whose command is least likely to still be running.
    entry.foreground = [...entry.foreground, { id: toolUseIdOf(toolUseId), command: reading.command }].slice(-MAX_PER_SESSION);
    return;
  }
  entry.background = [...entry.background.filter((b) => b.command !== reading.command), { command: reading.command, startedAt: now }]
    .slice(-MAX_PER_SESSION);
}

/**
 * The `PostToolUse` of ONE call: only that call stops being in flight.
 *
 * The hook is installed on every matcher, so this is called for a `Read`, a
 * `Grep`, a `BashOutput` - anything. Nothing filters here because nothing needs
 * to: an entry goes only when the payload NAMES it, by the id of that very call
 * or by a foreground Bash with that very command. A payload that identifies
 * nothing leaves the list alone, which is the safe end of the trade - a command
 * still named as foreground costs the freezer a candidate, a command no longer
 * named costs a running process a SIGSTOP.
 */
export function endBashToolCall(
  claudeSessionId: string,
  toolName: string | undefined,
  toolInput: unknown,
  toolUseId?: unknown,
): void {
  const entry = sessions.get(claudeSessionId);
  if (!entry) return;
  const id = toolUseIdOf(toolUseId);
  const reading = readBashHook(toolName, toolInput);
  const index = entry.foreground.findIndex((f) => (id !== null && f.id !== null
    ? f.id === id
    // Without an id the command text is the key, and only a FOREGROUND payload
    // may use it: the `PostToolUse` of a background shell running the same text
    // would otherwise unname a foreground command that is still going.
    : reading.kind === "foreground" && f.command === reading.command));
  if (index >= 0) entry.foreground.splice(index, 1);
}

export function backgroundBashFor(claudeSessionId: string): BackgroundBashRecord[] {
  return sessions.get(claudeSessionId)?.background ?? [];
}

/** Every foreground Bash of this session still in flight. */
export function foregroundBashFor(claudeSessionId: string): string[] {
  return (sessions.get(claudeSessionId)?.foreground ?? []).map((f) => f.command);
}

/** A session that ended keeps nothing: its shells died with its CLI. */
export function forgetBashRecords(claudeSessionId: string): void {
  sessions.delete(claudeSessionId);
}
