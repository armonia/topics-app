/**
 * The side of the goal loop that touches the world: the judge call, the resend,
 * the row written in the chat. The decisions all live in `goal-loop.ts`, pure
 * and tested without a database.
 *
 * ── Why the resend goes through the chat route ───────────────────────────────
 * The same reason the boot resume does it (`lib/ripresa-boot.ts`): a turn built
 * here would be a second, quieter way of talking to a provider, with its own
 * bugs and none of the route's guarantees (idempotency, the 409 on a turn
 * already in flight, the checkpoint, the envelope, the activity bump). What
 * this file sends is a MESSAGE, and the route does what it always does with
 * one.
 *
 * ── Why it is marked, and not disguised as the human ─────────────────────────
 * The continuation is a `user` row, because that is the only role a provider
 * will answer, and it carries a `goal-nudge` block so the client can draw it as
 * one compact system line ("◎ Objective: continuing (3)") instead of a bubble
 * the human never typed. Without the marker the transcript would show the human
 * saying things they never said, which is the one thing an automatic loop must
 * not do to a conversation somebody will read tomorrow.
 *
 * ── Never fatal ──────────────────────────────────────────────────────────────
 * Every failure here (judge down, route refusing, database busy) ends the same
 * way: the goal stays active, nothing is written, and the next human message
 * carries on. A turn that has already finished must never fail because of what
 * we wanted to do AFTER it.
 */

import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../../shared/ws-outbound";
import type { Topic } from "../types";

/** The chat route, as narrow as this file needs it. */
type ChatRouteLike = (
  req: Request, url: URL, pathname: string, method: string,
) => Promise<Response | null>;
import { closeGoal, getActiveGoal, setGoalLoop } from "./goals";
import {
  GOAL_JUDGE_PROMPT,
  TOOL_BUDGET_RESUME_TEXT,
  goalLoopStep,
  goalNudgeText,
  goalStopNotice,
  parseGoalVerdict,
  toolBudgetResumeStep,
  toolBudgetStopNotice,
  turnCanContinueGoal,
  type FinishedTurn,
} from "./goal-loop";
import { insertRestartNotification, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { MAX_ITERATIONS } from "../providers/native/agent-loop";
import { sessionHasBackgroundWork } from "../providers";

export interface GoalContinuationDeps {
  db: Database;
  /**
   * One-shot completion on the cheapest model the host has. It receives the
   * turn as well as the prompt because the provider to ask is the TOPIC's one:
   * a judge hard-wired to a single provider would switch the whole feature off
   * on a host that does not have it.
   */
  judge: (prompt: string, info: TurnEndInfo) => Promise<string>;
  /**
   * Send the continuation message the way a client would. Resolves when the
   * turn it started is over: the loop is sequential by construction, so a
   * continuation can never overlap the turn it continues.
   */
  resend: (input: {
    sessionKey: string;
    text: string;
    attempt: number;
    /**
     * How the row is marked. `goal-nudge` (default) is the loop chasing an
     * objective; `ripresa` is the one-shot resume after OUR tool budget, drawn
     * by the client as a resume line, not as a goal continuation it never had.
     */
    mark?: "goal-nudge" | "ripresa";
  }) => Promise<void>;
  /** Push the topic's current goal to every client (`goal:updated`). */
  announce: (topicId: string) => void;
  broadcast: (msg: OutboundMessage) => void;
  log?: (msg: string) => void;
  /** A turn is in flight on this session: its own end decides, a check-in stays out. */
  isBusy?: (sessionKey: string) => boolean;
  /** The session's background work is still running, asked again when a check-in fires. */
  backgroundWork?: (sessionKey: string) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * When a goal deferred on background work checks in anyway, the way Claude Code
 * does (2.1.282: `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`, default 30, doubling up to
 * two hours, three check-ins, then paused until the next message). Without it a
 * background job that never reports, a dev server, a lost task, left the goal
 * active on the bar and nobody pursuing it.
 */
export const GOAL_CHECK_IN_MS = 30 * 60_000;
export const GOAL_CHECK_IN_LIMIT = 3;
export function goalCheckInDelayMs(spentCheckIns: number): number {
  return GOAL_CHECK_IN_MS * 2 ** Math.min(spentCheckIns, 2);
}

/** What the route hands over once a turn is finalized. */
export interface TurnEndInfo extends FinishedTurn {
  sessionKey: string;
  topicId: string;
}

/**
 * Write the one-line notice that explains a loop stopping by itself.
 *
 * Same shape as the boot's own notice (an assistant row hooked to the last one
 * by `parent_id`, so `loadActiveThread` reaches it), with a `goal-stop` block
 * carrying the REASON: the client renders its own translated sentence from
 * that, and the English text in `content` is what re-enters the model's
 * context on the next turn.
 */
function writeStopNotice(
  deps: GoalContinuationDeps,
  info: TurnEndInfo,
  text: string,
  reason: "capped" | "stalled",
): void {
  const { db } = deps;
  const id = crypto.randomUUID();
  const maxRow = db
    .query(`SELECT COALESCE(MAX(sort_order), -1) AS mo FROM messages WHERE session_key = ?`)
    .get(info.sessionKey) as { mo: number } | null;
  const last = db
    .query(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1`)
    .get(info.sessionKey) as { id: string } | null;
  db.run(
    `INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index)
     VALUES (?, ?, 'assistant', ?, ?, 0, ?, ?, ?, 0)`,
    [
      id,
      info.sessionKey,
      text,
      JSON.stringify([{ kind: "goal-stop", reason }]),
      new Date().toISOString(),
      (maxRow?.mo ?? -1) + 1,
      last?.id ?? null,
    ],
  );
  deps.broadcast({
    type: "message:new",
    topicId: info.topicId,
    sessionKey: info.sessionKey,
    role: "assistant",
    messageId: id,
    content: text,
    preview: text.slice(0, 100),
    // The block is what the client draws its one translated line from; without
    // it the live window printed the English `content` as a normal answer.
    blocks: [{ kind: "goal-stop", reason }],
  });
}

/**
 * The end of a turn, seen by the goal.
 *
 * Returns what it decided, which is what the tests read; the caller ignores it
 * (it is a fire-and-forget from inside the route's finalization).
 */
export function createGoalContinuation(deps: GoalContinuationDeps) {
  const log = deps.log ?? (() => {});
  /**
   * Sessions whose last turn was already the one-shot resume after OUR tool
   * budget. In memory on purpose: a restart forgets it, and the worst that
   * buys is one more resume on one chat, not a loop. Cleared by any turn that
   * ends on a decision (`end_turn`), so the next budget on that chat gets its
   * one resume again.
   */
  const resumedAfterBudget = new Set<string>();

  /**
   * THE TURN A GOAL IS WAITING TO JUDGE, per session: the last turn that ended
   * while its background work ran, with the check-in armed for it. In memory,
   * like the set above: a restart forgets it, and the next turn end judges.
   *
   * It is kept, and not just skipped, for two turns that would otherwise leave
   * the goal silent for good: a background job that never reports (a dev
   * server: the CLI never wakes, so no turn ends), and the empty wake that
   * often follows the last report ("No response requested."), which the route
   * discards and so never reaches the judge. The first gets the check-in, the
   * second hands the judge the turn that did the work.
   */
  const deferred = new Map<string, { info: TurnEndInfo; timer: unknown }>();
  /** Check-ins already spent on the current stretch of background work. */
  const checkInCount = new Map<string, number>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  function takeDeferred(sessionKey: string): TurnEndInfo | null {
    const d = deferred.get(sessionKey);
    if (!d) return null;
    if (d.timer != null) clearTimer(d.timer);
    deferred.delete(sessionKey);
    return d.info;
  }

  function defer(info: TurnEndInfo): string {
    const spent = checkInCount.get(info.sessionKey) ?? 0;
    const timer = spent < GOAL_CHECK_IN_LIMIT
      ? setTimer(() => { void checkIn(info.sessionKey); }, goalCheckInDelayMs(spent))
      : null;
    deferred.set(info.sessionKey, { info, timer });
    log(`goal-loop: ${info.sessionKey}: background work still running, the goal waits for the turn it wakes` +
      (timer ? ` (check-in in ${goalCheckInDelayMs(spent) / 60_000} min)` : " (check-ins paused until the next message)"));
    return "background";
  }

  async function checkIn(sessionKey: string): Promise<void> {
    const info = deferred.get(sessionKey)?.info;
    if (!info) return;
    // A turn in flight ends by itself, and its end decides. The deferred turn
    // stays for it: if that turn is the empty last wake, it is the one to judge.
    if (deps.isBusy?.(sessionKey)) { deferred.set(sessionKey, { info, timer: null }); return; }
    deferred.delete(sessionKey);
    checkInCount.set(sessionKey, (checkInCount.get(sessionKey) ?? 0) + 1);
    log(`goal-loop: ${sessionKey}: checking in on the goal after its background work ran without reporting`);
    await judge({ ...info, backgroundWork: false }, deps.backgroundWork?.(sessionKey) === true)
      .catch((err) => log(`goal-loop: the check-in failed (${err instanceof Error ? err.message : String(err)})`));
  }

  return async function onTurnEnd(info: TurnEndInfo): Promise<string> {
    if (info.end === "end_turn") resumedAfterBudget.delete(info.sessionKey);
    const waiting = takeDeferred(info.sessionKey);
    if (!info.backgroundWork) checkInCount.delete(info.sessionKey);
    let goal;
    try {
      goal = getActiveGoal(deps.db, info.topicId);
    } catch (err) {
      log(`goal-loop: cannot read the goal (${err instanceof Error ? err.message : String(err)})`);
      return "error";
    }
    if (info.backgroundWork && turnCanContinueGoal({ ...info, backgroundWork: false }, goal)) return defer(info);
    // The empty wake after the work reported: judge the turn that did it. Only
    // a wake the model closed by itself: a turn somebody stopped, or one that
    // failed, drops the waiting turn with it, or a Stop would buy a nudge.
    if (info.discarded && waiting && info.end === "end_turn" && !info.dispatched) {
      if (info.backgroundWork) return defer(waiting);
      return judge({ ...waiting, backgroundWork: false }, false);
    }
    return judge(info, false);
  };

  async function judge(info: TurnEndInfo, backgroundStillRunning: boolean): Promise<string> {
    let goal;
    try {
      goal = getActiveGoal(deps.db, info.topicId);
    } catch (err) {
      log(`goal-loop: cannot read the goal (${err instanceof Error ? err.message : String(err)})`);
      return "error";
    }
    if (!turnCanContinueGoal(info, goal)) {
      // No goal driving (or its loop stopped), but the turn was cut by OUR
      // budget of tool rounds: the work is saved and nobody asked to stop, so
      // it resumes ONCE. Measured 05/09/2026: a chat left mute for six hours
      // under a notice that promised "la ripresa continua".
      const step = toolBudgetResumeStep(info, resumedAfterBudget.has(info.sessionKey));
      if (step === "none") return "skipped";
      if (step === "stop") {
        resumedAfterBudget.delete(info.sessionKey);
        try {
          insertRestartNotification(deps.db as unknown as PartialSweepDb, info.sessionKey, { text: toolBudgetStopNotice(MAX_ITERATIONS) });
        } catch (err) {
          log(`goal-loop: ${info.sessionKey}: cannot write the tool-budget stop notice (${err instanceof Error ? err.message : String(err)})`);
        }
        log(`goal-loop: ${info.sessionKey}: tool budget hit twice in a row, handing over to the human`);
        return "tool-budget-stopped";
      }
      resumedAfterBudget.add(info.sessionKey);
      log(`goal-loop: ${info.sessionKey}: turn cut by the tool budget, resuming once`);
      try {
        await deps.resend({ sessionKey: info.sessionKey, text: TOOL_BUDGET_RESUME_TEXT, attempt: 1, mark: "ripresa" });
      } catch (err) {
        log(`goal-loop: the tool-budget resume did not go through (${err instanceof Error ? err.message : String(err)})`);
      }
      return "tool-budget-resumed";
    }
    const active = goal!;

    // The judge is the only cost of this file, and it is paid once per turn.
    let verdict = null as ReturnType<typeof parseGoalVerdict>;
    try {
      const answer = await deps.judge(
        GOAL_JUDGE_PROMPT({
          goal: active.content,
          steps: active.steps.map((s) => ({ content: s.content, status: s.status })),
          lastAssistantText: info.lastAssistantText,
        }),
        info,
      );
      verdict = parseGoalVerdict(answer ?? "");
      log(`goal-loop: judge said ${JSON.stringify((answer ?? "").slice(0, 40))} -> ${verdict ?? "unreadable"}`);
    } catch (err) {
      log(`goal-loop: the judge did not answer (${err instanceof Error ? err.message : String(err)})`);
      verdict = null;
    }

    const { action, loop } = goalLoopStep({
      verdict,
      counters: { continuations: active.continuations, idleTurns: active.idleTurns, state: active.loopState },
      usedTools: info.usedTools,
    });
    if (action.kind === "undecided") return "undecided";

    // THE COUNTERS GO DOWN BEFORE THE TURN IS BOUGHT. If the resend below dies
    // halfway, or the server dies with it, the attempt is still spent: the
    // alternative is a ceiling that only counts the continuations that
    // succeeded, which is not a ceiling.
    try {
      setGoalLoop(deps.db, active.id, loop);
    } catch (err) {
      log(`goal-loop: cannot write the counters, stopping (${err instanceof Error ? err.message : String(err)})`);
      return "error";
    }

    if (action.kind === "achieved") {
      try {
        closeGoal(deps.db, active.id, "achieved");
        deps.announce(info.topicId);
        log(`goal-loop: ${info.sessionKey}: objective reached, closed at the end of the turn`);
      } catch (err) {
        log(`goal-loop: cannot close the goal (${err instanceof Error ? err.message : String(err)})`);
      }
      return "achieved";
    }

    if (action.kind === "blocked") {
      deps.announce(info.topicId);
      log(`goal-loop: ${info.sessionKey}: waiting for the human, the objective stays open`);
      return "blocked";
    }

    if (action.kind === "capped" || action.kind === "stalled") {
      const text = goalStopNotice(action, active.content);
      try {
        if (text) writeStopNotice(deps, info, text, action.kind);
      } catch (err) {
        log(`goal-loop: cannot write the stop notice (${err instanceof Error ? err.message : String(err)})`);
      }
      deps.announce(info.topicId);
      log(`goal-loop: ${info.sessionKey}: loop stopped (${action.kind})`);
      return action.kind;
    }

    // `continue`: the bar shows the new count before the turn starts, so what
    // the human sees moving is the loop, not a chat answering by itself.
    deps.announce(info.topicId);
    log(`goal-loop: ${info.sessionKey}: continuation ${action.attempt} sent`);
    try {
      await deps.resend({
        sessionKey: info.sessionKey,
        text: goalNudgeText(active.content, { backgroundStillRunning }),
        attempt: action.attempt,
      });
    } catch (err) {
      log(`goal-loop: the continuation did not go through (${err instanceof Error ? err.message : String(err)})`);
    }
    return "continued";
  }
}

/**
 * The chat route's goal loop, wired.
 *
 * It lives here and not in `routes/chat.ts` for the same reason the rule lives
 * in `goal-loop.ts`: the route is already the longest file in the server, and
 * a mechanism whose pieces are scattered across it is one nobody re-reads. The
 * route keeps the ONE thing only it can give, which is itself: `useRoute` takes
 * the handler on the first request served, because a named function expression
 * is only in scope inside its own body.
 */
export function goalContinuationForChatRoute(deps: {
  ctx: {
    db: Database;
    getTopicById: (id: string) => Topic | null;
    broadcastToAll: (msg: OutboundMessage) => void;
    isStreaming: (sessionKey: string) => unknown;
  };
  resolveProvider: (topic?: Topic | null) => {
    name: string;
    complete: (
      messages: Array<{ role: "user"; content: string }>,
      options?: { model?: string },
    ) => Promise<{ content?: string | null }>;
  };
  log?: (msg: string) => void;
}) {
  const { ctx } = deps;
  let route: ChatRouteLike | null = null;

  const onTurnEnd = createGoalContinuation({
    db: ctx.db,
    // The judge runs on the TOPIC's provider, at its cheapest tier where the
    // provider has one. Cheapest and NOT the turn's model on purpose: this call
    // happens after every turn of every chat that has a goal, and a judge
    // costing a real fraction of the turn it guards is a judge somebody turns
    // off. `complete` is a single one-shot: no tools, no session.
    judge: async (prompt, info) => {
      const provider = deps.resolveProvider(ctx.getTopicById(info.topicId));
      const cheap = provider.name === "claude-code" ? { model: "claude-haiku-4-5" } : undefined;
      const answer = await provider.complete([{ role: "user", content: prompt }], cheap);
      return answer.content ?? "";
    },
    resend: async ({ sessionKey, text, attempt, mark }) => {
      if (!route) return;
      const url = new URL("http://localhost/api/chat");
      // The mark is what keeps the row honest: the message has to be a `user`
      // one (the only role a provider answers) and the block is what stops the
      // transcript from showing the human saying it. `goalNudge` draws the
      // objective's continuation; `ripresa` draws the same resume line the boot
      // uses, because a turn cut by our tool budget IS a resume, not a goal.
      const marks = mark === "ripresa" ? { ripresa: attempt } : { goalNudge: attempt };
      const resp = await route(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }], ...marks }),
        }),
        url, "/api/chat", "POST",
      );
      // The stream is drained to the end: the route finalizes the row when the
      // turn is over, not when it starts, and that finalization ends in this
      // same hook and decides whether to continue once more. Reading it is what
      // makes the loop sequential instead of a fan-out.
      if (resp?.body) {
        const reader = resp.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
      }
    },
    announce: (topicId) => {
      ctx.broadcastToAll({ type: "goal:updated", topicId, goal: getActiveGoal(ctx.db, topicId) });
    },
    broadcast: ctx.broadcastToAll,
    log: deps.log,
    isBusy: (sk) => !!ctx.isStreaming(sk),
    backgroundWork: sessionHasBackgroundWork,
  });

  return {
    /** The route hands itself over on the first request it serves. */
    useRoute(handler: ChatRouteLike) { route ??= handler; },
    onTurnEnd,
  };
}
