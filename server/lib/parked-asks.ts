/**
 * WHICH CHATS ARE PARKED ON A QUESTION - read from the rows, not from memory.
 *
 * The quiescence gate needs a fourth source: the sessions whose panel is on
 * screen with nobody having answered it yet. The registry that the bridge keeps
 * (`hasPendingAsk` in `ask-user-bridge.ts`) is the obvious candidate and it is
 * not enough on its own: that map is IN MEMORY and empties on every restart,
 * while the child keeps polling and the question is still very much there. Read
 * only the map, and the deferral works for the first question and for no
 * question that survived an earlier restart - which is the same defect one
 * restart later.
 *
 * An open question is a fact of the ROW: a tool call left in a status that
 * waits for a human. `waiting-ask.ts` already reads exactly that, for the
 * sidebar, and it is reused here rather than written a second time: two
 * readings of "is a question on screen" would drift apart, and the one that
 * drifts is always the one nobody is looking at. A QUESTION OR A PERMISSION
 * prompt count the same, as they do in the sidebar: from outside they are one
 * fact - this chat is waiting for a person - and a restart takes both away.
 *
 * AND IT MUST STOP HOLDING. A deferral without an end is a block with a nicer
 * name: an answered question flips its status (so it stops matching by itself),
 * and a question older than the ask TTL - the same window
 * `ask-user-bridge.ts` gives a question to live - has outlived every human
 * attention it could have had, so it holds nothing either.
 */

import { waitingAskStartedAt } from "./waiting-ask";

/** One stored message, already decoded, with the session it belongs to. */
export interface ParkedAskRow {
  sessionKey: string | null | undefined;
  toolCalls: string | null | undefined;
  blocks: string | null | undefined;
}

/**
 * The session keys sitting on an unanswered question, de-duplicated.
 *
 * `rows` is a window of recent messages, newest first or not - order does not
 * matter, because one open question anywhere in the window parks its session.
 * The caller narrows the window in SQL (cheap) and this decides (precise).
 */
export function sessionsParkedOnQuestion(
  rows: Iterable<ParkedAskRow>,
  opts: { now: number; ttlMs: number },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.sessionKey;
    if (!key || seen.has(key)) continue;
    // No timestamp on the tool call: the question exists all the same, and
    // treating it as just opened is the only reading that does not invent an
    // age. It costs at most one TTL window of patience, once.
    const startedAt = waitingAskStartedAt(row.toolCalls, row.blocks, opts.now);
    if (startedAt === null) continue;
    if (opts.now - startedAt >= opts.ttlMs) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The slice of a database handle this probe needs: one prepared read. */
export interface AskRowReader {
  prepare(sql: string): { iterate(): Iterable<unknown> };
}

/**
 * The chats parked on a QUESTION nobody has answered yet, read from the db.
 *
 * THE PRICE. SQL narrows (a window of recent messages, index on the timestamp)
 * and JS decides, because the two columns are zstd-compressed and no `LIKE`
 * would find anything in them (see `shared/message-blob.ts`). Rows are read one
 * at a time with `iterate()` for the reason spelled out at the boot scan:
 * `.all()` on this table materialises hundreds of megabytes before looking at a
 * single row. The window is two days in SQL and the exact ask TTL in JS: the
 * comparison against SQLite's `date()` is coarse, so it is left coarse, and
 * `sessionsParkedOnQuestion` cuts precisely.
 *
 * `fastPathKeys` is the in-memory registry, for the window between "the panel
 * opened" and "the row is on disk". It adds nothing after a restart, which is
 * the whole reason the rows are read at all.
 */
export function chatsParkedOnQuestion(
  db: AskRowReader,
  decode: (v: unknown) => string | null,
  opts: { now: number; ttlMs: number; fastPathKeys: readonly string[] },
): string[] {
  let parked: string[] = [];
  try {
    const rows = db.prepare(
      `SELECT session_key, tool_calls, blocks FROM messages
       WHERE timestamp >= date('now', '-2 days')
         AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)
       ORDER BY sort_order DESC`,
    ).iterate() as Iterable<{ session_key: string | null; tool_calls: unknown; blocks: unknown }>;
    const decoded = (function* () {
      for (const r of rows) {
        yield { sessionKey: r.session_key, toolCalls: decode(r.tool_calls), blocks: decode(r.blocks) };
      }
    })();
    parked = sessionsParkedOnQuestion(decoded, { now: opts.now, ttlMs: opts.ttlMs });
  } catch { /* an unreadable table holds nothing back: the gate keeps its other sources */ }
  for (const key of opts.fastPathKeys) if (!parked.includes(key)) parked.push(key);
  return parked;
}
