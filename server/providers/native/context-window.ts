/**
 * KEEPING A TURN INSIDE THE MODEL'S WINDOW, from the three places it is
 * decided: before sending, after a refusal, after a round that went well.
 *
 * `compaction.ts` knows HOW to make a conversation lighter. This file knows
 * WHEN, and what to tell whoever is watching: it is the policy layer, and it
 * was worth its own file because the three moments only make sense together.
 *
 *  · BEFORE SENDING (`compactIfNeeded`) the threshold is checked, and it is
 *    checked against a MEASURED characters-per-token ratio rather than an
 *    assumed one;
 *  · AFTER A 400 (`recoverFromFullContext`) the exact count the API just
 *    stated is used to correct the estimate, the history is recompacted
 *    against the real ceiling, and the round is redone;
 *  · AFTER A GOOD ROUND (`calibrateFrom`) the prompt the API says it counted
 *    updates the ratio, which is the part that AVOIDS the 400 rather than
 *    repairing it.
 *
 * Card 18bdf214: two topics died of a full context and stayed dead for hours,
 * because the first of those three existed and the other two did not.
 */

import type { AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import {
  needsCompaction, compact, charsPerTokenFrom, promptTooLong,
} from "./compaction";
import { CODING_TOOLS as DEFAULT_TOOLS } from "./tools";

/**
 * How many times a turn may save itself from a "prompt is too long" by
 * compacting again.
 *
 * Two, not one: the first recompaction works on the freshly corrected
 * calibration and usually suffices; the second covers the case where the cut
 * did not reach the target on the first go. Beyond that the weight is not
 * where we are looking for it, and insisting means spinning, one network round
 * at a time.
 */
export const MAX_COMPACT_RECOVERY_ATTEMPTS = 2;

/**
 * HOW MANY CHARACTERS MAKE A TOKEN IN THIS CONVERSATION, measured.
 *
 * Mutable and owned by the SESSION, not by the turn: living inside a turn,
 * every turn would restart from the assumed 4, and the turn that dies of a
 * full context is precisely the FIRST round, the one the assumed 4 had
 * declared harmless.
 */
export interface Calibration { charsPerToken: number }

/** How many recompactions this turn has already spent. */
export interface RecoveryState { attempts: number }

/**
 * The notice for when compacting is not enough any more.
 *
 * Giving up has to be readable too: `API 400: {"type":"error"...}` sends the
 * reader hunting for a network fault that is not there, and does not say the
 * one useful thing: that the conversation has run out of room, and that they
 * can open a new one or pick a model with a wider window.
 */
export function contextFullMessage(measured: { tokens: number; max: number }, attempts: number): string {
  return (
    `Contesto pieno: la conversazione non entra nella finestra del modello ` // allow-italian: user-facing chat text, the UI is in Italian
    + `(${measured.tokens} token contro un tetto di ${measured.max}) nemmeno dopo ` // allow-italian: user-facing chat text, the UI is in Italian
    + `${attempts} compattazione/i. Apri una chat nuova per ripartire leggero, ` // allow-italian: user-facing chat text, the UI is in Italian
    + `oppure scegli un modello con la finestra lunga.` // allow-italian: user-facing chat text, the UI is in Italian
  );
}

/**
 * Lightens the history IN PLACE when it is close to the ceiling.
 *
 * In place because `history` is the session's memory and the caller holds the
 * same array: handing it a new one would leave the compaction inside this
 * turn and let the next one start heavy again.
 */
export function compactIfNeeded(ctx: {
  history: AgentMessage[];
  windowTokens: number;
  overheadChars: number;
  calibration: Calibration;
  handler: Pick<StreamHandler, "onCompaction">;
}): void {
  const { history, windowTokens, overheadChars, calibration } = ctx;
  if (!needsCompaction(history, windowTokens, overheadChars, calibration.charsPerToken)) return;
  const c = compact(history, { windowTokens, overheadChars, charsPerToken: calibration.charsPerToken });
  if (c.after >= c.before) return;
  history.length = 0;
  history.push(...c.messages);
  console.log(`[native] contesto compattato: ~${c.before} → ~${c.after} token stimati`); // allow-italian: server log, not UI
  ctx.handler.onCompaction?.({ trigger: "auto", preTokens: c.before, postTokens: c.after });
}

/**
 * "PROMPT IS TOO LONG" IS NOT A FAILURE: IT IS A MEASUREMENT.
 *
 * It is the only error that carries the EXACT count of a payload we sent
 * ourselves, and it is also the only one that, left alone, kills the chat for
 * good: `classifyFailure` rules 400s as "give-up" (rightly so, resending the
 * same request would earn the same error), the in-memory history stays
 * identical, and EVERY later send repeats that same 400. Measured on two
 * topics (card 18bdf214): dead for hours, with a "provider error" in the chat
 * that says nothing.
 *
 * Returning normally means "recompacted, redo the round". Anything that is not
 * a full context, or a full context we can no longer do anything about, is
 * THROWN: this function never swallows an error it did not resolve.
 */
export function recoverFromFullContext(err: unknown, ctx: {
  history: AgentMessage[];
  windowTokens: number;
  overheadChars: number;
  /** The characters we had sent: half of the ratio the API just completed. */
  sentChars: number;
  calibration: Calibration;
  state: RecoveryState;
  aborted: boolean;
  handler: Pick<StreamHandler, "onCompaction" | "onRetry">;
}): void {
  const detail = err instanceof Error ? err.message : String(err);
  const tooLong = promptTooLong(detail);
  if (!tooLong || ctx.aborted) throw err;
  if (ctx.state.attempts >= MAX_COMPACT_RECOVERY_ATTEMPTS) throw new Error(contextFullMessage(tooLong, ctx.state.attempts));
  ctx.state.attempts++;

  ctx.calibration.charsPerToken = charsPerTokenFrom(ctx.sentChars, tooLong.tokens);
  const c = compact(ctx.history, {
    windowTokens: Math.min(ctx.windowTokens, tooLong.max),
    overheadChars: ctx.overheadChars,
    charsPerToken: ctx.calibration.charsPerToken,
  });
  // Nothing was freed: insisting is spinning, and whoever is reading has a
  // right to know the road has ended and what they can do about it.
  if (c.after >= c.before) throw new Error(contextFullMessage(tooLong, ctx.state.attempts));
  ctx.history.length = 0;
  ctx.history.push(...c.messages);
  console.log(
    `[native] prompt troppo lungo (${tooLong.tokens} > ${tooLong.max}): ` // allow-italian: server log, not UI
    + `ricalibrato a ${ctx.calibration.charsPerToken.toFixed(2)} char/token, ` // allow-italian: server log, not UI
    + `compattato ~${c.before} → ~${c.after}, rifaccio il giro`, // allow-italian: server log, not UI
  );
  // TWO NOTICES, because they are two different things: `onCompaction` leaves
  // the permanent divider in the transcript, `onRetry` is the live line that
  // tells whoever is watching WHY nothing is moving right now. Without the
  // second, a recompaction is a hole of silence mid-turn.
  ctx.handler.onCompaction?.({ trigger: "auto", preTokens: c.before, postTokens: c.after });
  ctx.handler.onRetry?.({
    attempt: ctx.state.attempts,
    maxAttempts: MAX_COMPACT_RECOVERY_ATTEMPTS,
    delayMs: 0,
    reason: "contesto pieno: compatto e riprovo", // allow-italian: user-facing chat text, the UI is in Italian
  });
}

/**
 * THE CALIBRATION IS ALSO TAKEN FROM THE ROUNDS THAT GO WELL, and this is the
 * part that AVOIDS the 400 instead of repairing it.
 *
 * The real prompt is `input + cacheRead + cacheWrite`: the API counts the
 * tokens read from cache and the ones written separately, but they all sit in
 * the same window. Compared with the characters we had sent, it gives how many
 * characters make a token IN THIS conversation, which on agent content (JSON,
 * diffs, source) is ~2 rather than the assumed 4.
 */
export function calibrateFrom(
  calibration: Calibration,
  sentChars: number,
  usage: { input: number; cacheRead: number; cacheWrite: number },
): void {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens > 0) calibration.charsPerToken = charsPerTokenFrom(sentChars, promptTokens);
}

/**
 * The characters of a request that are NOT in the messages: the system prompt
 * and the tool schemas.
 *
 * They travel with EVERY request and count in the same window: with the MCP
 * fleet mounted the schemas alone are tens of thousands of tokens. Left out,
 * the estimate said "you fit" to requests the API refused.
 *
 * The identity line is passed in rather than imported: it belongs to the turn
 * loop, and importing it here would close a cycle between the two files.
 */
export function overheadCharsFor(
  opts: { tools?: () => unknown[]; system?: string },
  identity: string,
): number {
  const tools = opts.tools?.() ?? DEFAULT_TOOLS;
  return identity.length
    + (opts.system?.length ?? 0)
    + (tools.length > 0 ? JSON.stringify(tools).length : 0);
}
