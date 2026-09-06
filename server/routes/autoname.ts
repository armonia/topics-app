import type { AppContext, RouteHandler, Topic } from "../types";
import type { AIProvider } from "../providers";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";

export interface AutoNameDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
  detectProjectPathFromMessages: (messages: { role: string; content: string }[]) => string | null;
}

/**
 * Topic auto-naming (POST /api/topics/:id/auto-name): detect a project path from
 * recent messages, then kick off a background LLM call to suggest a title+icon.
 * Split out of the topics.ts god-file. It needs two of that router's closure
 * helpers (resolveProvider, detectProjectPathFromMessages) injected, so it stays
 * a sub-router instantiated INSIDE createTopicsRouter (not registered top-level) —
 * the helpers close over the chat router's scope and are passed unchanged.
 */
export function createAutoNameRouter(ctx: AppContext, deps: AutoNameDeps): RouteHandler {
  const { json, getTopicById, loadLocalMessages, saveSingleTopic, broadcastToAll, slugify, matchRoute } = ctx;
  const { resolveProvider, detectProjectPathFromMessages } = deps;

  return async function autoNameRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    const params = matchRoute(pathname, "/api/topics/:id/auto-name");
    if (params && method === "POST") {
      const topic = getTopicById(params.id);
      if (!topic) return json({ error: "not found" }, 404);
      // The coordinator has a server-owned durable identity.  Auto-naming
      // would use the generic one-shot provider path, so it must neither infer
      // a project nor resolve a mutable/default provider for this Topic.
      if (isGlobalOrchestratorTopic(ctx.db, topic.id)) {
        return json({ title: topic.name, icon: topic.icon, suggestedProject: null });
      }
      const localMsgs = loadLocalMessages(topic.sessionKey);
      if (localMsgs.length < 2) return json({ error: "Not enough messages yet" }, 400);

      // Detect project path from messages
      let suggestedProject: string | null = null;
      const detectedPath = detectProjectPathFromMessages(localMsgs);
      // Auto-naming is allowed—the Topic is still ordinary—but automatic
      // project inference would turn the registry-backed global session into
      // an ordinary project-scoped task authority. Keep its board role
      // unbound, independent of messages that mention a project path.
      if (detectedPath && !topic.projectPath) suggestedProject = detectedPath;

      if (suggestedProject) {
        // Re-read inside the conditional so two concurrent autoname runs
        // don't both decide they need to write — whichever lands first
        // sets projectPath, the loser sees the field already populated.
        const freshTopic = getTopicById(params.id);
        if (freshTopic && !freshTopic.projectPath && !isGlobalOrchestratorTopic(ctx.db, freshTopic.id)) {
          freshTopic.projectPath = suggestedProject;
          freshTopic.updatedAt = new Date().toISOString();
          saveSingleTopic(freshTopic);
          broadcastToAll({ type: "topic:updated", topic: freshTopic });
        }
      }

      // Background: ask AI for a smart title (single user message to avoid gateway session issues)
      const topicId = params.id;
      const recentMsgs = localMsgs.slice(-4);
      const conversationSummary = recentMsgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 150)}`).join('\n');
      (async () => {
        try {
          const aiTopicEarly = getTopicById(topicId);
          const namingProvider = resolveProvider(aiTopicEarly);
          const result = await namingProvider.complete([
            { role: "user", content: `Suggest a short title (3-5 words) and one emoji icon for this conversation. Reply ONLY with valid JSON, nothing else: {"title": "...", "icon": "..."}\n\nConversation:\n${conversationSummary}` },
          ]);
          const content = result.content || "";
          const jsonMatch = content.match(/\{[^}]+\}/);
          if (!jsonMatch) { console.log("[AutoName] AI did not return JSON:", content.slice(0, 100)); return; }
          const parsed = JSON.parse(jsonMatch[0]);
          if (!parsed.title) return;
          // Re-fetch right before write — between the AI call (~seconds) and
          // here the user may have manually renamed the topic (or the client's
          // instant first-message heuristic may have named it); preserve their
          // explicit edit instead of overwriting with the AI guess. Only write
          // when the name is still a default placeholder — the SAME gate the
          // client trigger uses (ChatPane.tsx isDefaultName) so the two agree.
          const aiTopic = getTopicById(topicId);
          const isStillDefault = !!aiTopic && (aiTopic.name === "New Chat" || aiTopic.name.startsWith("New "));
          if (aiTopic && isStillDefault) {
            aiTopic.name = parsed.title;
            if (parsed.icon) aiTopic.icon = parsed.icon;
            aiTopic.slug = slugify(parsed.title);
            aiTopic.updatedAt = new Date().toISOString();
            saveSingleTopic(aiTopic);
            broadcastToAll({ type: "topic:updated", topic: aiTopic });
            console.log(`[AutoName] AI: "${parsed.title}" ${parsed.icon || ''}`);
          }
        } catch (err) { console.warn("[AutoName] AI call failed:", err); }
      })();

      return json({ title: topic.name, icon: topic.icon, suggestedProject });
    }

    return null;
  };
}
