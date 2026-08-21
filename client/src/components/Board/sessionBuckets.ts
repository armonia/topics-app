/**
 * The agent's session rows split between the thread's comments, in ONE pass.
 *
 * The drawer renders the reasoning that produced each reply right above it, so
 * every thread row needs "the session messages that fall in the gap before this
 * comment". That used to be a `filter` over the whole session PER ROW: with the
 * history capped at 200 messages and a card carrying 28 comments, one poll tick
 * walked 5600 messages, and the drawer polls every 3s while a turn runs. Worse,
 * every tick handed each `SessionSlice` a BRAND NEW array even when the session
 * had not moved, so all of them re-rendered for nothing.
 *
 * Here the split happens once, walking messages and boundaries together, and a
 * bucket whose contents did not change keeps the array object it had before.
 * Reference equality is the signal a memoised child needs; the messages
 * themselves are rebuilt by `JSON.parse` on every poll, so the comparison has
 * to be by VALUE (identity would never match and nothing would ever be reused).
 *
 * The walk assumes `boundaries` is ascending by `createdAt`, which is how the
 * server returns comments. It degrades to empty buckets, never to duplicated
 * ones: a message belongs to exactly one bucket by construction, so an
 * out-of-order comment can only lose rows to its neighbour, not clone them onto
 * two rows of the thread.
 */

/** One session message with its placement timestamp (from `/api/history`). */
export interface SessionMsg { role: string; content: string; timestamp: string; thinking?: string }

/** A thread row the session is cut against: its id and its instant. */
export interface SessionBoundary { id: string; createdAt: string }

export interface SessionBuckets {
  /** Comment id -> the messages in the gap ABOVE that comment. */
  byComment: ReadonlyMap<string, SessionMsg[]>;
  /** After the last comment (open ended); the whole session when there are none. */
  tail: SessionMsg[];
}

/** One shared empty array, so "no messages here" is always the same reference. */
const EMPTY: SessionMsg[] = [];

export const EMPTY_SESSION_BUCKETS: SessionBuckets = { byComment: new Map(), tail: EMPTY };

function sameMsg(a: SessionMsg, b: SessionMsg): boolean {
  return a.role === b.role && a.timestamp === b.timestamp && a.content === b.content && a.thinking === b.thinking;
}

/** `next`, or the previous array when it holds the same messages. */
function keepStable(next: SessionMsg[], old: SessionMsg[] | undefined): SessionMsg[] {
  if (next.length === 0) return old && old.length === 0 ? old : EMPTY;
  if (!old || old.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) if (!sameMsg(next[i], old[i])) return next;
  return old;
}

export function bucketSessionMsgs(
  msgs: readonly SessionMsg[] | null,
  boundaries: readonly SessionBoundary[],
  prev?: SessionBuckets,
): SessionBuckets {
  if (!msgs || msgs.length === 0) {
    // Still walk the ids: a thread that lost its session must hand every row an
    // empty slice, and `EMPTY` keeps those stable too.
    return boundaries.length === 0
      ? EMPTY_SESSION_BUCKETS
      : { byComment: new Map(boundaries.map((b) => [b.id, EMPTY])), tail: EMPTY };
  }

  // Only timestamped rows can be placed at all (same rule the per-row filter
  // had). Sorting is skipped when the history already arrives in order, which
  // is the normal case.
  const placed: SessionMsg[] = [];
  let ordered = true;
  for (const m of msgs) {
    if (!m.timestamp) continue;
    const last = placed[placed.length - 1];
    if (last && last.timestamp > m.timestamp) ordered = false;
    placed.push(m);
  }
  if (!ordered) placed.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const byComment = new Map<string, SessionMsg[]>();
  let p = 0;
  for (const b of boundaries) {
    const start = p;
    while (p < placed.length && placed[p].timestamp <= b.createdAt) p++;
    byComment.set(b.id, keepStable(placed.slice(start, p), prev?.byComment.get(b.id)));
  }
  return { byComment, tail: keepStable(placed.slice(p), prev?.tail) };
}

/**
 * One block of the session pane: a stretch of agent steps, or the hairline
 * marking where a thread reply landed between two stretches.
 */
export type SessionPaneRow =
  | { kind: 'steps'; id: string; msgs: SessionMsg[] }
  | { kind: 'mark'; id: string };

/** Id of the block holding everything after the last comment. */
export const SESSION_TAIL_ID = 'tail';

/**
 * The session laid out as ONE continuous read, with the comment boundaries kept
 * as marks instead of as cuts.
 *
 * The drawer used to interleave a collapsed slice above every thread row, so
 * "where did the agent say this, relative to the replies" was carried by the
 * layout itself. Reading the session whole is worth more than that placement,
 * but losing it entirely would flatten a conversation into a transcript, so the
 * boundary survives as a line the reader can skim past.
 *
 * A mark only earns a line BETWEEN two stretches of steps: it is held back
 * until the next stretch appears, so a run of replies with nothing said in
 * between collapses to one line, a mark with nothing above it is never opened,
 * and a mark with nothing after it is never emitted. Without that rule a card
 * with 28 comments and two agent turns would draw 28 dividers around them.
 *
 * Only the agent's turns are steps. Human/dispatcher turns injected into the
 * session (steering, the kickoff envelope) are the same words the thread shows
 * as comment bubbles; drawing them again here is pure duplication.
 */
export function sessionPaneRows(
  buckets: SessionBuckets,
  boundaryIds: readonly string[],
): SessionPaneRow[] {
  const rows: SessionPaneRow[] = [];
  let pendingMark: string | null = null;
  const addSteps = (id: string, msgs: readonly SessionMsg[]): void => {
    const steps = msgs.filter((m) => m.role !== 'user');
    if (steps.length === 0) return;
    if (pendingMark !== null) rows.push({ kind: 'mark', id: pendingMark });
    pendingMark = null;
    rows.push({ kind: 'steps', id, msgs: steps });
  };
  for (const id of boundaryIds) {
    addSteps(id, buckets.byComment.get(id) ?? []);
    if (rows.length > 0) pendingMark = id;
  }
  addSteps(SESSION_TAIL_ID, buckets.tail);
  return rows;
}
