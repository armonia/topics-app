/**
 * A CARD IN AI REVIEW IS TOLD TO WHOEVER HAS TO CLOSE IT (rule of 28/10:
 * whoever opens a card closes it).
 *
 * On a board with AI review (`shared/workflow.ts`) a delivery on a card an
 * agent or a schedule opened goes back to whoever opened it instead of to the
 * person. Without a word to that opener the card sat in the column and nobody
 * looked at it: the first review of this branch found exactly that. So every
 * entry into AI review, from any door (`update`, the system delivery), asks
 * for a notice, and the notice does three things:
 *
 *  - `task:ai-review` on the socket and an activity_log row (category
 *    `board`), the same pair `task:unowned` leaves, so a coordinator that is
 *    not connected still reads it;
 *  - a WAKE of the opener's topic, when the card names one
 *    (`created_by_topic_id`) and that chat can still take a turn;
 *  - otherwise a wake of the global coordinator: most machine cards are opened
 *    by the board API (`agent:api`) or a schedule, which have no chat to wake,
 *    and the coordinator is the one agent allowed to close them in their place.
 *
 * A reminder (`sweepStaleAiReview`, every reconcile) goes to the coordinator
 * when a card is still in AI review long after its last touch: that is also
 * the path that survives a restart, since the wake itself lives in memory. A
 * reminder that reached somebody is sent once per touch; one that reached
 * nobody (`onUndelivered`) is tried again at a later sweep.
 *
 * The wake is a `user` row through the chat route, marked as the board's
 * (`dispatched`), sent only when the session has no turn in flight, the same
 * road `services/subagent-wake.ts` takes.
 */

import type { ActivityLogEntry } from "../db/activity-log";
import type { OutboundMessage } from "../../shared/ws-outbound";

type ChatRoute = (req: Request, url: URL, pathname: string, method: string) => Response | null | Promise<Response | null>;

export interface AiReviewNotice {
  taskId: string;
  projectId: string;
  title: string;
  /** `agent:<name>` / `cron:<name>`; who the column sends the card back to. */
  createdBy: string | null;
  /** The opener's chat, when the card was opened from one. */
  openerTopicId: string | null;
  /** A reminder from the sweep goes to the coordinator, not to the opener. */
  reminder?: boolean;
  /**
   * Called when nobody could be woken (every try failed, or there was nobody
   * to wake). The sweep uses it to take its stamp back, so a reminder that did
   * not reach anybody is sent again instead of leaving the card silent.
   */
  onUndelivered?: () => void;
}

export interface AiReviewNoticeDeps {
  route: ChatRoute;
  /** A turn in flight on the session. */
  isBusy(sessionKey: string): boolean;
  /** The session of a topic, `null` when it is gone. */
  sessionKeyOfTopic(topicId: string): string | null;
  /** `wake`: send now. `wait`: not now (provider held). `row`: this chat cannot take a turn. */
  canWake(sessionKey: string): "wake" | "wait" | "row";
  /** The eligible global coordinator's session, `null` when there is none. */
  coordinatorSessionKey(): string | null;
  /** Any global coordinator's session (eligible or not): it has no project, so it closes with the global tools. */
  isCoordinatorSession?(sessionKey: string): boolean;
  broadcast(msg: OutboundMessage): void;
  recordActivity(entry: ActivityLogEntry): void;
  log?: (msg: string) => void;
  pollMs?: number;
  /** How long a wake waits for a busy session before giving up on it. */
  maxWaitMs?: number;
  /** Tries per session before the next one is woken (or the notice is given up). */
  attempts?: number;
  /** Pause before the second try; it doubles at every further one. */
  retryMs?: number;
}

/**
 * The words of the wake, in English like every machine message an agent
 * reads. The title is the card's own text: inside quotes, with its `<`
 * neutralised, so it reads as data.
 */
export function aiReviewWakeText(n: AiReviewNotice, closer: "opener" | "coordinator", globalTool = closer === "coordinator"): string {
  const title = n.title.replace(/</g, "<\\").replace(/"/g, "'");
  // The coordinator's session has no project of its own: `update_task` there
  // answers `no_project`, so whatever card it closes, it closes with the
  // global tool, the cards it opened itself included.
  const how = globalTool ? "update_global_task" : "update_task";
  const read = globalTool ? "get_global_task" : "get_task";
  const lead = n.reminder
    ? "A card has been sitting in AI review with nobody closing it."
    : closer === "coordinator"
      ? "A card opened by an agent or a schedule with no chat of its own was delivered and sits in AI review: you close it in its opener's place."
      : "A card you opened was delivered and sits in AI review: it is yours to close, nobody else will look at it.";
  return [
    `<card-ai-review task_id="${n.taskId}" project_id="${n.projectId}" opened_by="${n.createdBy ?? "unknown"}" title="${title}">`,
    lead,
    `Read the delivery against the acceptance bar in the description (${read}), then one of:`,
    `- it holds: ${how}(status='done', summary=<the proof: what you checked, the command and its exit, where it can be seen>);`,
    `- the person has to see or decide something: ${how}(stage='human_review', human_ask=<the question for them>);`,
    "- it does not hold: comment what is missing on the card and send it back to work.",
    "</card-ai-review>",
  ].join("\n");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createAiReviewNotices(deps: AiReviewNoticeDeps) {
  const pollMs = deps.pollMs ?? 1_000;
  const maxWaitMs = deps.maxWaitMs ?? 6 * 60 * 60 * 1000;

  const attempts = Math.max(1, deps.attempts ?? 3);
  const retryMs = deps.retryMs ?? 60_000;

  /** `globalTool`: the session is the coordinator's, which closes with the global tools. */
  type Target = { sessionKey: string; closer: "opener" | "coordinator"; globalTool: boolean };

  /** Whom to wake, in order: the opener's chat when it can take a turn, then the coordinator. */
  function targets(n: AiReviewNotice): Target[] {
    const out: Target[] = [];
    const coordinator = deps.coordinatorSessionKey();
    if (!n.reminder && n.openerTopicId) {
      const sk = deps.sessionKeyOfTopic(n.openerTopicId);
      // A card the coordinator opened (the global route stamps its topic) is
      // its own to close, but with the global tools: its session has no
      // project, and `update_task` there answers `no_project`.
      if (sk && deps.canWake(sk) !== "row") out.push({ sessionKey: sk, closer: "opener", globalTool: sk === coordinator || !!deps.isCoordinatorSession?.(sk) });
    }
    if (coordinator && !out.some((t) => t.sessionKey === coordinator)) out.push({ sessionKey: coordinator, closer: "coordinator", globalTool: true });
    return out;
  }

  /** `null` = woken; otherwise why not, for the log. */
  async function wake(sessionKey: string, text: string): Promise<string | null> {
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > maxWaitMs) return "the session stayed busy";
      if (deps.isBusy(sessionKey) || deps.canWake(sessionKey) === "wait") { await sleep(pollMs); continue; }
      const url = new URL("http://localhost/api/chat");
      const resp = await deps.route(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }], dispatched: true }),
        }),
        url, "/api/chat", "POST",
      );
      if (resp?.status === 409) {
        const code = ((await resp.clone().json().catch(() => null)) as { code?: unknown } | null)?.code;
        if (code === "stream_in_flight") { await sleep(pollMs); continue; }
      }
      if (!resp?.ok) return `the chat route answered ${resp?.status ?? "nothing"}: ${resp ? (await resp.text().catch(() => "")).slice(0, 200) : ""}`;
      // The turn runs on its own: the stream is not ours to read.
      if (resp.body) void resp.body.cancel().catch(() => {});
      return null;
    }
  }

  /**
   * A FAILED WAKE IS NOT THE END OF THE NOTICE. Each session gets `attempts`
   * tries with a growing pause (a route that answered 500 or a provider that
   * dropped the request often takes the next one); when the opener's chat
   * still refuses, the coordinator is woken in its place, since it may close
   * the card too. Only when nobody could be woken is the notice given up, with
   * a row in activity_log: the sweep reminds the coordinator later anyway.
   */
  async function deliver(n: AiReviewNotice, list: Target[]): Promise<void> {
    const reasons: string[] = [];
    for (const to of list) {
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(retryMs * 2 ** (i - 1));
        let why: string | null;
        try { why = await wake(to.sessionKey, aiReviewWakeText(n, to.closer, to.globalTool)); }
        catch (err) { why = err instanceof Error ? err.message : String(err); }
        if (why === null) { deps.log?.(`${n.taskId}: ${to.closer} woken`); return; }
        deps.log?.(`${n.taskId}: ${to.closer} not woken (try ${i + 1}/${attempts}), ${why}`);
        reasons.push(`${to.closer}: ${why}`);
        // A session busy for the whole wait gets no more tries of its own.
        if (why === "the session stayed busy") break;
      }
    }
    try { n.onUndelivered?.(); } catch (err) { deps.log?.(`${n.taskId}: ${err instanceof Error ? err.message : String(err)}`); }
    deps.recordActivity({
      category: "board", level: "warn", title: "AI review notice not delivered",
      detail: `${n.title || "Task"}: ${reasons.join("; ").slice(0, 400)}`,
      entityType: "task", entityId: n.taskId, actor: n.createdBy ?? undefined,
      metadata: { projectId: n.projectId, reasons },
    });
  }

  function request(n: AiReviewNotice): void {
    const list = targets(n);
    const to = list[0] ?? null;
    deps.broadcast({
      type: "task:ai-review", projectId: n.projectId, taskId: n.taskId, taskTitle: n.title || "Task",
      createdBy: n.createdBy, reminder: !!n.reminder, notified: to?.closer ?? null,
    });
    deps.recordActivity({
      category: "board", level: n.reminder ? "warn" : "info",
      title: n.reminder ? "card left in AI review" : "card in AI review",
      detail: `${n.title || "Task"} → ${to ? (to.closer === "opener" ? "its opener" : "the coordinator") : "nobody to wake"}`,
      entityType: "task", entityId: n.taskId, actor: n.createdBy ?? undefined,
      metadata: { projectId: n.projectId, createdBy: n.createdBy, openerTopicId: n.openerTopicId, reminder: !!n.reminder, notified: to?.closer ?? null },
    });
    if (list.length === 0) {
      try { n.onUndelivered?.(); } catch (err) { deps.log?.(`${n.taskId}: ${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    void deliver(n, list).catch((err) => deps.log?.(`${n.taskId}: ${err instanceof Error ? err.message : String(err)}`));
  }

  return { request };
}

let notices: ReturnType<typeof createAiReviewNotices> | null = null;
/** Notices asked for before the chat route was ready (the boot). */
const waiting: AiReviewNotice[] = [];
const WAITING_CAP = 200;

/** Ask for a notice. Before `startAiReviewNotices` it waits for it. */
export function requestAiReviewNotice(n: AiReviewNotice): void {
  if (notices) { notices.request(n); return; }
  if (waiting.length < WAITING_CAP) waiting.push(n);
}

export function startAiReviewNotices(deps: AiReviewNoticeDeps): void {
  notices = createAiReviewNotices(deps);
  for (const n of waiting.splice(0)) notices.request(n);
}

/** For tests: the notices asked for while nothing was started, taken out of the queue. */
export function _takeWaitingAiReviewNotices(): AiReviewNotice[] {
  return waiting.splice(0);
}

/** For tests. */
export function _resetAiReviewNotices(): void {
  notices = null;
  waiting.length = 0;
}
