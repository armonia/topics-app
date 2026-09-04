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
import { closeGoal, getActiveGoal, setGoalLoop } from "./goals";
import {
  GOAL_JUDGE_PROMPT,
  goalLoopStep,
  goalNudgeText,
  goalStopNotice,
  parseGoalVerdict,
  turnCanContinueGoal,
  type FinishedTurn,
} from "./goal-loop";

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
  resend: (input: { sessionKey: string; text: string; attempt: number }) => Promise<void>;
  /** Push the topic's current goal to every client (`goal:updated`). */
  announce: (topicId: string) => void;
  broadcast: (msg: OutboundMessage) => void;
  log?: (msg: string) => void;
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

  return async function onTurnEnd(info: TurnEndInfo): Promise<string> {
    let goal;
    try {
      goal = getActiveGoal(deps.db, info.topicId);
    } catch (err) {
      log(`goal-loop: cannot read the goal (${err instanceof Error ? err.message : String(err)})`);
      return "error";
    }
    if (!turnCanContinueGoal(info, goal)) return "skipped";
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
        text: goalNudgeText(active.content),
        attempt: action.attempt,
      });
    } catch (err) {
      log(`goal-loop: the continuation did not go through (${err instanceof Error ? err.message : String(err)})`);
    }
    return "continued";
  };
}
