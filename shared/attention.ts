/**
 * THE ATTENTION STATE OF A SUBJECT, as the server composes it and every surface
 * reads it (openspec change notifications-redesign, design §2).
 *
 * A subject is a chat (`topic:<id>`), a terminal (`terminal:<id>`) or a board
 * card (`task:<id>`). It has ONE state, composed on the server by
 * `server/attention/compose.ts` and written by `server/attention/store.ts`, the
 * only writer; the client fills its store from `attention:init` and
 * `attention:updated` and derives every tab, row, count and banner from it.
 *
 * Only the types and the subject keys live here: the composition rules are the
 * server's, so that two copies cannot diverge.
 */

import type { NotifyAction, NotifyActionRequest } from "./notify-actions";

/**
 * `working` covers a turn open AND a closed turn whose tasks still run: a job
 * the chat waits for is work in progress, not a state of its own.
 */
export const ATTENTION_STATES = ["idle", "working", "needs-you", "finished"] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

/** Why a subject needs the person. */
export type AttentionReason = "question" | "permission" | "plan" | "review" | "parked";

/** How the last turn of a `finished` subject ended. */
export type AttentionOutcome = "done" | "error";

/** One task a closed turn left running, by the id its tool returned. */
export interface AttentionTask {
  id: string;
  /** `bash`, `agent`, `workflow`, `monitor`, `cron`, `command`, `wake`... */
  kind: string;
  /** What the person reads: the command, the agent's description, the schedule. */
  label: string;
  startedAt: string;
  /** A recurring cron: shown, never counted as a wait. */
  recurring?: boolean;
}

/** The task map as the store keeps it: task id to what it is. */
export type AttentionTaskMap = Record<string, Omit<AttentionTask, "id">>;

/** What a subject looks like on the wire, in `attention:init` and `attention:updated`. */
export interface AttentionSnapshot {
  subject: string;
  state: AttentionState;
  reason: AttentionReason | null;
  outcome: AttentionOutcome | null;
  /** One line: the question, the tool, the reason of the park, the error. */
  detail: string | null;
  /** When the subject entered this state. */
  since: string;
  epoch: number;
  seenEpoch: number;
  /** `needs-you`, or `finished` with its turn not seen. */
  lit: boolean;
  /** The chat's unread messages (0 for anything but a chat). */
  unread: number;
  /** The last turn closed after the person last looked: a focused pane sends its seen for it. */
  turnUnseen: boolean;
  lastTurnAt: string | null;
  /** Every task in flight, recurring crons included. */
  background: AttentionTask[];
}

/** The banner and push of a new epoch, decided once on the server (design §10.1). */
export interface AttentionAnnounce {
  title: string;
  body: string;
  /** The subject: a second announce of the same subject replaces the first. */
  tag: string;
  url: string;
  /** The buttons (PUSH-04), with the call each one makes. */
  actions?: NotifyAction[];
  requests?: Record<string, NotifyActionRequest>;
}

/** One entry of the seen door, `POST /api/attention/seen`. */
export interface AttentionSeenItem {
  subject: string;
  /** The epoch the client was showing: a newer one stays lit. */
  epoch: number;
  /** The `lastTurnAt` the client was showing: a newer turn stays unseen. */
  turnAt?: string | null;
}

/**
 * How long a pane stays in front, window awake, before it counts as seen
 * (`client/src/state/signals.ts` says why 1200 ms). The server reads it too:
 * a sub-agent kept in front this long is engaged.
 */
export const SEEN_DWELL_MS = 1200;

export const TOPIC_SUBJECT_PREFIX = "topic:";
export const TERMINAL_SUBJECT_PREFIX = "terminal:";
export const TASK_SUBJECT_PREFIX = "task:";
export const SYSTEM_SUBJECT_PREFIX = "system:";

export function topicSubject(topicId: string): string {
  return `${TOPIC_SUBJECT_PREFIX}${topicId}`;
}

export function terminalSubject(terminalId: string): string {
  return `${TERMINAL_SUBJECT_PREFIX}${terminalId}`;
}

export function taskSubject(taskId: string): string {
  return `${TASK_SUBJECT_PREFIX}${taskId}`;
}

export function systemSubject(key: string): string {
  return `${SYSTEM_SUBJECT_PREFIX}${key}`;
}

/** `topic:<id>` -> `<id>`, anything else -> null. */
export function topicIdOfSubject(subject: string): string | null {
  return subject.startsWith(TOPIC_SUBJECT_PREFIX) ? subject.slice(TOPIC_SUBJECT_PREFIX.length) || null : null;
}

/** `task:<id>` -> `<id>`, anything else -> null. */
export function taskIdOfSubject(subject: string): string | null {
  return subject.startsWith(TASK_SUBJECT_PREFIX) ? subject.slice(TASK_SUBJECT_PREFIX.length) || null : null;
}

/** `terminal:<id>` -> `<id>`, anything else -> null. */
export function terminalIdOfSubject(subject: string): string | null {
  return subject.startsWith(TERMINAL_SUBJECT_PREFIX) ? subject.slice(TERMINAL_SUBJECT_PREFIX.length) || null : null;
}

/** A subject the attention store keeps a state for (not a `system:` notice). */
export function isAttentionSubject(subject: string): boolean {
  return [TOPIC_SUBJECT_PREFIX, TERMINAL_SUBJECT_PREFIX, TASK_SUBJECT_PREFIX].some((p) => subject.startsWith(p) && subject.length > p.length);
}
