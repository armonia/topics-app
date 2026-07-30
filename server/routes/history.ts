import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler, StoredMessage } from "../types";
import type { AIProvider } from "../providers";
import { getCompactionMarkersBySession } from "../db/compaction-markers";

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
    const activeStream = isStreaming(sessionKey);
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
      // `blocks` e `tool_calls` portano la STESSA cosa, e il client renderizza solo
      // i blocchi: «When present and non-empty, [blocks] takes precedence over the
      // legacy thinking/toolCalls/content bucket rendering» (MessageContent.tsx:967).
      // Spedirli entrambi significa mandare in chiaro un duplicato che verrà
      // scartato: su una topic di lavoro lunga sono 11,86 MB di cui il 55% inutile,
      // più il tempo di `stringify` per produrlo. Su una PWA in LAN sono secondi di
      // schermo vuoto.
      //
      // Solo dai messaggi COMPLETI: il parziale è quello su cui il percorso di
      // streaming continua ad applicare i tool event (useChat.ts:726), e lì
      // `toolCalls` è ancora la lista che cresce. Il fallback per i messaggi
      // legacy senza `blocks` resta intatto.
      const lean = result.map((m) =>
        m.partial || !m.blocks?.length || !m.toolCalls?.length ? m : { ...m, toolCalls: undefined },
      );
      // Compaction dividers (CHAT-COMPACT-01) — display-only, folded into the
      // timeline client-side by `afterMessageId`. Cheap query; empty for the
      // vast majority of sessions.
      const compactionMarkers = getCompactionMarkersBySession(ctx.db, sessionKey);
      return json({ messages: lean, total, hasOrphanedMessage, isStreaming: !!currentStream, streamState: currentStream ? { startedAt: currentStream.startedAt, isThinking: currentStream.isThinking } : null, compactionMarkers });
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
