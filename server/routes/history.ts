import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler, StoredMessage } from "../types";
import type { ContentBlock } from "../../shared/types";
import type { AIProvider } from "../providers";
import { getCompactionMarkersBySession } from "../db/compaction-markers";
import { leanMessagesForWire, stripToolDetailText } from "../../shared/lean-tool-call";
import { isTurnStillLive, shouldConsultBroker, type BrokerTurnState } from "./historyCleanupPolicy";

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
  const { json, readJSON, loadLocalMessages, appendLocalMessage, isStreaming, getStreamContent, SESSIONS_DIR } = ctx;
  const { matchHistoryRoute, providerForSessionKey } = deps;

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

    const localMsgs = loadLocalMessages(sessionKey);
    // «Sta streammando?» non si chiede solo alla memoria di QUESTO processo.
    // `activeStreams` è vuota subito dopo un riavvio del server anche per una
    // sessione il cui figlio è vivo nel broker, fermo su una domanda a schermo
    // — e la pulizia qui sotto azzera `partial`, che è il flag da cui il
    // reattach capisce che c'è un turno da riadottare. Un ⌘R in quella finestra
    // buttava via il turno. Vedi `historyCleanupPolicy.ts` per la regola.
    const streamInMemory = !!isStreaming(sessionKey);
    const brokerState = shouldConsultBroker({ streamInMemory, hasPartialRows: localMsgs.some((m) => m.partial) })
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
      (m.blocks && m.blocks.length > 0);
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
          ctx.db.prepare(`UPDATE messages SET partial = 0 WHERE id = ?`).run(m.id);
          m.partial = false;
        }
      }
    }

    if (completeMsgs.length > 0) {
      const total = completeMsgs.length;
      const sliced = offset > 0 ? completeMsgs.slice(0, Math.max(0, total - offset)) : completeMsgs;
      const result = wantsAll ? sliced : sliced.slice(-limit);
      const currentStream = isStreaming(sessionKey);

      // Overlay in-memory stream content onto the last assistant message
      if (currentStream) {
        const streamContent = getStreamContent(sessionKey);
        if (streamContent && result.length > 0) {
          const last = result[result.length - 1];
          if (last.role === 'assistant' && last.partial) {
            last.content = streamContent.content;
            if (streamContent.thinking) last.thinking = streamContent.thinking;
          }
        }
      }

      const lastMsg = completeMsgs[completeMsgs.length - 1];
      const hasOrphanedMessage = lastMsg?.role === 'user';
      // Drop the copies the client never reads: `toolCalls` alongside `blocks`,
      // and `result` inside a toolCall whose `detail` already carries that same
      // text. On a long working topic (118 messages, measured 2026-08-14) that
      // is 8.20 MB down to 5.42 MB, and on a PWA over the LAN the difference is
      // seconds of empty screen. The rule lives in `shared/lean-tool-call.ts`,
      // together with the reason for each half and the reason partial messages
      // are left alone, because `/api/topics/:id/messages` has to apply it too.
      // Gate: tests/integration/history-payload-weight.test.ts.
      const lean = leanMessagesForWire(result);
      // Strip large text blobs from CLOSED tool detail: output, content, result.
      // The client fetches the full detail lazily on first expand via
      // GET /api/messages/:msgId/tool/:toolCallId/detail. plan.text is
      // intentionally left — it drives the closed-row summary label.
      // Gate: tests/integration/history-payload-weight.test.ts.
      const stripped = stripToolDetailText(lean);
      // Compaction dividers (CHAT-COMPACT-01) — display-only, folded into the
      // timeline client-side by `afterMessageId`. Cheap query; empty for the
      // vast majority of sessions.
      const compactionMarkers = getCompactionMarkersBySession(ctx.db, sessionKey);
      return json({ messages: stripped, total, hasOrphanedMessage, isStreaming: !!currentStream, streamState: currentStream ? { startedAt: currentStream.startedAt, isThinking: currentStream.isThinking } : null, compactionMarkers });
    }

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
 * GET /api/messages/:messageId/tool/:toolCallId/detail — the FULL detail of one
 * tool call, read fresh from the DB.
 *
 * The other half of the strip done by `stripToolDetailText` in the history
 * route above. A closed tool row does not read `detail.output` /
 * `detail.content` / `detail.result`, so the history payload ships them blank
 * and the row learns from `toolCall.detailBytes` that a body exists. The first
 * time the user actually expands that row, the client comes here and gets the
 * text back. Nothing is lost, it is only paid for when it is looked at.
 *
 * No migration and no new column: the text is already in `blocks` on the stored
 * message, exactly as the provider persisted it. This route only reads it.
 *
 * It answers with `{ detail }` and nothing else. Returning the whole message
 * would put back on the wire precisely what the strip took off, one row at a
 * time.
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

  return async function toolDetailRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method !== "GET") return null;
    const params = matchRoute(pathname, "/api/messages/:messageId/tool/:toolCallId/detail");
    if (!params) return null;

    const msg = getMessageById(params.messageId);
    if (!msg) return json({ error: "message not found" }, 404);

    // The tool call lives in `blocks`; `toolCalls` is the legacy bucket the
    // renderer stopped reading, and the history route drops it whenever blocks
    // are present. Both are searched anyway: a message persisted before blocks
    // existed has the call only in the second one, and a 404 there would read
    // as "the text is gone" when it is merely somewhere else.
    const fromBlocks = (msg.blocks ?? []).find(
      (b): b is Extract<ContentBlock, { kind: "tool" }> => b.kind === "tool" && b.toolCall?.id === params.toolCallId,
    )?.toolCall;
    const tc = fromBlocks ?? (msg.toolCalls ?? []).find((c) => c.id === params.toolCallId);
    if (!tc) return json({ error: "tool call not found" }, 404);

    return json({ detail: tc.detail ?? null });
  };
}
