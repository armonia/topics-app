import type { ToolCall, ToolUserResponse } from '@/types';
import { isActiveTool } from '../components/Chat/toolGrouping';

/**
 * WHAT A `stream:tool_update` ACTUALLY CHANGES ON THE ROW.
 *
 * For a long time this event meant one thing only: "here is more output".
 * The handler entered exclusively when `typeof partialResult === 'string'`,
 * which was true for the streaming case it was written for.
 *
 * It was also used, by three different server sites, to announce that an
 * answered question had gone back to running - and those three sent no
 * `partialResult`, because there is no output to show. So the announcement was
 * dropped on the floor. The form that had just been submitted stayed grey with
 * a spinner and the word "Invio…", the options stayed disabled, and the row
 * kept its amber "waiting for you" dot, while the new turn scrolled underneath.
 * Reported, in the user's own words:
 * "graficamente le domande restano in invio anche se vanno avanti" // allow-italian: quoted report
 *
 * On the plan branch it was permanent: that panel hangs off a tool the server
 * back-marks at the end of the turn, so no provider will ever emit a
 * `stream:tool_result` for that id. There was no second chance.
 *
 * The two meanings are now separated here, where they can be measured. The
 * partial is a DELTA on the output; the status is a FACT about the row. An
 * event may carry either, both, or neither.
 */

/** The fields a tool-update event is allowed to change. */
export interface ToolUpdatePatch {
  /** Present only when the event announced one. */
  status?: ToolCall['status'];
  /** The answer the person gave, so the row can show it without a reload. */
  userResponse?: ToolUserResponse;
  /** A question the person ended without answering, and how. */
  askEnded?: ToolCall['askEnded'];
  /** The process that asked is gone; the question stays open. */
  askerGone?: boolean;
  /** An answer on its way to the model as a message, and whether it got there. */
  answerRelay?: ToolCall['answerRelay'];
}

/** The shape read off the wire. Loose on purpose: the schema is loose too. */
export interface ToolUpdateEvent {
  toolCallId?: string;
  partialResult?: unknown;
  status?: unknown;
  userResponse?: unknown;
  askEnded?: unknown;
  askerGone?: unknown;
  answerRelay?: unknown;
}

const KNOWN_STATUSES = ['pending', 'running', 'success', 'error', 'waiting_for_input', 'awaiting_permission'] as const;

function isKnownStatus(v: unknown): v is ToolCall['status'] {
  return typeof v === 'string' && (KNOWN_STATUSES as readonly string[]).includes(v);
}

/**
 * The patch to apply, or `null` when the event says nothing about the row.
 *
 * An unknown status is REFUSED rather than written through: a typo on the wire
 * would otherwise park the row in a state no renderer knows, which is the same
 * stuck panel by another door.
 */
export function toolUpdatePatch(event: ToolUpdateEvent): ToolUpdatePatch | null {
  if (!event.toolCallId) return null;
  const patch: ToolUpdatePatch = {};
  if (isKnownStatus(event.status)) patch.status = event.status;
  if (event.userResponse !== undefined) patch.userResponse = event.userResponse as ToolUserResponse;
  if (event.askEnded === 'cancelled' || event.askEnded === 'superseded') patch.askEnded = event.askEnded;
  if (event.askerGone === true) patch.askerGone = true;
  if (event.answerRelay === 'queued' || event.answerRelay === 'sent') patch.answerRelay = event.answerRelay;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The row with a partial output written on it, or the row untouched once it
 * has closed (CHAT-TOOL-09).
 *
 * The partial REPLACES `result` with the whole current tail, which is what lets
 * the window you sent from receive it too: twice is the same state. What it
 * must never do is land on a row that has its result. In that window the result
 * arrives on the SSE and the partial on WS, two channels with no order between
 * them, so a partial still on the wire could overwrite the final output with
 * old text.
 */
export function withPartialResult(tc: ToolCall, partialResult: string): ToolCall {
  return isActiveTool(tc) ? { ...tc, result: partialResult } : tc;
}

/**
 * The row with a status announcement applied, or the row kept settled when the
 * announcement would reopen a tool that has already returned.
 *
 * The answer route broadcasts `running` for every submission, including a
 * second one from a stale panel (another window, a phone that reconnected with
 * its form still open) after the tool's result is in. The server's own writer
 * refuses that patch (`patchOpenTool`); the window you sent from must refuse it
 * too, or it shows a spinner on a finished tool until a reload.
 *
 * BUT THE ANSWER IN IT IS NOT STALE when the row has none yet. The bridge hands
 * the answer to the model before the route broadcasts it, and the model's tool
 * result travels on the SSE while this announcement travels on WS, with no
 * order between them: when the result won, the whole patch was dropped, answer
 * included, and the row showed the question with nothing under it until a
 * reload (reported 04/10, reproduced in `ask-user-question.spec.ts`). So the
 * status is refused and the answer is kept; a row that already has one keeps
 * its own, because a second submission is the stale one.
 */
export function withToolUpdate(tc: ToolCall, patch: ToolUpdatePatch): ToolCall {
  if (patch.status === 'running' && (tc.status === 'success' || tc.status === 'error')) {
    const { status: _refused, userResponse, ...rest } = patch;
    const late = userResponse && !tc.userResponse ? { userResponse } : {};
    return Object.keys(rest).length > 0 || late.userResponse ? { ...tc, ...rest, ...late } : tc;
  }
  return { ...tc, ...patch };
}

/** Statuses an announcement can never take a row out of. */
const PAST_ANNOUNCEMENT: ReadonlySet<ToolCall['status']> = new Set(['waiting_for_input', 'awaiting_permission', 'success', 'error']);

/**
 * The row with a re-announcement (`stream:tool_call` on WS, a `tool_calls`
 * delta on the SSE) merged in by id, without letting it move the row BACK.
 *
 * An announcement says the call is queued (`pending`), has started
 * (`running`) or, on the SSE, is asking the person (`waiting_for_input`). It
 * carries newer arguments, a `startedAt`, an `inputStreaming` mark, and those
 * are taken; its status is taken only when it is a step forward. A row asking
 * the person, waiting for a permission or already closed keeps its status, a
 * started call does not go back to queued, and a question already answered or
 * closed is not asked again.
 *
 * The native runtime starts a call and asks its question in the same tick
 * (`agent-loop.ts`): the `running` announcement leaves on the sender's SSE, the
 * form on WS, two channels with no order between them. When the SSE came
 * second, the plain spread put the row back to `running`, and the window the
 * message was sent from showed a spinner and a growing clock instead of the
 * form, while the other windows and the database said "waiting for you"
 * (reported 04/10, 4 runs out of 4; `chat-native-tool-phases.spec.ts`).
 */
export function withToolAnnouncement(tc: ToolCall, announced: ToolCall): ToolCall {
  // The question itself rides the SSE too, and it is a step forward, unless
  // the row already carries the answer that the WS brought first.
  if (announced.status === 'waiting_for_input') {
    const reopens = tc.userResponse != null || tc.status === 'success' || tc.status === 'error';
    return reopens ? { ...tc, ...announced, status: tc.status, userInputSchema: tc.userInputSchema } : { ...tc, ...announced };
  }
  const keepStatus = PAST_ANNOUNCEMENT.has(tc.status)
    || (tc.status === 'running' && announced.status === 'pending');
  return keepStatus ? { ...tc, ...announced, status: tc.status } : { ...tc, ...announced };
}
