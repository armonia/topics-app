import { buildNotifyActionBundle, type NotifyAction, type NotifyActionRequest, type NotifyEvent } from "../shared/notify-actions";
import {
  chatErrorNotificationKey,
  chatNotificationKey,
  chatWaitingNotificationKey,
  taskParkedNotificationKey,
  taskReviewNotificationKey,
  type NotificationKind,
  type NotificationRecordInput,
} from "../shared/notification-log";
import { questionAsksHuman } from "../shared/board";
import { noticePromisesResume } from "./lib/cancelled-notice";

/**
 * WHAT A NEW EPOCH SAYS, AND WHAT A TURN END MEANS.
 *
 * Until notifications-redesign this module sniffed every `broadcastToAll`
 * frame (`maybeSendPush`) and decided, frame by frame, which one deserved a
 * push and a history row. The decision now belongs to the attention store
 * (`server/attention/store.ts`): a push and a row exist only for a NEW EPOCH,
 * the entry of a subject into `needs-you` or `finished` (design section 10).
 * What stays here is pure and has two jobs the store asks of it:
 *
 *   - `buildAnnouncement`: the words, the buttons and the link of that epoch
 *     (PUSH-04, PUSH-05 texts, unchanged);
 *   - `classifyTurnEnd`: what a chat turn's end is for the attention state,
 *     the gates the reply push used to apply on `stream:end`;
 *
 * plus `isTopicSilenced`, the mute gate, which the store reads before it
 * announces.
 */

/**
 * The payload the service worker receives. `actions` are the banner's BUTTONS
 * and `requests` says, for each, which call to make.
 *
 * The request travels already composed on purpose: sw.js is JS served apart,
 * outside the bundle, and cannot import `shared/notify-actions`. Sending it
 * only the id would force a copy of the `switch` that picks the endpoints into
 * it, the copy no test compiles. So the worker stays dumb: it runs what it
 * received, after checking that the path belongs to the board.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  actions?: NotifyAction[];
  requests?: Record<string, NotifyActionRequest>;
}

/** The push and the history row of one new epoch. */
export interface Announcement {
  push: PushPayload;
  record: NotificationRecordInput;
}

/** The fact a new epoch is about, as the store describes it. */
export type AnnounceFact =
  | { kind: "review"; subject: string; projectId?: string | null; taskId?: string | null; taskTitle?: string | null; question?: unknown; isAsk?: boolean | null }
  | { kind: "parked"; subject: string; projectId?: string | null; taskId?: string | null; taskTitle?: string | null; state?: string | null }
  | { kind: "finished"; subject: string; topicId?: string | null; terminalId?: string | null; name?: string | null; detail?: string | null }
  | { kind: "error"; subject: string; topicId?: string | null; terminalId?: string | null; name?: string | null; error?: string | null }
  | { kind: "waiting"; subject: string; reason: "question" | "permission" | "plan"; topicId?: string | null; terminalId?: string | null; taskId?: string | null; projectId?: string | null; name?: string | null; prompt?: string | null };

/**
 * Attach the buttons to the payload, only when there are some and only when
 * the task can be named: a button that does not know whom to talk to is not
 * drawn at all.
 */
function withActions(payload: PushPayload, event: NotifyEvent, projectId: string | null | undefined, taskId: string | null | undefined): PushPayload {
  if (!projectId || !taskId) return payload;
  const { actions, requests } = buildNotifyActionBundle(event, { projectId, taskId });
  if (actions.length === 0) return payload;
  return { ...payload, actions, requests };
}

/**
 * Where the click lands, not the home. `/task/<id>` is the same route as the
 * copyable links (`client/src/lib/openTaskLink.ts`), so it opens the right
 * drawer both in the app and from a closed window. Without an id, the home
 * instead of a broken URL.
 */
function taskUrl(taskId: unknown): string {
  return typeof taskId === "string" && taskId ? `/task/${taskId}` : "/";
}

/** The chat twin of `taskUrl`: `/topic/<id>` opens the chat's tab. */
function topicUrl(topicId: unknown): string {
  return typeof topicId === "string" && topicId ? `/topic/${topicId}` : "/";
}

/**
 * The pending question as it arrives, checked rather than trusted. The
 * difference between "no question" and "a question, malformed" decides WHICH
 * buttons appear: in the first case "Approve", in the second none. A broken
 * field read as "absent" would put an Approve button on a task waiting for an
 * answer.
 */
function readQuestion(raw: unknown): { text: string; options: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as { text?: unknown; options?: unknown };
  const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [];
  return { text: typeof q.text === "string" ? q.text : "", options };
}

function record(kind: NotificationKind, title: string, body: string, subject: string, dedupeKey: string, target: { kind: "task" | "topic"; id: string } | null): NotificationRecordInput {
  return {
    kind,
    title,
    body,
    targetKind: target?.kind ?? null,
    targetId: target?.id ?? null,
    dedupeKey,
    groupKey: subject,
    source: "push",
  };
}

/**
 * The words of a new epoch. `null` only when there is nothing to say (a fact
 * kind this module does not know).
 */
export function buildAnnouncement(fact: AnnounceFact): Announcement | null {
  // A chat, a terminal or a wait with nothing to name and nowhere to open is
  // no announce: it would wake someone without saying of what.
  if ((fact.kind === "finished" || fact.kind === "error" || fact.kind === "waiting")
    && !fact.topicId && !fact.terminalId && !(fact.kind === "waiting" && fact.taskId)) return null;
  switch (fact.kind) {
    case "review": {
      // A delivery that IS a question is announced as one: the body carries
      // the question and the buttons are its options. WHICH of the two it is
      // comes from `isAsk` (decided on the raw comment, it saw more) and,
      // when absent, from `questionAsksHuman`, never from "there is a question
      // block": the kickoff envelope orders every landable delivery to attach
      // `options=["Landa su main"]`, wrapped in that very fence.
      const question = readQuestion(fact.question);
      const asksHuman = fact.isAsk ?? questionAsksHuman(question);
      const title = asksHuman ? "❓ L'agent ti sta chiedendo una cosa" : "📋 Task pronto per la review";
      const body = question?.text || fact.taskTitle || "Un task è pronto per la review";
      const push = withActions({ title, body, tag: `task-review-${fact.taskId || "new"}`, url: taskUrl(fact.taskId) },
        { kind: "review-ready", question }, fact.projectId, fact.taskId);
      return { push, record: record("task-review", title, body, fact.subject, taskReviewNotificationKey(fact.taskId || "new"), fact.taskId ? { kind: "task", id: fact.taskId } : null) };
    }
    case "parked": {
      // Three states, three titles: `waited_out` is no failure and nothing to
      // repair, the decision goes back to the person.
      const title = fact.state === "blocked"
        ? "🔧 Task da sistemare"
        : fact.state === "waited_out"
          ? "⏳ Task in attesa, decidi tu"
          : "⛔️ Task non consegnato";
      const body = fact.taskTitle || "Un task è stato parcheggiato";
      const push = withActions({ title, body, tag: `task-park-${fact.taskId || "new"}`, url: taskUrl(fact.taskId) },
        { kind: "parked" }, fact.projectId, fact.taskId);
      return { push, record: record("task-parked", title, body, fact.subject, taskParkedNotificationKey(fact.taskId || "new"), fact.taskId ? { kind: "task", id: fact.taskId } : null) };
    }
    case "finished": {
      if (fact.terminalId) {
        const title = fact.name ? `💬 ${fact.name}` : "💬 Il terminale ha finito";
        const body = "Il terminale ha finito il turno";
        return { push: { title, body, tag: fact.subject, url: "/" }, record: record("terminal", title, body, fact.subject, fact.subject, null) };
      }
      // The reply push has no buttons: there is no click that answers.
      const title = fact.name ? `💬 ${fact.name}` : "💬 Risposta pronta";
      const body = "Claude ha finito di rispondere";
      return {
        push: { title, body, tag: `chat-end-${fact.topicId}`, url: topicUrl(fact.topicId) },
        record: record("chat-message", title, body, fact.subject, chatNotificationKey(fact.topicId || fact.subject), fact.topicId ? { kind: "topic", id: fact.topicId } : null),
      };
    }
    case "error": {
      const title = fact.name ? `⚠️ ${fact.name}` : fact.terminalId ? "⚠️ Il terminale si è fermato" : "⚠️ La chat si è fermata";
      // The notice already opens with the warning sign the title carries.
      const body = (fact.error ?? "").trim().replace(/^⚠️\s*/, "").slice(0, 120) || "Il turno si è fermato";
      if (fact.terminalId) {
        return { push: { title, body, tag: fact.subject, url: "/" }, record: record("terminal", title, body, fact.subject, `${fact.subject}:error`, null) };
      }
      return {
        push: { title, body, tag: `chat-error-${fact.topicId}`, url: topicUrl(fact.topicId) },
        record: record("chat-error", title, body, fact.subject, chatErrorNotificationKey(fact.topicId || fact.subject), fact.topicId ? { kind: "topic", id: fact.topicId } : null),
      };
    }
    case "waiting": {
      const prompt = (fact.prompt ?? "").trim();
      if (fact.taskId) {
        const title = "❓ L'agent ti sta chiedendo una cosa";
        const body = prompt ? prompt.slice(0, 120) : fact.name || "Un agente aspetta una tua risposta";
        return { push: { title, body, tag: `task-wait-${fact.taskId}`, url: taskUrl(fact.taskId) }, record: record("session", title, body, fact.subject, `task-wait:${fact.taskId}`, { kind: "task", id: fact.taskId }) };
      }
      const title = fact.name ? `❓ ${fact.name}` : "❓ Claude ti sta aspettando";
      const body = prompt ? prompt.slice(0, 120) : "Claude aspetta una tua risposta per andare avanti";
      if (fact.terminalId) {
        return { push: { title, body, tag: fact.subject, url: "/" }, record: record("terminal", title, body, fact.subject, `${fact.subject}:wait`, null) };
      }
      return {
        push: { title, body, tag: `chat-wait-${fact.topicId}`, url: topicUrl(fact.topicId) },
        record: record("session", title, body, fact.subject, chatWaitingNotificationKey(fact.topicId || fact.subject), fact.topicId ? { kind: "topic", id: fact.topicId } : null),
      };
    }
  }
  return null;
}

/** The fields of a chat turn's end that decide what it is. */
export interface TurnEndFacts {
  completed?: boolean;
  reason?: string;
  error?: string;
  stopCause?: string;
  stopReason?: string;
  /** A board agent's turn: its card speaks for it (T12). */
  dispatched?: boolean;
  /** The empty row was thrown away: nothing to read. */
  discarded?: boolean;
}

/**
 * What a chat turn's end is for the attention state (design section 4.2):
 *
 *   - `done`: a clean end with something to read (`completed`, the model
 *     closed by itself, and the row was not discarded). T2, T3.
 *   - `error`: the turn died and left its notice, whoever cut it (the API,
 *     the watchdog, the output cap): a fact the person must see. T10.
 *   - `resumes`: an error the system resumes by itself (a server shutdown, an
 *     outage whose notice promises the resume): no epoch, the resend reopens
 *     the turn. T10b.
 *   - `null`: nothing to announce (a stop of the person, a stale sweep, an
 *     unclean end without a notice, an empty woken turn). T12, T17.
 */
export function classifyTurnEnd(end: TurnEndFacts): { outcome: "done" | "error" | null; resumes: boolean; detail: string | null } {
  // A board agent's turn, whatever its end: the card is the subject (rule 2).
  if (end.dispatched === true) return { outcome: null, resumes: false, detail: null };
  const errorText = typeof end.error === "string" ? end.error.trim() : "";
  if (end.reason === "error" && errorText) {
    const resumes = end.stopCause === "server-shutdown" || noticePromisesResume(errorText);
    return { outcome: resumes ? null : "error", resumes, detail: errorText.replace(/^⚠️\s*/, "").slice(0, 200) };
  }
  // The clean end: marked complete, not a stop of the person, not the
  // watchdog's cut. The client no longer judges a turn end on its own, so this
  // is the only copy of the rule.
  const clean = end.completed === true && end.reason !== "user_abort" && end.stopCause !== "watchdog" && end.stopReason !== "cancelled";
  if (clean && !end.discarded) return { outcome: "done", resumes: false, detail: null };
  return { outcome: null, resumes: false, detail: null };
}

/**
 * The least `isTopicSilenced` needs. STRUCTURAL shape, not `Topic`: a whole
 * `Topic` satisfies it (that is how the app context calls it), but the module
 * stays free of the schema and the test mounts three fields instead of twenty.
 */
export type SilenceableTopic = {
  archived?: boolean | null;
  muted?: boolean | null;
  projectPath?: string | null;
};

/**
 * Should this topic be silenced? PURE decision, three independent sources of
 * mute, any one is enough:
 *   - `archived`: a chat the interface no longer shows;
 *   - `muted`: per-topic mute (migration 073);
 *   - the project in `mutedProjects`: per-project mute, keyed by
 *     `projectPath`, compared EXACTLY (a prefix is not the project).
 *
 * A topic that does not exist is silenced: there is nothing to name, and a
 * push is an interruption on a phone. The client has no twin of this gate any
 * more: its banner rides the server's `announce`.
 */
export function isTopicSilenced(
  topic: SilenceableTopic | null | undefined,
  mutedProjects: readonly string[] | null | undefined,
): boolean {
  if (!topic) return true;
  if (topic.archived || topic.muted) return true;
  const proj = topic.projectPath;
  if (!proj) return false;
  return (mutedProjects ?? []).includes(proj);
}
