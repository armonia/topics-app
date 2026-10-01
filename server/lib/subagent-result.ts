/**
 * How each turn of a `spawn_agent` child ended, read from its own transcript
 * (SUBAGENT-11).
 *
 * A Claude TUI never exits on its own: a child that finished its work sits at
 * its prompt until somebody stops it. So the end of a turn is read where the
 * CLI writes it, the assistant record whose `stop_reason` is `end_turn`, and
 * not from the process. One result per turn, with a status that says how it
 * ended: only `completed` carries an outcome, every other status carries a
 * reason, and a cut turn's text is the last line seen, never a result.
 *
 * Pure: lines in, verdicts out. The server reads the file and decides when to
 * ask (`routes/terminal.ts`).
 */

/** One JSONL record of a claude transcript, as far as this module reads it. */
export interface TranscriptEvent {
  type?: unknown;
  isMeta?: unknown;
  isApiErrorMessage?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown; stop_reason?: unknown; model?: unknown };
}

/** The record on this line, or null when the line is not a JSON object. */
export function parseEvent(line: string): TranscriptEvent | null {
  try {
    const ev: unknown = JSON.parse(line);
    return ev && typeof ev === 'object' ? (ev as TranscriptEvent) : null;
  } catch {
    return null;
  }
}

/** The text blocks of a message's content, joined; a string content as is. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

/** A `type:"user"` record that is a PROMPT: typed text, not a tool result, not a
 *  meta line the CLI injects, not the marker of an Escape. */
export function promptText(ev: TranscriptEvent | null): string | null {
  if (!ev || ev.type !== 'user' || ev.isMeta) return null;
  const content = ev.message?.content;
  if (Array.isArray(content) && content.some((c) => !!c && typeof c === 'object' && c.type === 'tool_result')) return null;
  const text = contentText(content);
  if (!text.trim() || text.startsWith('[Request interrupted by user')) return null;
  return text;
}

/** How the child's process came to an end, as the server saw it. */
export type SubAgentEnding = 'exited' | 'stopped' | 'closed' | 'swept' | 'lost';

/** The status vocabulary of SUBAGENT-11: `completed` is the only one whose text is an outcome. */
export type SubAgentStatus = 'completed' | 'failed' | 'stopped' | 'undelivered' | 'lost';

export interface SubAgentOutcome {
  status: SubAgentStatus;
  /** The turn was cut before its end and `text` is the last line seen, not a result. */
  partial: boolean;
  /** The final text for `completed`; the last text seen otherwise (may be empty). */
  text: string;
  /** Why it is not `completed`, as a code: the words are the formatter's (`routes/subagent-exit.ts`). */
  reason?: SubAgentReason;
}

export type SubAgentReason =
  | { code: 'api-error'; detail: string }
  | { code: 'no-prompt' }
  | { code: 'no-transcript' }
  | { code: 'exit-code'; exitCode: number }
  | { code: 'exited-mid-turn' }
  | { code: 'stopped-by-parent' }
  | { code: 'tab-closed' }
  | { code: 'swept' }
  | { code: 'terminal-lost' };

/** The result of one turn of one child, as it is delivered (SUBAGENT-11). */
export interface SubAgentResult extends SubAgentOutcome {
  agentId: string;
  /** The name the PARENT chose, never the auto-namer's. */
  name: string;
  /** 1-based: the first prompt is turn 1. */
  turn: number;
  /** The model the child actually ran, from its first assistant record. */
  model: string | null;
  agentType: string | null;
  durationMs: number | null;
  cwd: string;
  branch: string | null;
}

/** How long a seeded prompt may take to appear in the transcript before the turn is `undelivered`. */
export const UNDELIVERED_AFTER_MS = 60_000;

/** The parsed records of each turn: turn N runs from its prompt to the next one. */
function splitTurns(lines: readonly string[]): { preamble: TranscriptEvent[]; turns: TranscriptEvent[][] } {
  const preamble: TranscriptEvent[] = [];
  const turns: TranscriptEvent[][] = [];
  for (const line of lines) {
    const ev = parseEvent(line);
    if (!ev) continue;
    if (promptText(ev) !== null) turns.push([ev]);
    else if (turns.length) turns[turns.length - 1]!.push(ev);
    else preamble.push(ev);
  }
  return { preamble, turns };
}

/** How many prompts the child has received. */
export function promptCount(lines: readonly string[]): number {
  return splitTurns(lines).turns.length;
}

const cutOutcome = (text: string, ending: SubAgentEnding, exitCode: number | null): SubAgentOutcome => {
  const partial = text.length > 0;
  if (ending === 'lost') return { status: 'lost', partial, text, reason: { code: 'terminal-lost' } };
  if (ending === 'stopped') return { status: 'stopped', partial, text, reason: { code: 'stopped-by-parent' } };
  if (ending === 'closed') return { status: 'stopped', partial, text, reason: { code: 'tab-closed' } };
  if (ending === 'swept') return { status: 'stopped', partial, text, reason: { code: 'swept' } };
  return {
    status: 'failed', partial, text,
    reason: exitCode != null && exitCode !== 0 ? { code: 'exit-code', exitCode } : { code: 'exited-mid-turn' },
  };
};

/**
 * One turn's verdict. `null` when the turn is still open and nothing ended it:
 * the child is working, and there is nothing to report yet.
 *
 * With an `ending` the turn is over whatever its records say: a turn that
 * reached `end_turn` is still `completed`, any other is cut and its text is the
 * last line seen. `lines` null means no transcript could be found at all.
 */
export function classifyChildTurn(
  lines: readonly string[] | null,
  turn: number,
  opts: { ending?: SubAgentEnding; exitCode?: number | null } = {},
): SubAgentOutcome | null {
  const exitCode = opts.exitCode ?? null;
  if (!lines) {
    return opts.ending ? { ...cutOutcome('', opts.ending, exitCode), reason: { code: 'no-transcript' } } : null;
  }
  const records = splitTurns(lines).turns[turn - 1];
  if (!records) {
    // No prompt for this turn: only the first one can be "never delivered".
    return opts.ending && turn === 1 ? { status: 'undelivered', partial: false, text: '', reason: { code: 'no-prompt' } } : null;
  }
  // The state after the last record that moved the conversation.
  let state: 'waiting' | 'working' | 'done' | 'api-error' = 'waiting';
  let turnText = '';
  let errorText = '';
  for (const ev of records.slice(1)) {
    if (ev.type === 'user') {
      // A tool result or an Escape marker: the turn is still open.
      state = 'working';
      continue;
    }
    if (ev.type !== 'assistant') continue;
    const text = contentText(ev.message?.content).trim();
    if (ev.isApiErrorMessage) {
      state = 'api-error';
      errorText = text;
      continue;
    }
    if (text) turnText = text;
    state = ev.message?.stop_reason === 'end_turn' ? 'done' : 'working';
  }
  if (state === 'done') return { status: 'completed', partial: false, text: turnText };
  if (state === 'api-error') {
    return { status: 'failed', partial: false, text: turnText, reason: { code: 'api-error', detail: errorText } };
  }
  return opts.ending ? cutOutcome(turnText, opts.ending, exitCode) : null;
}

/**
 * How a child that just ENDED finished its last turn: the verdict of the
 * report written when the process goes. Kept for its callers; the per-turn
 * reports go through `classifyChildTurn`.
 */
export function classifySubAgentTranscript(
  lines: string[] | null,
  ending: SubAgentEnding,
  exitCode: number | null = null,
): SubAgentOutcome {
  const turn = Math.max(1, lines ? promptCount(lines) : 1);
  return classifyChildTurn(lines, turn, { ending, exitCode })!;
}

/**
 * The turns a LIVE child has finished and not yet reported, oldest first. A
 * turn the next prompt superseded without an end of its own is skipped: it has
 * no outcome, and the turn after it does.
 *
 * Before the first prompt, a seed older than `UNDELIVERED_AFTER_MS` is reported
 * once as `undelivered`. That report does not consume turn 1: if the prompt
 * lands after all, its real end is reported too (the dedup key carries the
 * status, `resultKey`).
 */
export function pendingChildTurns(
  lines: readonly string[],
  s: { turnsReported: number; seededAt: number | null; now: number; undeliveredReported: boolean },
): Array<{ turn: number; outcome: SubAgentOutcome }> {
  const count = promptCount(lines);
  if (count === 0) {
    if (s.undeliveredReported || s.seededAt == null || s.now - s.seededAt < UNDELIVERED_AFTER_MS) return [];
    return [{ turn: 1, outcome: { status: 'undelivered', partial: false, text: '', reason: { code: 'no-prompt' } } }];
  }
  const out: Array<{ turn: number; outcome: SubAgentOutcome }> = [];
  for (let turn = s.turnsReported + 1; turn <= count; turn++) {
    const outcome = classifyChildTurn(lines, turn);
    if (outcome) out.push({ turn, outcome });
  }
  return out;
}

/**
 * The verdict when the child's process ends (stop, closed tab, sweep, exit,
 * lost terminal), or null when there is nothing left to report: its last turn
 * was already reported, so an idle child stopped by its parent produces no
 * second result.
 */
export function endingChildTurn(
  lines: string[] | null,
  s: { turnsReported: number; undeliveredReported: boolean; ending: SubAgentEnding; exitCode: number | null },
): { turn: number; outcome: SubAgentOutcome } | null {
  const count = lines ? promptCount(lines) : 0;
  if (count > 0 && count <= s.turnsReported) return null;
  if (count === 0 && lines && s.undeliveredReported) return null;
  const turn = Math.max(1, count);
  return { turn, outcome: classifyChildTurn(lines, turn, { ending: s.ending, exitCode: s.exitCode })! };
}

/** The model the child really ran: the first assistant record that names one. */
export function childModel(lines: readonly string[]): string | null {
  for (const line of lines) {
    const ev = parseEvent(line);
    if (ev?.type !== 'assistant' || ev.isApiErrorMessage) continue;
    const model = ev.message?.model;
    if (typeof model === 'string' && model && model !== '<synthetic>') return model;
  }
  return null;
}

/** From the turn's prompt to its last record, when both carry a timestamp. */
export function turnDurationMs(lines: readonly string[], turn: number): number | null {
  const records = splitTurns(lines).turns[turn - 1];
  if (!records) return null;
  const at = (ev: TranscriptEvent | undefined) => (typeof ev?.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN);
  const start = at(records[0]);
  const end = at(records[records.length - 1]);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/**
 * The dedup key of a delivery: per agent AND turn (SUBAGENT-11), so a child
 * steered into a second turn reports it too. `undelivered` has its own key: an
 * early "never arrived" must not swallow the turn's real end.
 */
export function resultKey(r: Pick<SubAgentResult, 'agentId' | 'turn' | 'status'>): string {
  return r.status === 'undelivered' ? `${r.agentId}:${r.turn}:undelivered` : `${r.agentId}:${r.turn}`;
}
