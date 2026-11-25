/**
 * THE TURN A `turn-end` HOOK ASKS FOR (HOOKS-04), Claude Code's Stop hook on
 * the native runtime.
 *
 * A `turn-end` command that exits 0 and prints `{"decision":"block","reason":
 * "<text>"}` (`lifecycle-hooks.ts` parses it) gets `<text>` sent to the same
 * chat as the next turn, so the agent carries on with its whole context and
 * its tools. The use that asked for it: an agent whose report says the session
 * can be closed is asked by a hook to run its own retrospective and apply it.
 *
 * ── Through the chat route, like the goal loop ───────────────────────────────
 * The text goes out through `ChatGoalLoop.resend`, the same door the goal loop
 * uses, for the same reason (`goal-continuation.ts` header): a second way of
 * talking to the provider would skip the route's guarantees, the 409 on a turn
 * already in flight first. The row is a `user` one marked `hook-nudge`, so the
 * transcript draws one service line and never the person saying it.
 *
 * ── The brakes ───────────────────────────────────────────────────────────────
 * THE COUNTER IS THE DATABASE: the `hook-nudge` rows written since the last
 * row the person typed (`hookChainLength`). Not the request body: a machine
 * turn in between (the goal loop, a wake, the tool-budget or boot resume)
 * carries no hook attempt, and a counter read from the body restarted at zero
 * on each of them and looped forever (review of PR 1623). Read from the rows,
 * machine rows and resumes are skipped, only the person's words reset it, and
 * it survives a restart. Past
 * `HOOK_CONTINUATION_LIMIT` the request is ignored and logged; a chain already
 * started is what the hook reads as `stop_hook_active`.
 *
 * Not continued either, each with a line in the log:
 * - a turn that did not end on its own (stopped, failed, discarded) or left a
 *   question waiting on the person: Claude Code does not run Stop on an
 *   interrupt either;
 * - a turn that is no longer the chat's last word when the hook answers (it
 *   may take 60 s): something newer happened, and the verdict is stale;
 * - a native sub-agent's chat: a nudge would set a retired child running
 *   again, and its parent drives it (`send_to_agent`);
 * - a turn end for which the goal loop really bought a turn (continuation or
 *   tool-budget resume): ONE turn per turn end, and the goal loop decides
 *   first; the hook's request waits for its outcome (`goalBoughtTurn`). A goal
 *   achieved, capped or stalled leaves the end to the hook.
 *
 * Known and accepted (fails on the safe side): after a restart that cut a
 * turn, the resume's copy of an interrupted person message may leave the
 * ceiling closed until the person writes again.
 *
 * ── Never fatal ──────────────────────────────────────────────────────────────
 * The turn that ended is over and written. Whatever goes wrong here (the route
 * refusing with a 409 because another turn took the session, a thrown error)
 * is a line in the log and nothing else.
 */

import type { ContinuationMark } from "./goal-continuation";
import { decodeCol } from "../../shared/message-blob";
import { hasMachineMark } from "../../shared/prompt-number";

/** Consecutive hook continuations a session may chain before the request is ignored. */
export const HOOK_CONTINUATION_LIMIT = 3;

/** The slice of `Database` read here. */
interface QueryDb {
  query(sql: string): { get(...args: string[]): unknown; all(...args: string[]): unknown[] };
}

/** How far back the chain is looked for: past the ceiling there is nothing to decide. */
const CHAIN_SCAN_ROWS = 50;

/**
 * The `hook-nudge` rows written since the last row the person typed in the
 * session (a `user` row without any machine mark). Machine rows in between
 * (goal nudges, wakes, envelopes) neither count nor reset it.
 */
export function hookChainLength(db: QueryDb, sessionKey: string): number {
  const parse = (raw: unknown): Array<{ kind?: unknown }> | null => {
    try { const v = JSON.parse(decodeCol(raw as never) ?? "null"); return Array.isArray(v) ? v : null; } catch { return null; }
  };
  try {
    const rows = db.query(
      `SELECT id, blocks FROM messages WHERE session_key = ? AND role = 'user' ORDER BY sort_order DESC, rowid DESC LIMIT ${CHAIN_SCAN_ROWS}`,
    ).all(sessionKey) as Array<{ id: string; blocks: unknown }>;
    let n = 0;
    for (const r of rows) {
      const blocks = parse(r.blocks);
      if (blocks?.some((b) => b?.kind === "hook-nudge")) { n++; continue; }
      if (hasMachineMark(blocks)) continue;
      // A resume's row (the tool-budget resume of the goal loop, the boot's
      // resend) carries no mark of its own: its answer carries `ripreso`
      // (`chat-stream-setup.ts`). It is the machine's doing, not the person's.
      if (resumedRow(db, r.id, parse)) continue;
      break; // the person's own words: the chain starts after them
    }
    return n;
  } catch {
    // Unreadable: count as at the ceiling. A brake that fails open is no brake.
    return HOOK_CONTINUATION_LIMIT;
  }
}

function resumedRow(db: QueryDb, userRowId: string, parse: (raw: unknown) => Array<{ kind?: unknown }> | null): boolean {
  const answers = db.query(`SELECT blocks FROM messages WHERE parent_id = ? AND role = 'assistant'`).all(userRowId) as Array<{ blocks: unknown }>;
  return answers.some((a) => parse(a.blocks)?.some((b) => b?.kind === "ripreso") ?? false);
}

/** The goal loop's outcomes (`createGoalContinuation`) that sent the chat a turn of its own. */
export function goalBoughtTurn(outcome: string): boolean {
  return outcome === "continued" || outcome === "tool-budget-resumed";
}

/**
 * The id of the session's newest row that is not a machine notice: a goal
 * loop's stop line written after the turn is not a newer turn.
 */
export function lastRowIdOf(db: QueryDb, sessionKey: string): string | null {
  try {
    const rows = db.query(`SELECT id, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT ${CHAIN_SCAN_ROWS}`).all(sessionKey) as Array<{ id: string; blocks: unknown }>;
    for (const r of rows) {
      let blocks: unknown = null;
      try { blocks = JSON.parse(decodeCol(r.blocks as never) ?? "null"); } catch { blocks = null; }
      if (!hasMachineMark(Array.isArray(blocks) ? blocks : null)) return r.id;
    }
    return null;
  } catch {
    return null;
  }
}

interface HookContinuationInput {
  sessionKey: string;
  /** The chat is a native sub-agent's (`turn.nativeChildChat`, read by the route from `subagents`). */
  subagentChat: boolean;
  /** What the hook printed as `reason`. */
  text: string;
  /** `hookChainLength` when the turn ended (the turn's own row included). */
  chainLength: number;
  /** `lastRowIdOf` when the turn ended: the continuation goes only if it is still the last word. */
  turnLastRowId: string | null;
  /** The model closed the turn by itself (`end_turn`) and nothing was discarded. */
  endedCleanly: boolean;
  /** A question of the chat still waits on its person. */
  pendingAsk: boolean;
  /** The goal loop bought a turn for this same turn end (`goalBoughtTurn`). */
  goalOwnsTurn: boolean;
}

interface HookContinuationDeps {
  db: QueryDb;
  resend: (input: { sessionKey: string; text: string; attempt: number; mark?: ContinuationMark }) => Promise<void>;
  log?: (msg: string) => void;
}

type HookContinuationResult = "sent" | "capped" | "not-clean" | "waiting-human" | "stale" | "subagent" | "goal-owns" | "failed";

/** Send the continuation a `turn-end` hook asked for, under the brakes above. Never throws. */
export async function continueAfterTurnEndHook(
  input: HookContinuationInput,
  deps: HookContinuationDeps,
): Promise<HookContinuationResult> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const tag = `[lifecycle-hooks] ${input.sessionKey}: turn-end hook asked to continue`;
  try {
    if (!input.endedCleanly) { log(`${tag}, but the turn did not end on its own: not sent`); return "not-clean"; }
    if (input.pendingAsk) { log(`${tag}, but a question waits on the person: not sent`); return "waiting-human"; }
    if (input.subagentChat) { log(`${tag}, but this is a sub-agent's chat (its parent drives it): not sent`); return "subagent"; }
    if (input.goalOwnsTurn) { log(`${tag}, but the goal loop already bought a turn for this turn end: not sent`); return "goal-owns"; }
    if (input.chainLength >= HOOK_CONTINUATION_LIMIT) {
      log(`${tag} again after ${input.chainLength} in a row: ceiling of ${HOOK_CONTINUATION_LIMIT} reached, ignored`);
      return "capped";
    }
    // The hook may have taken up to its ceiling: a newer turn means a stale verdict.
    const now = lastRowIdOf(deps.db, input.sessionKey);
    if (!input.turnLastRowId || now !== input.turnLastRowId) {
      log(`${tag}, but the chat moved on since that turn ended: not sent`);
      return "stale";
    }
    await deps.resend({ sessionKey: input.sessionKey, text: input.text, attempt: input.chainLength + 1, mark: "hook-nudge" });
    return "sent";
  } catch (err) {
    // A 409 (another turn took the session) lands here too: not sent, said so.
    log(`${tag}: not sent (${err instanceof Error ? err.message : String(err)})`);
    return "failed";
  }
}
