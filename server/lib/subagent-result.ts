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
  /** The summary a compaction writes as a `user` record: the turn goes on through it. */
  isCompactSummary?: unknown;
  /** Who wrote a `user` record: `task-notification` is the CLI reporting background work. */
  origin?: { kind?: unknown };
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

/** The CLI telling the child that background work it launched has reported back. */
const isTaskNotification = (ev: TranscriptEvent) => ev.type === 'user' && ev.origin?.kind === 'task-notification';

/** A `type:"user"` record that is a PROMPT: typed text, not a tool result, not a
 *  meta line the CLI injects, not the marker of an Escape, not a compaction's
 *  summary nor a task notification (both carry on the turn that was open). */
export function promptText(ev: TranscriptEvent | null): string | null {
  if (!ev || ev.type !== 'user' || ev.isMeta || ev.isCompactSummary || isTaskNotification(ev)) return null;
  const content = ev.message?.content;
  if (Array.isArray(content) && content.some((c) => !!c && typeof c === 'object' && c.type === 'tool_result')) return null;
  const text = contentText(content);
  if (!text.trim() || text.startsWith('[Request interrupted by user')) return null;
  return text;
}

/**
 * How the child's process came to an end, as the server saw it. `reloaded` is
 * the tab's «Ricarica»: the process goes and comes back under the same id with
 * `--resume`, which does not go on with a cut turn, so that turn ends there.
 */
export type SubAgentEnding = 'exited' | 'stopped' | 'closed' | 'swept' | 'lost' | 'reloaded';

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
  | { code: 'reloaded' }
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

/** How many prompts the child has received. */
export function promptCount(lines: readonly string[]): number {
  return tallyOf(lines).prompts;
}

const cutOutcome = (text: string, ending: SubAgentEnding, exitCode: number | null): SubAgentOutcome => {
  const partial = text.length > 0;
  if (ending === 'lost') return { status: 'lost', partial, text, reason: { code: 'terminal-lost' } };
  if (ending === 'stopped') return { status: 'stopped', partial, text, reason: { code: 'stopped-by-parent' } };
  if (ending === 'closed') return { status: 'stopped', partial, text, reason: { code: 'tab-closed' } };
  if (ending === 'reloaded') return { status: 'stopped', partial, text, reason: { code: 'reloaded' } };
  if (ending === 'swept') return { status: 'stopped', partial, text, reason: { code: 'swept' } };
  return {
    status: 'failed', partial, text,
    reason: exitCode != null && exitCode !== 0 ? { code: 'exit-code', exitCode } : { code: 'exited-mid-turn' },
  };
};

/** The ids of the tool calls in this content that started work in the background. */
function noteBackground(into: Set<string>, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c && typeof c === 'object' && c.type === 'tool_use' && typeof c.id === 'string' && c.input?.run_in_background === true) into.add(c.id);
  }
}

/** A notification names the tool call it reports on; one that does not settles the oldest. */
function settleBackground(pending: Set<string>, text: string): void {
  const id = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1];
  if (id && pending.delete(id)) return;
  const oldest = pending.values().next();
  if (!oldest.done) pending.delete(oldest.value);
}

/**
 * What the records of one turn add up to, folded one record at a time: the
 * state after the last record that moved the conversation, the text, and the
 * background work still owed a report. The live watch keeps it between two
 * looks at a growing transcript instead of the turn's lines.
 */
interface TurnFold {
  state: 'waiting' | 'working' | 'done' | 'api-error';
  turnText: string;
  errorText: string;
  /** Background work the turn launched and the CLI has not reported back yet:
   *  an `end_turn` before its notification is a promise to report, not the end. */
  background: Set<string>;
  /** The prompt's timestamp and the last record's: the turn's duration. */
  startAt: number;
  endAt: number;
}

const timestampOf = (ev: TranscriptEvent): number => (typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN);

function openTurn(prompt: TranscriptEvent): TurnFold {
  const at = timestampOf(prompt);
  return { state: 'waiting', turnText: '', errorText: '', background: new Set(), startAt: at, endAt: at };
}

function foldRecord(f: TurnFold, ev: TranscriptEvent): void {
  f.endAt = timestampOf(ev);
  if (ev.type === 'user') {
    // A tool result, an Escape marker or a notification: the turn is still open.
    if (isTaskNotification(ev)) settleBackground(f.background, contentText(ev.message?.content));
    f.state = 'working';
    return;
  }
  if (ev.type !== 'assistant') return;
  noteBackground(f.background, ev.message?.content);
  const text = contentText(ev.message?.content).trim();
  if (ev.isApiErrorMessage) {
    f.state = 'api-error';
    f.errorText = text;
    return;
  }
  // A synthetic line that is not an error is the CLI's, not the model's: the
  // "No response requested." a resume appends to a cut turn.
  if (ev.message?.model === '<synthetic>') return;
  if (text) f.turnText = text;
  f.state = ev.message?.stop_reason === 'end_turn' ? 'done' : 'working';
}

function turnVerdict(f: TurnFold, opts: { ending?: SubAgentEnding; exitCode?: number | null }): SubAgentOutcome | null {
  if (f.state === 'done' && !f.background.size) return { status: 'completed', partial: false, text: f.turnText };
  if (f.state === 'api-error') {
    return { status: 'failed', partial: false, text: f.turnText, reason: { code: 'api-error', detail: f.errorText } };
  }
  return opts.ending ? cutOutcome(f.turnText, opts.ending, opts.exitCode ?? null) : null;
}

/** The model an assistant record names, when it is a real one. */
function modelOf(ev: TranscriptEvent): string | null {
  if (ev.type !== 'assistant' || ev.isApiErrorMessage) return null;
  const model = ev.message?.model;
  return typeof model === 'string' && model && model !== '<synthetic>' ? model : null;
}

/**
 * A child's transcript read so far, folded: its prompts, its model, and the
 * turns still worth knowing (the ones not yet reported). Lines go in as they
 * are appended (`tallyLines`), so the watch never parses a record twice.
 */
export interface TranscriptTally {
  prompts: number;
  model: string | null;
  /** The folds of the last `open.length` turns, the newest last. */
  open: TurnFold[];
}

export function emptyTally(): TranscriptTally {
  return { prompts: 0, model: null, open: [] };
}

export function tallyLines(t: TranscriptTally, lines: readonly string[]): void {
  for (const line of lines) {
    const ev = parseEvent(line);
    if (!ev) continue;
    t.model ??= modelOf(ev);
    if (promptText(ev) !== null) {
      t.prompts++;
      t.open.push(openTurn(ev));
    } else if (t.open.length) {
      // The open folds always end with the newest turn: this record is its.
      foldRecord(t.open[t.open.length - 1]!, ev);
    }
  }
}

/** Drop the folds of the turns up to `turn`: reported, nothing is asked of them again. */
export function forgetTurns(t: TranscriptTally, turn: number): void {
  const drop = Math.min(t.open.length, Math.max(0, turn - (t.prompts - t.open.length)));
  if (drop) t.open.splice(0, drop);
}

function foldOf(t: TranscriptTally, turn: number): TurnFold | undefined {
  return turn >= 1 ? t.open[turn - 1 - (t.prompts - t.open.length)] : undefined;
}

function tallyOf(lines: readonly string[]): TranscriptTally {
  const t = emptyTally();
  tallyLines(t, lines);
  return t;
}

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
  if (!lines) {
    return opts.ending ? { ...cutOutcome('', opts.ending, opts.exitCode ?? null), reason: { code: 'no-transcript' } } : null;
  }
  const fold = foldOf(tallyOf(lines), turn);
  if (!fold) {
    // No prompt for this turn: only the first one can be "never delivered".
    return opts.ending && turn === 1 ? { status: 'undelivered', partial: false, text: '', reason: { code: 'no-prompt' } } : null;
  }
  return turnVerdict(fold, opts);
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
  return pendingTallyTurns(tallyOf(lines), s);
}

/** `pendingChildTurns` over a transcript already folded. */
export function pendingTallyTurns(
  t: TranscriptTally,
  s: { turnsReported: number; seededAt: number | null; now: number; undeliveredReported: boolean },
): Array<{ turn: number; outcome: SubAgentOutcome }> {
  if (t.prompts === 0) {
    if (s.undeliveredReported || s.seededAt == null || s.now - s.seededAt < UNDELIVERED_AFTER_MS) return [];
    return [{ turn: 1, outcome: { status: 'undelivered', partial: false, text: '', reason: { code: 'no-prompt' } } }];
  }
  const out: Array<{ turn: number; outcome: SubAgentOutcome }> = [];
  for (let turn = s.turnsReported + 1; turn <= t.prompts; turn++) {
    const fold = foldOf(t, turn);
    const outcome = fold ? turnVerdict(fold, {}) : null;
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
  // A Reload before the prompt arrived ends no turn: the child lives on, and
  // the `undelivered` clock of the live watch still runs.
  if (count === 0 && s.ending === 'reloaded') return null;
  if (count === 0 && lines && s.undeliveredReported) return null;
  const turn = Math.max(1, count);
  return { turn, outcome: classifyChildTurn(lines, turn, { ending: s.ending, exitCode: s.exitCode })! };
}

/** The model the child really ran: the first assistant record that names one. */
export function childModel(lines: readonly string[]): string | null {
  return tallyOf(lines).model;
}

/** From the turn's prompt to its last record, when both carry a timestamp. */
export function turnDurationMs(lines: readonly string[], turn: number): number | null {
  return tallyTurnDurationMs(tallyOf(lines), turn);
}

/** `turnDurationMs` over a transcript already folded. */
export function tallyTurnDurationMs(t: TranscriptTally, turn: number): number | null {
  const fold = foldOf(t, turn);
  if (!fold) return null;
  return Number.isFinite(fold.startAt) && Number.isFinite(fold.endAt) && fold.endAt >= fold.startAt ? fold.endAt - fold.startAt : null;
}

/**
 * The dedup key of a delivery: per agent AND turn (SUBAGENT-11), so a child
 * steered into a second turn reports it too. `undelivered` has its own key: an
 * early "never arrived" must not swallow the turn's real end.
 */
export function resultKey(r: Pick<SubAgentResult, 'agentId' | 'turn' | 'status'>): string {
  return r.status === 'undelivered' ? `${r.agentId}:${r.turn}:undelivered` : `${r.agentId}:${r.turn}`;
}
