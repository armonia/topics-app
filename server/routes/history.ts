import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler, StoredMessage } from "../types";
import type { ContentBlock } from "../../shared/types";
import type { AIProvider } from "../providers";
import { getCompactionMarkersBySession } from "../db/compaction-markers";
import { leanMessagesForWire, leanMessagesForHistory } from "../../shared/lean-tool-call";
import { isTurnStillLive, shouldConsultBroker, type BrokerTurnState } from "./historyCleanupPolicy";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { HISTORY_PAGE_MAX_BYTES } from "../../shared/history-paging";
import { CONTEXT_PREFIX, MACHINE_ROW_SQL, promptNumbers } from "../../shared/prompt-number";
import { decodeCol } from "../../shared/message-blob";
import { flushTurnBody } from "../lib/turn-body-flush";
import { withLiveToolTails } from "../lib/stream-catchup-frame";
import { streamOfRow } from "../lib/live-tool-tail";
import { withMediaSizes, type MediaFileRules } from "../lib/media-size";
import { appendChatFind, CHAT_FIND_MAX_HITS, type ChatFindResult } from "../../shared/chat-find";

/**
 * Keep the TAIL of `rows` that fits in `budget` serialized bytes, never fewer
 * than one row, turning each row into its wire form with `toWire` on the way.
 *
 * Walking from the tail and stopping at the first row that breaks the budget
 * is what makes `toWire` pay only for what ships: it hydrates a row's `blocks`
 * (zstd + JSON.parse of every tool output inside) before stripping them, and
 * forty rows hydrated up front to keep eight was 1.74 MB decompressed for a
 * 230 KB page on topic:0299ac2d (2026-09-30). Now the rows before the one that
 * broke the budget are never read. Gate: history-decode-cost.test.ts.
 */
function tailWithinBudget<T, W>(rows: readonly T[], budget: number, toWire: (row: T) => W): W[] {
  const kept: W[] = [];
  let sum = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const wire = toWire(rows[i]!);
    sum += JSON.stringify(wire).length;
    if (sum > budget) {
      if (kept.length === 0) kept.push(wire);
      break;
    }
    kept.push(wire);
  }
  return kept.reverse();
}

export interface HistoryDeps {
  matchHistoryRoute: (pathname: string) => string | null;
  providerForSessionKey: (sessionKey: string) => AIProvider;
}

/**
 * Message-history endpoint (GET|POST /api/history/:sessionKey): returns the
 * stored thread, surgically cleans stale empty partials, overlays live stream
 * content, and falls back to gateway/JSONL migration for sessions with no local
 * messages yet. Split out of the topics.ts god-file. Mostly ctx (the message
 * store, ctx.db, SESSIONS_DIR) + two injected closure helpers (matchHistoryRoute,
 * providerForSessionKey) — instantiated inside createTopicsRouter, not top-level.
 * Behaviour is a verbatim move; only the route dispatch changed.
 */
export function createHistoryRouter(ctx: AppContext, deps: HistoryDeps): RouteHandler {
  const { json, readJSON, loadLocalMessages, hydrateMessageBodies, appendLocalMessage, isStreaming, getStreamContent, SESSIONS_DIR } = ctx;
  const { matchHistoryRoute, providerForSessionKey } = deps;
  // Where the pictures of a message are read from, for their sizes (`lib/media-size.ts`).
  // Absent in a test context built without them: the rows then go out without sizes.
  const mediaRules: MediaFileRules | null = ctx.UPLOADS_DIR && ctx.isPathAllowed
    ? { uploadsDir: ctx.UPLOADS_DIR, isPathAllowed: ctx.isPathAllowed }
    : null;

  /** Il verdetto del broker, o `unknown` se il provider non sa rispondere. Non
   *  lancia mai: una diagnosi che fallisce non deve rompere un caricamento. */
  async function brokerTurnStateFor(sessionKey: string): Promise<BrokerTurnState> {
    try {
      const prov = providerForSessionKey(sessionKey) as unknown as {
        brokerTurnState?: (sk: string) => Promise<BrokerTurnState>;
      };
      return (await prov.brokerTurnState?.(sessionKey)) ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  return async function historyRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    const sessionKey = matchHistoryRoute(pathname);
    if (!sessionKey || (method !== "POST" && method !== "GET")) return null;

    const body = method === "POST" ? await readJSON(req) : {};
    const urlParams = url.searchParams;
    const rawLimit = body?.limit ?? urlParams.get('limit');
    const hasExplicitLimit = rawLimit !== undefined && rawLimit !== null && rawLimit !== '';
    const limitN = Number(rawLimit);
    // "Complete thread" is the default the chat pane needs: an EXPLICIT
    // non-positive limit (the chat sends limit:0) means "no cap, return the
    // whole conversation" — a fixed ceiling silently dropped the head of long
    // topics and the chat rendered "tagliata". A positive limit stays an
    // explicit pagination request (the last `limit` messages), clamped to 500
    // as a safety valve for THOSE callers only. Absent/malformed limit keeps
    // the legacy 50 default (defends the ?limit=abc → slice(-NaN)=slice(0)
    // pitfall) so other callers are unaffected.
    const wantsAll = hasExplicitLimit && Number.isFinite(limitN) && limitN <= 0;
    const limit = wantsAll
      ? Infinity
      : (hasExplicitLimit && Number.isFinite(limitN))
        ? Math.min(Math.max(1, Math.trunc(limitN)), 500)
        : 50;
    const offsetN = Number(body?.offset ?? urlParams.get('offset') ?? '0');
    const offset = Number.isFinite(offsetN) ? Math.max(0, Math.trunc(offsetN)) : 0;
    // `before`: only the messages that PRECEDE this id in the active thread.
    // It is the cursor the chat pane uses for the second half of a tail-first
    // open (`shared/history-paging.ts`): the first request asked for the last
    // N rows, this one asks for everything before the oldest of those. An id
    // beats an offset because the thread can grow between the two requests -
    // a turn landing, an empty partial cleaned up - and "skip the last 40" would
    // then skip a different 40. Absent or unknown: the request behaves exactly
    // as before this parameter existed, and an unknown id yields the WHOLE
    // thread rather than nothing (the client dedups by id; an empty answer
    // would leave the pane believing the head of the chat does not exist).
    const rawBefore = body?.before ?? urlParams.get('before');
    const before = typeof rawBefore === 'string' && rawBefore.length > 0 ? rawBefore : null;

    // A CAPPED request pays for what it returns. The limit used to be applied
    // after hydrating the whole session: `SELECT *` on every row plus a
    // `JSON.parse` of `blocks` and `tool_calls` for each, then `slice(-limit)`.
    // On the heaviest topic of this machine that is 14.2 MB read and parsed to
    // answer 5 KB, with the single event loop of Bun standing still for the
    // duration. Now the thread is walked lean - the two fat columns are not
    // even requested - and `hydrateMessageBodies` fetches them for the rows
    // that actually go out, after the slice.
    //
    // A request for the WHOLE thread (`limit:0` without `before`) keeps the
    // single fat read: it needs every row hydrated anyway, and a second pass by
    // id would only add work. With `before` it does not: the rows from the
    // cursor on - the tail the first page already shipped - are dropped, and a
    // fat read decompressed them for nothing (1.91 MB of 9.10 MB on
    // topic:6b9605e5, 2026-09-30).
    // Gates: tests/integration/history-limit-cost.test.ts,
    // tests/integration/history-decode-cost.test.ts.
    const cappedRead = !wantsAll || before !== null;
    // The row of a turn in flight is WRITTEN before it is read. Its `blocks`,
    // the timeline the bubble draws, go through a throttle that can be 15 s
    // behind the stream, while `content` is overlaid from memory below: a chat
    // opened mid-turn drew a timeline without its last chunks, the live frames
    // appended after it, and the bubble kept a hole for the rest of the turn
    // (card 423e016f). With no turn in flight this does nothing, and a page
    // `before` the tail does not hold the live row.
    if (!before) flushTurnBody(sessionKey);
    // `withToolOutputs: false`: the tool output a closed row keeps in
    // `message_tool_outputs` stays there. The page ships none of it (see
    // `leanMessagesForHistory` below) and the row fetches it on expand from
    // the detail route; reading it here was most of what a page decompressed.
    // Gate: tests/integration/history-tool-output-store.test.ts.
    //
    // A CAPPED page does not even read the text of the rows it will not send.
    // The whole thread is walked as a SKELETON (id, role, partial, context
    // envelope, branch annotations: `loadThreadSkeleton`) and stands in for the
    // lean thread everywhere below that only counts, orders or numbers it. The
    // real rows are read for the PARTIAL ones (the cleanup decides on their
    // text) and, after the slice, for the page itself. On the route bench
    // (3000 messages, `limit=40`) the lean read of the whole thread was 8 of
    // the 11 ms. Gates: tests/integration/history-window-equivalence.test.ts
    // (same answer as the full read), history-limit-cost, history-decode-cost.
    const skeleton = cappedRead ? ctx.loadThreadSkeleton(sessionKey, { forPrompts: true }) : null;
    const partialRows = new Map<string, StoredMessage>();
    if (skeleton) {
      for (const m of ctx.loadThreadRows(skeleton.filter((n) => n.partial))) partialRows.set(m.id, m);
    }
    const localMsgs: StoredMessage[] = skeleton
      ? skeleton.map((n) => partialRows.get(n.id) ?? ({
          id: n.id,
          role: n.role ?? "assistant",
          // Enough for `promptNumbers`: it only asks whether a user row opens with the context envelope.
          content: n.ctxPrefix ? CONTEXT_PREFIX : "",
          timestamp: "",
          siblingCount: n.siblingCount,
          activeBranchIndex: n.activeBranchIndex,
        } satisfies StoredMessage))
      : loadLocalMessages(sessionKey, { withToolOutputs: false });
    // On a lean read the "is this an empty partial?" question cannot be asked
    // of the message: its two columns were left in the table. It is asked of
    // SQLite instead, and only about the partial rows - normally none, at most
    // the turn in flight - so the fat columns are touched for those alone.
    const partialsWithBody: Set<string> = cappedRead
      ? new Set((ctx.db.prepare(
          `SELECT id FROM messages
            WHERE session_key = ? AND partial = 1
              AND ((blocks IS NOT NULL AND length(blocks) > 2)
                OR (tool_calls IS NOT NULL AND length(tool_calls) > 2))`,
        ).all(sessionKey) as Array<{ id: string }>).map((r) => r.id))
      : new Set<string>();
    // The registered coordinator persists its normal Topic history locally but
    // must never fall back into provider/gateway or legacy JSONL history. Use
    // the raw registry role so a malformed/bound/provider-corrupt row remains
    // local-only rather than acquiring an ordinary provider session.
    const rawGlobalOrchestrator = isGlobalOrchestratorSession(ctx.db, sessionKey);
    // «Sta streammando?» non si chiede solo alla memoria di QUESTO processo.
    // `activeStreams` è vuota subito dopo un riavvio del server anche per una
    // sessione il cui figlio è vivo nel broker, fermo su una domanda a schermo
    // — e la pulizia qui sotto azzera `partial`, che è il flag da cui il
    // reattach capisce che c'è un turno da riadottare. Un ⌘R in quella finestra
    // buttava via il turno. Vedi `historyCleanupPolicy.ts` per la regola.
    const streamInMemory = !!isStreaming(sessionKey);
    const brokerState = !rawGlobalOrchestrator && shouldConsultBroker({ streamInMemory, hasPartialRows: localMsgs.some((m) => m.partial) })
      ? await brokerTurnStateFor(sessionKey)
      : null;
    const activeStream = isTurnStillLive({
      streamInMemory,
      hasPartialRows: localMsgs.some((m) => m.partial),
      brokerState,
    });
    if (brokerState === "open") {
      console.log(`[History] ${sessionKey}: turno APERTO secondo il broker — pulizia saltata (figlio vivo, ${localMsgs.filter((m) => m.partial).length} riga/e parziali intatte)`);
    }
    // A message is "real" if it has any of: trimmed text content, recorded tool
    // calls, or a populated chronological blocks timeline. Messages with
    // tools-only-no-text were getting nuked by the cleanup pass below — when a
    // stream crashed mid-flight or produced only tool calls (no prose), the
    // message got DELETE'd on the next /api/history request and the user lost
    // their tools on refresh.
    const isRealMessage = (m: StoredMessage) =>
      (m.content && m.content.trim().length > 0) ||
      (m.toolCalls && m.toolCalls.length > 0) ||
      (m.blocks && m.blocks.length > 0) ||
      partialsWithBody.has(m.id);
    // When streaming, keep ALL messages (including empty partials) — filtering them deletes from disk
    const completeMsgs = activeStream
      ? localMsgs
      : localMsgs.filter(m => !m.partial || isRealMessage(m));

    // Clean up stale messages surgically (avoid saveLocalMessages which destroys branch tree)
    if (!activeStream) {
      // Delete empty partial messages — re-parent children first to avoid FK constraint.
      // Preserve messages with tools/blocks even when text is empty.
      const removedIds = localMsgs.filter(m => m.partial && !isRealMessage(m)).map(m => m.id);
      for (const id of removedIds) {
        const parentRow = ctx.db.prepare(`SELECT parent_id FROM messages WHERE id = ?`).get(id) as any;
        const parentId = parentRow?.parent_id || null;
        ctx.db.prepare(`UPDATE messages SET parent_id = ? WHERE parent_id = ?`).run(parentId, id);
        ctx.db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
      }
      // Clear partial flag on messages with content
      for (const m of completeMsgs) {
        if (m.partial) {
          ctx.db.prepare(`UPDATE messages SET partial = 0, end_reason = 'closed-outside' WHERE id = ?`).run(m.id);
          m.partial = false;
        }
      }
    }

    if (completeMsgs.length > 0) {
      // `total` counts the whole thread even when `before` trims the answer:
      // it is how the client learns whether what it holds is the whole story.
      const total = completeMsgs.length;
      const beforeAt = before ? completeMsgs.findIndex((m) => m.id === before) : -1;
      const pool = beforeAt >= 0 ? completeMsgs.slice(0, beforeAt) : completeMsgs;
      const sliced = offset > 0 ? pool.slice(0, Math.max(0, pool.length - offset)) : pool;
      const cappedStubs = wantsAll ? sliced : sliced.slice(-limit);
      // The page itself: the real lean rows, in the same order. A partial row is
      // already one (and the cleanup above has already touched it in memory).
      const capped = skeleton
        ? (() => {
            const fetched = new Map<string, StoredMessage>();
            for (const m of ctx.loadThreadRows(cappedStubs.filter((m) => !partialRows.has(m.id)))) fetched.set(m.id, m);
            return cappedStubs.flatMap((m) => {
              const real = partialRows.get(m.id) ?? fetched.get(m.id);
              return real ? [real] : [];
            });
          })()
        : cappedStubs;
      // «This is my 50th prompt»: numbered on the WHOLE thread, since the page
      // may be its tail. The lean read left `blocks` in the table, so the rows
      // the machine wrote are asked of SQLite by their marks (a few bytes of
      // plain JSON, below the blob compression threshold). See `prompt-number.ts`.
      const machineIds = new Set((ctx.db.prepare(
        `SELECT id FROM messages WHERE session_key = ? AND role = 'user' AND ${MACHINE_ROW_SQL}`,
      ).all(sessionKey) as Array<{ id: string }>).map((r) => r.id));
      const numbers = promptNumbers(completeMsgs, machineIds);
      const currentStream = isStreaming(sessionKey);
      // In-memory stream content, overlaid onto the last message of the page
      // when that is the assistant row still streaming.
      const streamContent = currentStream ? getStreamContent(sessionKey) : null;
      const pageLast = capped[capped.length - 1];

      // One row, from its lean read to its wire form.
      // - hydrated: `blocks` / `tool_calls` read back for this row only.
      // - Drop the copies the client never reads: `toolCalls` alongside
      //   `blocks`, and `result` inside a toolCall whose `detail` already
      //   carries that same text. On a long working topic (118 messages,
      //   measured 2026-08-14) that is 8.20 MB down to 5.42 MB, and on a PWA
      //   over the LAN the difference is seconds of empty screen. The rule
      //   lives in `shared/lean-tool-call.ts`, together with the reason for
      //   each half and the reason partial messages are left alone, because
      //   `/api/topics/:id/messages` has to apply it too.
      //   Gate: tests/integration/history-payload-weight.test.ts.
      // - A tool call carries only what its CLOSED row draws: the three text
      //   blobs of `detail` (output, content, result) go blank, and every other
      //   string of `detail` or `args` longer than WIRE_STRING_PREVIEW_CHARS
      //   travels as its head. `detailBytes` / `argsBytes` on the call say how
      //   much was cut; the client fetches the whole thing on first expand via
      //   GET /api/messages/:msgId/tool/:toolCallId/detail. plan.text is
      //   intentionally left - it drives the closed-row summary label.
      //   Gates: tests/integration/history-payload-weight.test.ts and
      //   tests/integration/history-args-weight.test.ts.
      // `m` must already carry its bodies; `hydrateMessageBodies` fills them
      // in place, so `m === pageLast` still recognises the page's last row.
      const shapeForWire = (m: StoredMessage) => {
        const n = numbers.get(m.id);
        let out = n ? { ...m, promptNumber: n } : m;
        if (streamContent && m === pageLast && out.role === 'assistant' && out.partial) {
          out.content = streamContent.content;
          if (streamContent.thinking) out.thinking = streamContent.thinking;
        }
        // The running tools' live output, as the catch-up carries it: the row
        // on disk never has it, and a reopening window reads this page AFTER
        // its catch-up, so without it the page wiped the tail the catch-up had
        // just put on screen (CHAT-TOOL-11, measured 04/10: r1..r3 in the
        // sending window, none in a second one, after a reload, a reconnect or
        // a tab switch).
        if (currentStream && m === pageLast && out.role === 'assistant' && out.partial) {
          out = withLiveToolTails(out, streamOfRow(currentStream, m.id)?.liveToolTails);
        }
        const lean = leanMessagesForHistory(leanMessagesForWire([out]))[0]!;
        // The size of each picture the row draws, so the client gives it its
        // box before the bytes arrive (`lib/media-size.ts`).
        return mediaRules ? withMediaSizes(lean, mediaRules) : lean;
      };
      // One read for the whole page, one decode per row the budget reaches.
      const hydrateOne = cappedRead && !wantsAll
        ? ctx.messageBodyHydrator(capped, { withToolOutputs: false })
        : (m: StoredMessage) => m;

      const lastMsg = completeMsgs[completeMsgs.length - 1];
      const hasOrphanedMessage = lastMsg?.role === 'user';
      // BYTE BUDGET of the first page. `limit` bounds the COUNT, and a count is
      // not a size: forty messages of an agentic topic were measured at 0.66 to
      // 1.33 MB of lean rows on 2026-09-07, against the "few tens of KB" the
      // paging assumed. So walk the rows from the tail, sum what each one costs
      // on the wire, and drop the head once the sum passes the budget - keeping
      // at least one message, however fat it is. `total` is untouched, which is
      // exactly how the client learns the page is partial and completes it with
      // `before`. A caller that asked for the whole thread is never capped, and
      // its rows are hydrated in one pass rather than one query each.
      // Gate: tests/integration/history-page-bytes.test.ts.
      const stripped = wantsAll
        ? (cappedRead ? hydrateMessageBodies(capped, { withToolOutputs: false }) : capped).map(shapeForWire)
        : tailWithinBudget(capped, HISTORY_PAGE_MAX_BYTES, (m) => shapeForWire(hydrateOne(m)));
      // Compaction dividers (CHAT-COMPACT-01) — display-only, folded into the
      // timeline client-side by `afterMessageId`. Cheap query; empty for the
      // vast majority of sessions.
      const compactionMarkers = getCompactionMarkersBySession(ctx.db, sessionKey);
      // `turn`: the ledger's word on this session (`lib/turn-ledger.ts`), which the
      // turn queue drains on; `isStreaming` stays the row's own stream.
      const turn = ctx.turnLedger?.stateOf(sessionKey);
      return json({ messages: stripped, total, hasOrphanedMessage, isStreaming: !!currentStream, streamState: currentStream ? { startedAt: currentStream.startedAt, isThinking: currentStream.isThinking } : null, compactionMarkers, ...(turn ? { turn } : {}) });
    }

    // A new coordinator has no local rows yet.  Return that truthful empty
    // conversation rather than attempting provider or JSONL migration, both of
    // which are outside its Codex-only, board-scoped contract.
    if (rawGlobalOrchestrator) return json({ messages: [], total: 0 });

    // Fallback: Provider history
    try {
      const histProvider = providerForSessionKey(sessionKey);
      // `limit` is Infinity when the caller asked for the complete thread; the
      // migration providers need a finite fetch bound, so cap it generously.
      const fallbackFetch = wantsAll ? 1000 : limit + offset;
      let data: any;
      if (histProvider.invokeTool) {
        data = await histProvider.invokeTool("sessions_history", { sessionKey, limit: fallbackFetch, includeTools: false });
      } else if (histProvider.getHistory) {
        data = await histProvider.getHistory(sessionKey, fallbackFetch);
      }
      const gatewayMessages = data?.result?.messages || data?.result?.details?.messages || [];
      if (gatewayMessages.length > 0) {
        for (const msg of gatewayMessages) {
          if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
            const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
            if (content.trim() && !content.startsWith("[Chat messages since your last reply")) appendLocalMessage(sessionKey, msg.role, content);
          }
        }
        const migrated = loadLocalMessages(sessionKey);
        const total = migrated.length;
        const sliced = offset > 0 ? migrated.slice(0, Math.max(0, total - offset)) : migrated;
        return json({ messages: wantsAll ? sliced : sliced.slice(-limit), total });
      }
    } catch (err) { console.warn(`[Messages] Gateway migration failed for ${sessionKey}:`, err); }

    // Last resort: JSONL
    try {
      const sessionsStorePath = join(SESSIONS_DIR, "sessions.json");
      if (existsSync(sessionsStorePath)) {
        const store = JSON.parse(readFileSync(sessionsStorePath, "utf-8"));
        const entry = store[sessionKey];
        if (entry?.sessionId) {
          const jsonlPath = join(SESSIONS_DIR, entry.sessionId + ".jsonl");
          if (existsSync(jsonlPath)) {
            const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
            const messages: any[] = [];
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === "message" && d.message) {
                  const msg = d.message;
                  if (msg.role === "user" || msg.role === "assistant") {
                    let text = "";
                    if (typeof msg.content === "string") text = msg.content;
                    else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
                    if (text.trim() && !text.startsWith("[Chat messages since your last reply")) messages.push({ role: msg.role, content: text, timestamp: d.timestamp });
                  }
                }
              } catch {}
            }
            for (const msg of messages) appendLocalMessage(sessionKey, msg.role, msg.content);
            const total = messages.length;
            const sliced = offset > 0 ? messages.slice(0, Math.max(0, total - offset)) : messages;
            return json({ messages: wantsAll ? sliced : sliced.slice(-limit), total });
          }
        }
      }
    } catch (err) { console.warn(`[Messages] JSONL migration failed for ${sessionKey}:`, err); }

    return json({ messages: [], total: 0 });
  };
}

/**
 * How many messages after the carrier the fallback reads. A coalesced run is
 * one work-only message per action, so this is the longest run whose last row
 * can still find its text. Bounded so a stale or forged id never scans a whole
 * session.
 */
const CARRIER_RUN_SCAN_LIMIT = 500;

type ToolBlock = Extract<ContentBlock, { kind: "tool" }>;

function findToolCall(msg: StoredMessage, toolCallId: string) {
  // The tool call lives in `blocks`; `toolCalls` is the legacy bucket the
  // renderer stopped reading, and the history route drops it whenever blocks
  // are present. Both are searched anyway: a message persisted before blocks
  // existed has the call only in the second one, and a 404 there would read
  // as "the text is gone" when it is merely somewhere else.
  const fromBlocks = (msg.blocks ?? []).find(
    (b): b is ToolBlock => b.kind === "tool" && b.toolCall?.id === toolCallId,
  )?.toolCall;
  return fromBlocks ?? (msg.toolCalls ?? []).find((c) => c.id === toolCallId);
}

/**
 * GET /api/messages/:messageId/tool/:toolCallId/detail — the FULL detail and
 * the FULL args of one tool call, read fresh from the DB.
 *
 * The other half of the trim done by `leanMessagesForHistory` in the history
 * route above. A closed tool row does not read `detail.output` /
 * `detail.content` / `detail.result`, nor anything past the head of a long
 * string in `detail` or `args`, so the history payload ships them blank or
 * cut and the row learns from `toolCall.detailBytes` / `argsBytes` that a
 * body exists. The first time the user actually expands that row, the client
 * comes here and gets the text back. Nothing is lost, it is only paid for
 * when it is looked at.
 *
 * The text is in `blocks` on the stored message, or, for a closed row whose
 * tool output was moved out, in `message_tool_outputs`: `getMessageById` is a
 * full read and puts it back (server/lib/tool-output-store.ts). This route is
 * the one place a history page's tool output is read.
 *
 * It answers with `{ detail, args }` and nothing else. Returning the whole
 * message would put back on the wire precisely what the trim took off, one
 * row at a time.
 *
 * Guests never get here, and that is the existing gate doing its job rather
 * than a check of ours: `server.ts` reads the first segment after
 * `/api/messages/` as a TOPIC id and demands a grant on it (`not_shared`), and
 * a message id is not a topic id. It is the harmless direction to fail in --
 * `/api/history/` is not in `isGuestAllowedPath` either, so a guest never sees
 * a stripped payload to begin with.
 */
export function createToolDetailRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute, getMessageById } = ctx;

  /**
   * The call is not in the message the client named: look in the messages
   * that FOLLOW it in the same session. That is the shape `coalesceToolRuns`
   * produces on the client: consecutive work-only messages become one item
   * carrying the id of the first, and every row inside asks with that id.
   * Only forward, only the same session_key, only CARRIER_RUN_SCAN_LIMIT rows:
   * a run never reaches backwards or into another session.
   */
  function findInFollowingMessages(carrierId: string, toolCallId: string) {
    const at = ctx.db
      .query(`SELECT session_key, sort_order FROM messages WHERE id = ?`)
      .get(carrierId) as { session_key: string; sort_order: number } | null;
    if (!at) return undefined;
    const rows = ctx.db
      .query(
        `SELECT id, blocks, tool_calls FROM messages
          WHERE session_key = ? AND sort_order > ?
          ORDER BY sort_order ASC LIMIT ?`,
      )
      .all(at.session_key, at.sort_order, CARRIER_RUN_SCAN_LIMIT) as Array<{ id: string; blocks: unknown; tool_calls: unknown }>;
    for (const row of rows) {
      // Cheap text probe first: only the row that mentions the id pays for
      // the full parse + sanitize of getMessageById.
      const mentions = (decodeCol(row.blocks) ?? "").includes(toolCallId)
        || (decodeCol(row.tool_calls) ?? "").includes(toolCallId);
      if (!mentions) continue;
      const msg = getMessageById(row.id);
      const tc = msg ? findToolCall(msg, toolCallId) : undefined;
      if (tc) return tc;
    }
    return undefined;
  }

  return async function toolDetailRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method !== "GET") return null;
    const params = matchRoute(pathname, "/api/messages/:messageId/tool/:toolCallId/detail");
    if (!params) return null;

    const msg = getMessageById(params.messageId);
    if (!msg) return json({ error: "message not found" }, 404);

    const tc = findToolCall(msg, params.toolCallId)
      ?? findInFollowingMessages(params.messageId, params.toolCallId);
    if (!tc) return json({ error: "tool call not found" }, 404);

    return json({ detail: tc.detail ?? null, args: tc.args ?? null });
  };
}

/** Messages decoded per slice of `POST /api/history-find`; the event loop is
 *  handed back between two slices. */
const HISTORY_FIND_BATCH = 16;
/** A find query longer than this is not a word somebody is looking for. */
const HISTORY_FIND_MAX_QUERY = 500;

/**
 * POST /api/history-find — `{ sessionKey, query, matchCase }` →
 * `{ total, hits: [{ messageId, part, toolCallId?, offset }], truncated }`.
 * CHAT-FIND-01.
 *
 * Find inside ONE conversation, on the server, because that is where the
 * text is. The history page ships every tool output blank (`withToolOutputs:
 * false`, `leanMessagesForHistory`), so the client could only search the
 * prose and the previews; the outputs of closed rows live in
 * `message_tool_outputs` and come back here through the default full read.
 * The search itself is `shared/chat-find.ts`, the same function the client
 * runs on the message still streaming.
 *
 * BOUNDED, so a big chat does not freeze the server: the thread is listed
 * lean (no fat column read), then decoded and searched HISTORY_FIND_BATCH
 * messages at a time with a yield of the event loop between slices; a client
 * that went away (a newer keystroke aborts the older request) stops the walk
 * at the next slice. At most CHAT_FIND_MAX_HITS positions go back; `total`
 * stays exact.
 *
 * Guests never get here: `/api/history-find` is not in `isGuestAllowedPath`
 * (server/lib/grants.ts), the same closed door as `/api/history/`. A guest's
 * bar searches the client's own text and reasoning instead.
 */
export function createHistoryFindRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, loadLocalMessages, hydrateMessageBodies } = ctx;
  return async function historyFindRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (pathname !== "/api/history-find" || method !== "POST") return null;
    const body = (await readJSON(req)) as { sessionKey?: unknown; query?: unknown; matchCase?: unknown } | null;
    const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey : "";
    const query = typeof body?.query === "string" ? body.query : "";
    const matchCase = body?.matchCase === true;
    if (!sessionKey) return json({ error: "sessionKey required" }, 400);
    if (query.length > HISTORY_FIND_MAX_QUERY) return json({ error: "query too long" }, 400);
    const result: ChatFindResult = { total: 0, hits: [], truncated: false };
    if (!query) return json(result);
    // The live row's timeline is written through a throttle; flush it so the
    // turn in flight is searched as far as it got (same as the history page).
    flushTurnBody(sessionKey);
    const lean = loadLocalMessages(sessionKey, { withBlocks: false, withToolCalls: false });
    for (let i = 0; i < lean.length; i += HISTORY_FIND_BATCH) {
      // Nobody is waiting for this answer any more: stop reading.
      if (req.signal?.aborted) return json({ error: "aborted" }, 499);
      // Default read: tool outputs back in place from `message_tool_outputs`.
      const slice = hydrateMessageBodies(lean.slice(i, i + HISTORY_FIND_BATCH));
      appendChatFind(result, slice, query, { matchCase, maxHits: CHAT_FIND_MAX_HITS });
      if (i + HISTORY_FIND_BATCH < lean.length) await new Promise<void>((r) => setTimeout(r, 0));
    }
    return json(result);
  };
}
