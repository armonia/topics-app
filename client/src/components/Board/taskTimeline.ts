/**
 * THE CARD'S CONVERSATION IS ONE LIST, and this is where it is decided.
 *
 * A dispatched card carries the same turn written down twice: the thread of
 * `task_comments` (what the agent declared, what a person answered) and the
 * transcript of its session (what the agent actually did). Two panes side by
 * side made the reader do the join by hand, matching wall-clock times across
 * two scrollers to work out which comment came out of which step.
 *
 * So the join happens here, once, as a PURE function of the two lists. No DOM,
 * no React, no fetch: the rule that can be wrong is testable on plain objects,
 * which matters because this is the kind of code that fails in SILENCE. A
 * projection that drops a row renders as a perfectly plausible conversation.
 *
 * THE WAY TO BE WRONG IS ONE ROW TOO MANY, NEVER ONE ROW HIDDEN. Every rule
 * that removes something is conditioned on a POSITIVE proof that the same words
 * are already on screen under another row: an envelope is dropped only when it
 * names the comment ids it delivered, and a mirrored tool call is stripped only
 * when a comment actually anchored to that message exists. No rule here reads
 * the TEXT of anything.
 *
 * The order of the passes is not free:
 *   1. envelopes and the mirrored tool calls are decided on the RAW messages,
 *      because both look at `msg.id` and at `msg.blocks`, and coalescing
 *      rewrites both;
 *   2. `coalesceToolRuns` then folds runs of wordless work into one item, so a
 *      stripped row that became empty is gone before it can carry a run;
 *   3. only then the two lists are merged, on the items the reader will see.
 *
 * Requirements KANBAN-73 (the projection) and KANBAN-74 (the derived delivery
 * chip), in `openspec/specs/kanban/spec.md`.
 */
import type { TaskComment } from '../../../../shared/board';
import type { ChatMessage, ContentBlock, ToolCall } from '../../types';
import { coalesceToolRuns } from '../Chat/coalesceToolRun';
import { envelopeCommentIds, isDispatchedEnvelope } from '../Chat/dispatchedEnvelope';

/**
 * The board tools an agent calls to speak on its own card. When one of them
 * produced a comment we already draw, the tool row is the SAME words a second
 * time, in machine dress. Matched by tool NAME, never by what it said.
 */
const MIRRORED_TOOLS = new Set([
  'mcp__topics__comment_task',
  'mcp__topics__update_task',
  'mcp__topics__ask_user_question',
]);

/** Card statuses in which a comment nobody has delivered yet is still owed a turn. */
const AWAITING_STATUSES = new Set(['in_progress', 'todo']);

/**
 * One row of the conversation, from whichever of the two lists it came.
 *
 * `kind` is what `ThreadRuns` and `shared/task-comment-service.ts` classify on,
 * so it stays inside `TaskComment['kind']` rather than gaining a member: a
 * session row is speech, hence `'comment'`. The collapsed dispatcher envelope
 * is NOT told apart by a kind of its own but by `envelope: true`, so the fold
 * rule keeps working unchanged on a type it already knows.
 */
export type TimelineItem =
  | {
      source: 'comment';
      id: string;
      at: string;
      author: string;
      kind: TaskComment['kind'];
      content: string;
      comment: TaskComment;
      /** The derived delivery state of a human row. Absent = nothing to say. */
      delivery?: 'delivered' | 'pending';
    }
  | {
      source: 'session';
      id: string;
      at: string;
      author: string;
      kind: 'comment';
      content: string;
      msg: ChatMessage;
      /** A dispatcher envelope that named no comment: one collapsed line. */
      envelope?: true;
      delivery?: 'delivered' | 'pending';
    };

/** What the caller passes about the card itself. */
export interface TimelineOptions {
  /** The card's column. Only `in_progress` and `todo` can owe a turn. */
  status: string;
  /** The delivery already painted in the pinned band, so it is not painted twice. */
  pinnedDeliveryId?: string | null;
}

/** Is this tool call one of the board tools that mirror a comment? */
function isMirrored(name: string | undefined | null): boolean {
  return !!name && MIRRORED_TOOLS.has(name);
}

/**
 * The message with its mirrored tool calls removed, or the SAME object when
 * there was nothing to remove.
 *
 * Returning the input untouched is not an optimisation, it is what makes
 * reference stability (rule g) reachable at all: a row nobody edited has to
 * come out of every pass as the identical object.
 */
function stripMirroredCalls(msg: ChatMessage): ChatMessage | null {
  const calls = msg.toolCalls ?? [];
  const blocks = msg.blocks ?? [];
  const dropsCall = calls.some((t) => isMirrored(t.name));
  const dropsBlock = blocks.some((b) => b.kind === 'tool' && isMirrored((b as { toolCall?: ToolCall }).toolCall?.name));
  if (!dropsCall && !dropsBlock) return msg;
  const keptCalls = calls.filter((t) => !isMirrored(t.name));
  const keptBlocks = blocks.filter(
    (b: ContentBlock) => !(b.kind === 'tool' && isMirrored((b as { toolCall?: ToolCall }).toolCall?.name)),
  );
  const cached = STRIPPED.get(msg);
  if (cached !== undefined) return cached;
  const next: ChatMessage = { ...msg, toolCalls: keptCalls, blocks: keptBlocks };
  // A row whose only reason to exist was the mirrored call is not an empty
  // bubble, it is nothing at all.
  const hasWords = (next.content ?? '').trim().length > 0 || (next.thinking ?? '').trim().length > 0;
  const out = !hasWords && keptCalls.length === 0 && keptBlocks.length === 0 ? null : next;
  STRIPPED.set(msg, out);
  return out;
}

/**
 * The stripped copy of a row, remembered by the row it came from.
 *
 * Without it every projection minted a fresh object for the same message, and
 * `coalesceToolRuns` (which reuses its work on an unchanged PREFIX, compared by
 * identity) would find the prefix broken at the first anchored row. The result
 * of the strip depends on the message alone, so caching on it is sound. A
 * WeakMap, so a session that scrolls out of memory takes its entries with it.
 */
const STRIPPED = new WeakMap<ChatMessage, ChatMessage | null>();

/**
 * The session, ready to be merged: envelopes decided, mirrored calls stripped,
 * runs of wordless work coalesced.
 */
function projectSession(msgs: readonly ChatMessage[], anchored: ReadonlySet<string>): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === 'user') {
      // An envelope that names what it delivered is bookkeeping about rows the
      // reader already has. One that names nothing (a kickoff, a nudge) still
      // has to be visible, collapsed.
      if (isDispatchedEnvelope(msg.blocks) && envelopeCommentIds(msg.blocks).length > 0) continue;
      kept.push(msg);
      continue;
    }
    if (msg.role !== 'assistant') {
      kept.push(msg);
      continue;
    }
    const next = anchored.has(msg.id) ? stripMirroredCalls(msg) : msg;
    if (next) kept.push(next);
  }
  return coalesceToolRuns(kept).items;
}

/** The instant a row claims, as a comparable string. Missing sorts first. */
function instantOf(value: string | undefined | null): string {
  return value ?? '';
}

/**
 * The delivery state of ONE human comment, read off the envelopes.
 *
 * Nothing writes this anywhere: it is derived at every read, which is why a
 * server restart that lost the buffer cannot leave a promise behind. The
 * continuation envelope, being NEWER than the comment and not naming it, drops
 * the chip by itself.
 */
function deliveryOf(
  comment: TaskComment,
  delivered: ReadonlySet<string>,
  newestEnvelopeAt: string | null,
  status: string,
): 'delivered' | 'pending' | undefined {
  if (comment.kind !== 'comment' || comment.author !== 'user') return undefined;
  if (delivered.has(comment.id)) return 'delivered';
  if (!AWAITING_STATUSES.has(status)) return undefined;
  if (newestEnvelopeAt && newestEnvelopeAt > instantOf(comment.createdAt)) return undefined;
  return 'pending';
}

function commentItem(
  comment: TaskComment,
  delivery: 'delivered' | 'pending' | undefined,
  prev: Map<TaskComment, TimelineItem>,
): TimelineItem {
  const before = prev.get(comment);
  if (before && before.source === 'comment' && before.delivery === delivery) return before;
  return {
    source: 'comment',
    id: comment.id,
    at: comment.createdAt,
    author: comment.author,
    kind: comment.kind,
    content: comment.content,
    comment,
    ...(delivery ? { delivery } : {}),
  };
}

function sessionItem(msg: ChatMessage, prev: Map<ChatMessage, TimelineItem>): TimelineItem {
  const before = prev.get(msg);
  if (before && before.source === 'session') return before;
  const envelope = msg.role === 'user' && isDispatchedEnvelope(msg.blocks);
  return {
    source: 'session',
    id: msg.id,
    at: msg.timestamp,
    author: msg.role === 'user' ? 'user' : 'agent',
    kind: 'comment',
    content: msg.content ?? '',
    msg,
    ...(envelope ? { envelope: true as const } : {}),
  };
}

/**
 * The two lists as ONE, in the order a reader would have reconstructed by hand.
 *
 * `prev` is the previous result: every item whose comment or message is the
 * same reference comes back as the same object, so a re-render that changed
 * nothing changes nothing downstream. The memo cannot read its own output,
 * hence the parameter.
 */
export function mergeTaskTimeline(
  comments: readonly TaskComment[],
  msgs: readonly ChatMessage[],
  opts: TimelineOptions,
  prev?: readonly TimelineItem[],
): TimelineItem[] {
  const pinned = opts.pinnedDeliveryId ?? null;
  const visible = pinned ? comments.filter((c) => c.id !== pinned) : comments;

  // The anchors, both ways round: which messages had a comment come out of
  // them, and which comments an envelope has already carried away.
  const anchored = new Set<string>();
  for (const c of comments) if (c.messageId) anchored.add(c.messageId);
  const delivered = new Set<string>();
  let newestEnvelopeAt: string | null = null;
  for (const m of msgs) {
    if (m.role !== 'user' || !isDispatchedEnvelope(m.blocks)) continue;
    for (const id of envelopeCommentIds(m.blocks)) delivered.add(id);
    const at = instantOf(m.timestamp);
    if (at && (!newestEnvelopeAt || at > newestEnvelopeAt)) newestEnvelopeAt = at;
  }

  const rows = projectSession(msgs, anchored);
  const byId = new Map<string, ChatMessage>();
  for (const m of rows) byId.set(m.id, m);
  // A coalesced item carries the ids it swallowed: a comment anchored to an
  // absorbed message still has a row to sit under.
  for (const m of rows) for (const id of (m as { mergedIds?: string[] }).mergedIds ?? []) byId.set(id, m);

  const prevByComment = new Map<TaskComment, TimelineItem>();
  const prevByMsg = new Map<ChatMessage, TimelineItem>();
  for (const item of prev ?? []) {
    if (item.source === 'comment') prevByComment.set(item.comment, item);
    else prevByMsg.set(item.msg, item);
  }

  // Comments anchored to a message do not queue for the clock: they follow
  // their message, whatever the two timestamps say. This includes the
  // streaming row, which is the last message there is, so its comments end up
  // at the tail and the live row (drawn by the caller) comes after them.
  const anchoredTo = new Map<string, TaskComment[]>();
  const floating: TaskComment[] = [];
  for (const c of visible) {
    const carrier = c.messageId ? byId.get(c.messageId) : undefined;
    if (carrier) {
      const list = anchoredTo.get(carrier.id);
      if (list) list.push(c);
      else anchoredTo.set(carrier.id, [c]);
    } else floating.push(c);
  }
  for (const list of anchoredTo.values()) list.sort((a, b) => instantOf(a.createdAt).localeCompare(instantOf(b.createdAt)));

  const out: TimelineItem[] = [];
  const push = (c: TaskComment) => {
    out.push(commentItem(c, deliveryOf(c, delivered, newestEnvelopeAt, opts.status), prevByComment));
  };

  let ci = 0;
  let mi = 0;
  while (ci < floating.length || mi < rows.length) {
    const c = floating[ci];
    const m = rows[mi];
    // Tie goes to the comment: at the same instant the words a person or an
    // agent DECLARED read before the step that produced them.
    const takeComment = c !== undefined && (m === undefined || instantOf(c.createdAt) <= instantOf(m.timestamp));
    if (takeComment) {
      push(c!);
      ci++;
      continue;
    }
    out.push(sessionItem(m!, prevByMsg));
    for (const anchoredComment of anchoredTo.get(m!.id) ?? []) push(anchoredComment);
    mi++;
  }
  return out;
}
