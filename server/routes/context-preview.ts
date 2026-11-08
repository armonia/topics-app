/**
 * Context Preview & Snapshots router.
 *
 * Surface introduced by change `topic-context-canonical` so the inspector
 * (and future debug tooling) can see EXACTLY what the model receives, and
 * EXACTLY what the model received on each of the last N sends.
 *
 * Routes:
 *   GET    /api/topics/:id/context-preview?provider=<name>
 *          → { envelope: ContextEnvelope, payload: ProviderPayload }
 *          The envelope reflects the topic right now (full conversation,
 *          last user turn included). The payload is what
 *          `provider.sendChat` would receive if the user posted now.
 *
 *   GET    /api/topics/:id/context-snapshots
 *          → { snapshots: ContextEnvelope[] }
 *          Last `RING_SIZE` envelopes pushed by the streaming path,
 *          oldest first. Empty after server restart.
 *
 *   DELETE /api/topics/:id/context-snapshots
 *          → { ok: true, removed: number }
 *          Wipes the per-topic ring (debug aid).
 *
 * The `provider` query parameter on the preview endpoint is optional. When
 * omitted, the topic's currently configured provider is used (or the
 * default provider when the topic has none). When the requested provider
 * cannot be resolved, the route falls back gracefully to the default.
 */

import type { AppContext, RouteHandler } from "../types";
import { adaptEnvelope, assembleTopicContext, clearSnapshots, getProviderStrategy, getSnapshots } from "../context";
import { getDefaultProvider, getProvider } from "../providers";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";

export function createContextPreviewRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute } = ctx;

  return async function contextPreviewRouter(
    _req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    // ── GET /api/topics/:id/context-preview ─────────────────────────────
    {
      const params = matchRoute(pathname, "/api/topics/:id/context-preview");
      if (params && method === "GET") {
        const topic = ctx.getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        if (isGlobalOrchestratorTopic(ctx.db, topic.id)) {
          return json({
            error: "context preview is unavailable for the global coordinator",
            code: "orchestrator_topic_invariant",
          }, 403);
        }

        const requestedProvider = url.searchParams.get("provider")?.trim() || topic.provider || null;
        let providerName = requestedProvider ?? "(default)";
        let providerStrategy: ReturnType<typeof getProviderStrategy> = "history-aware";
        // Best-effort provider resolution. The preview is informational and
        // should never fail just because no provider is registered yet (e.g.
        // unit tests, fresh startup). Fall back to history-aware as the
        // safest default — it matches what claude/openai/codex use, the most
        // common case.
        try {
          const provider = requestedProvider ? getProvider(requestedProvider) : getDefaultProvider();
          providerName = provider.name;
          providerStrategy = getProviderStrategy(provider);
        } catch {
          try {
            const provider = getDefaultProvider();
            providerName = provider.name;
            providerStrategy = getProviderStrategy(provider);
          } catch {
            // No providers registered at all — keep the placeholders.
          }
        }

        // includeLastUserInHistory: true — the inspector wants to see the
        // full state right now. If a fresh user turn were posted, the
        // streaming path uses includeLastUserInHistory: false to keep it
        // separate; the preview can show either, but defaulting to "true"
        // matches the legacy /api/context/analyze behaviour.
        const envelope = assembleTopicContext(ctx, {
          sessionKey: topic.sessionKey,
          providerName,
          providerStrategy,
          includeLastUserInHistory: true,
        });
        const payload = adaptEnvelope(envelope);

        return json({ envelope, payload });
      }
    }

    // ── GET /api/topics/:id/context-snapshots ───────────────────────────
    {
      const params = matchRoute(pathname, "/api/topics/:id/context-snapshots");
      if (params && method === "GET") {
        const topic = ctx.getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        // Snapshots retain the canonical envelope that was sent to the model.
        // A raw registry row must not use this debug surface to recover board
        // context after its backing Topic has become corrupt/ineligible.
        if (isGlobalOrchestratorTopic(ctx.db, topic.id)) {
          return json({
            error: "context snapshots are unavailable for the global coordinator",
            code: "orchestrator_topic_invariant",
          }, 403);
        }
        const snapshots = getSnapshots(params.id);
        return json({ snapshots });
      }
      if (params && method === "DELETE") {
        const topic = ctx.getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        if (isGlobalOrchestratorTopic(ctx.db, topic.id)) {
          return json({
            error: "context snapshots are unavailable for the global coordinator",
            code: "orchestrator_topic_invariant",
          }, 403);
        }
        const removed = clearSnapshots(params.id);
        return json({ ok: true, removed });
      }
    }

    return null;
  };
}
