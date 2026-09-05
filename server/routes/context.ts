import { readFileSync } from "fs";
import type { AppContext, RouteHandler } from "../types";
import { getSessionContext } from "../db/session-context";
import { classifyContext, contextWindowFor, windowForMeasure } from "../usage/context-window";
import { contextUpdateFromUsage } from "../usage/usage-update";
import { probeSessionCost } from "../usage/cost-probe";
import { assembleTopicContext, getProviderStrategy } from "../context";
import { getProvider, getDefaultProvider } from "../providers";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";

// ── Cache dell'analisi del contesto (TTL 15s) ────────────────────────────
const CONTEXT_CACHE_TTL = 15000;

/** Forma storica della risposta di `/api/context/analyze`. */
interface ContextAnalysisResult {
  sources: Array<{
    id: string;
    label: string;
    category: string;
    tokens: number;
    enabled: boolean;
    editable: boolean;
    preview?: string;
    countInBudget: boolean;
  }>;
  totalTokens: number;
  budgetLimit: number;
  budgetPercent: number;
  warnings: { type: string; detail: string }[];
}

const contextAnalysisCache = new Map<string, { data: ContextAnalysisResult; timestamp: number }>();

export function createContextRouter(ctx: AppContext): RouteHandler {
  const { GATEWAY_URL, GATEWAY_TOKEN, json, loadTopics, loadLocalMessages } = ctx;

  return async function contextRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // Il contesto REALE dell'ultima chiamata al modello — la stessa cosa che
    // l'evento WS `stream:context` manda durante lo streaming, qui per chi
    // apre l'app a turno finito. Senza questo il ring resterebbe vuoto fino
    // al messaggio successivo, cioè proprio quando serve saperlo.
    //
    // Da non confondere con `GET /api/context` qui sotto, che stima il
    // PREVENTIVO dell'envelope che iniettiamo noi (memory, prompt, file): due
    // domande diverse, entrambe legittime, mai lo stesso numero.
    if (method === "GET" && pathname === "/api/context/live") {
      const sessionKey = url.searchParams.get("sessionKey");
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);
      const row = getSessionContext(ctx.db, sessionKey);
      if (!row) return json({ context: null });
      // Il DENOMINATORE si ricalcola, il NUMERATORE no.
      //
      // `used` è una misura: l'ultima chiamata è stata grande quanto è stata, e
      // nessun cambio di configurazione la riscrive. La finestra invece è una
      // proprietà del modello, e quella cambia sotto i piedi: l'utente passa da
      // Sonnet a Opus[1m] e il ring resta fermo sul vecchio denominatore fino al
      // turno successivo — cioè il ring "sembra rotto" proprio nel momento in cui
      // gli si sta guardando. Ricalcolarla qui vale anche per le righe scritte
      // quando la tabella delle finestre era sbagliata: si correggono da sole,
      // invece di restare congelate su un 200k che non è mai stato vero.
      const topic = ctx.getTopicBySessionKey?.(sessionKey) ?? null;
      // Il pin del topic, e se non c'è il DEFAULT del provider — che è il
      // modello con cui la chat gira davvero. Trattare il pin vuoto come «non
      // lo so» lasciava il denominatore sul nome nudo degli eventi della CLI
      // (`claude-opus-5`, mai `[1m]`): 200k su una chat da un milione.
      const currentModel = topic?.model
        || (() => {
          try { return (topic ? getProvider(topic.provider ?? undefined) : getDefaultProvider())?.defaultModel?.() ?? null; }
          catch { return null; }
        })();
      const usage = classifyContext(row.usedTokens, windowForMeasure(row, currentModel));
      // Stessa forma dell'evento vivo (`usage_update` ACP, 3.1): chi apre
      // l'app a turno finito legge lo stesso oggetto di chi era collegato.
      const update = contextUpdateFromUsage(usage, row.model);
      return json({ context: { ...update, measuredAt: row.measuredAt } });
    }

    // Il MOLTIPLICATORE: contesto × chiamate.
    //
    // `/api/context/live` risponde «quanto ha in pancia il modello», che è UN
    // fattore. Questo risponde alla domanda che decide la spesa: quanto costa
    // una chiamata in più, quante ne sono già state fatte, e quanto fa il
    // prodotto. I due numeri esistevano da sempre in due posti diversi — la
    // riga di `session_context` e i `tool_calls` sui messaggi — e nessuno li
    // moltiplicava, quindi il costo si scopriva a spesa avvenuta.
    if (method === "GET" && pathname === "/api/context/cost") {
      const sessionKey = url.searchParams.get("sessionKey");
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);
      // `messages` taglia la sessione ai primi N messaggi. Non è un lusso: è il
      // modo in cui una misura presa a mano su una chat che nel frattempo è
      // cresciuta resta confrontabile con quello che dice la sonda.
      const limitParam = Number(url.searchParams.get("messages"));
      const limitMessages = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;
      return json({ cost: probeSessionCost(ctx.db, sessionKey, limitMessages ? { limitMessages } : undefined) });
    }

    if (method === "GET" && pathname === "/api/context") {
      const sessionKey = url.searchParams.get("sessionKey");
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);
      // Il tetto e' la finestra del MODELLO del topic. Cablare 200000 dava un
      // denominatore che su un topic a 1M non e' mai stato vero, e la stessa
      // stima appariva al 90% invece che al 18%. Se il gateway ne dichiara uno
      // suo (`contextLimit`/`maxTokens`) vince quello: e' la sessione che sta
      // servendo lui.
      const modelLimit = contextWindowFor(ctx.getTopicBySessionKey?.(sessionKey)?.model).tokens;

      // The coordinator is Codex-only and has no OpenClaw scope.  Its context
      // estimate is local even if its stored Topic has been manually damaged.
      // Do not read its attached files either: a raw registry role never gets
      // project/file authority through this diagnostic endpoint.
      if (isGlobalOrchestratorSession(ctx.db, sessionKey)) {
        const localMsgs = loadLocalMessages(sessionKey);
        const estimatedTokens = localMsgs.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
        return json({ total: Math.round(estimatedTokens), limit: modelLimit, breakdown: [{ label: "Messages", tokens: Math.round(estimatedTokens), color: "#22c55e" }] });
      }

      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "session_status", args: { sessionKey } }) });

        if (!resp.ok) {
          const localMsgs = loadLocalMessages(sessionKey);
          const estimatedTokens = localMsgs.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
          return json({ total: Math.round(estimatedTokens), limit: modelLimit, breakdown: [{ label: "Messages", tokens: Math.round(estimatedTokens), color: "#22c55e" }] });
        }

        const result = await resp.json() as any;
        const status = result?.result || {};
        const breakdown: any[] = [];

        if (status.systemTokens || status.instructionTokens) breakdown.push({ label: "System/Instructions", tokens: status.systemTokens || status.instructionTokens || 0, color: "#3b82f6", description: "System prompt, SOUL.md, AGENTS.md and workspace files" });
        if (status.contextTokens || status.fileTokens) breakdown.push({ label: "Context files", tokens: status.contextTokens || status.fileTokens || 0, color: "#ef4444", description: "MEMORY.md, injected files and project context" });
        if (status.messageTokens || status.conversationTokens) breakdown.push({ label: "Conversation", tokens: status.messageTokens || status.conversationTokens || 0, color: "#22c55e", description: "User messages and assistant responses" });
        if (status.toolTokens) breakdown.push({ label: "Tool calls", tokens: status.toolTokens || 0, color: "#8b5cf6", description: "Tool calls and results" });

        if (breakdown.length === 0) {
          const localMsgs = loadLocalMessages(sessionKey);
          const topicData = loadTopics();
          const topic = Object.values(topicData.topics).find(t => t.sessionKey === sessionKey);
          const systemPromptTokens = topic?.systemPrompt ? Math.round(topic.systemPrompt.length / 4) : 0;
          let contextFilesTokens = 0;
          const contextFileDetails: string[] = [];
          if (topic?.contextFiles && topic.contextFiles.length > 0) {
            for (const filepath of topic.contextFiles) {
              try { const content = readFileSync(filepath, 'utf-8'); const tokens = Math.round(content.length / 4); contextFilesTokens += tokens; contextFileDetails.push(`${filepath.split('/').pop()}: ~${tokens} tokens`); } catch {}
            }
          }
          const baseSystemTokens = 15000;
          const userTokens = localMsgs.filter(m => m.role === "user").reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
          const assistantTokens = localMsgs.filter(m => m.role === "assistant").reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
          const toolTokens = localMsgs.reduce((sum, m) => sum + ((m.toolCalls?.length || 0) * 500), 0);

          breakdown.push({ label: "Base system", tokens: baseSystemTokens, color: "#3b82f6", description: "SOUL.md, AGENTS.md, TOOLS.md and workspace files" });
          if (systemPromptTokens > 0) breakdown.push({ label: "System prompt", tokens: systemPromptTokens, color: "#06b6d4", description: "Custom topic system prompt" });
          if (contextFilesTokens > 0) breakdown.push({ label: "Context files", tokens: contextFilesTokens, color: "#ef4444", description: contextFileDetails.join(", ") });
          if (userTokens > 0) breakdown.push({ label: "User messages", tokens: Math.round(userTokens), color: "#f59e0b", description: `${localMsgs.filter(m => m.role === "user").length} messages` });
          if (assistantTokens > 0) breakdown.push({ label: "AI responses", tokens: Math.round(assistantTokens), color: "#22c55e", description: `${localMsgs.filter(m => m.role === "assistant").length} responses` });
          if (toolTokens > 0) breakdown.push({ label: "Tool calls", tokens: Math.round(toolTokens), color: "#8b5cf6", description: `${localMsgs.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0)} calls` });
        }

        const total = status.totalTokens || status.inputTokens || breakdown.reduce((s: number, b: any) => s + b.tokens, 0);
        const limit = status.contextLimit || status.maxTokens || modelLimit;
        return json({ total, limit, breakdown });
      } catch (err) {
        console.error("Context API error:", err);
        return json({ total: 0, limit: modelLimit, breakdown: [] });
      }
    }

    // GET /api/context/analyze?topicId=xxx — tutte le fonti di contesto di una topic.
    //
    // Stava in `openclaw-context.ts`, e quel router e' montato SOLO quando il
    // provider di default e' `openclaw` (`server.ts`). Su claude-code — cioe'
    // sempre, di fatto — la route rispondeva 404: il Context Inspector mostrava
    // un errore, `budgetPercent` restava 0 e l'anello della chat cadeva sul suo
    // fallback. L'handler non ha mai avuto nulla di specifico per openclaw:
    // risolve il provider DELLA TOPIC e delega ad `assembleTopicContext`. Il
    // gate era sul router sbagliato.
    //
    // BACK-COMPAT WRAPPER (since change `topic-context-canonical`).
    // Delegates to the canonical `assembleTopicContext()` so the inspector and
    // the chat streaming path can never drift. The legacy response shape is
    // preserved exactly so the existing client (`useContextInspector` ➝
    // `contextAnalysisApi.analyze`) keeps working without modifications.
    //
    // Field mapping envelope.SystemBlock → legacy source:
    //   { id, label, category, tokens, enabled, editable, countInBudget }
    //   `preview` = content.slice(0, 200) (legacy field, optional)
    //
    // The "project:awareness" legacy id is mapped from the canonical
    // "template:project-awareness" id and re-labelled to match the original
    // shape clients render.
    if (method === "GET" && pathname === "/api/context/analyze") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);

      const topicsData = loadTopics();
      const topic = topicsData.topics[topicId];
      if (!topic) return json({ error: "Topic not found" }, 404);

      // Resolve provider strategy so the envelope is shaped accurately even
      // for the inspector preview (matters in case a future composer adds
      // strategy-dependent blocks).
      const providerName = topic.provider ?? null;
      let strategyName = "history-aware" as ReturnType<typeof getProviderStrategy>;
      try {
        const provider = providerName ? getProvider(providerName) : getDefaultProvider();
        strategyName = getProviderStrategy(provider);
      } catch {
        /* provider not registered yet — keep the default */
      }

      const cacheKey = `${topicId}::${providerName ?? "default"}`;
      const cached = contextAnalysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CONTEXT_CACHE_TTL) {
        return json(cached.data);
      }

      // includeLastUserInHistory: true — the inspector wants to display the
      // CURRENT state of the conversation, not "what we'd send next".
      const envelope = assembleTopicContext(ctx, {
        sessionKey: topic.sessionKey,
        providerName: providerName ?? "(default)",
        providerStrategy: strategyName,
        includeLastUserInHistory: true,
      });

      // Project envelope.systemBlocks → legacy `sources[]` shape.
      const sources = envelope.systemBlocks.map((b) => {
        // Re-label the project-awareness block to match the legacy id used by
        // the client ("project:awareness" — note: NOT "template:project-awareness").
        const legacyId = b.id === "template:project-awareness" ? "project:awareness" : b.id;
        return {
          id: legacyId,
          label: b.label,
          category: b.category,
          tokens: b.tokens,
          enabled: b.enabled,
          editable: b.editable,
          preview: b.content ? b.content.slice(0, 200) : undefined,
          countInBudget: b.countInBudget,
        };
      });

      const result = {
        sources,
        totalTokens: envelope.diagnostics.totalTokens,
        budgetLimit: envelope.diagnostics.budgetLimit,
        budgetPercent: envelope.diagnostics.budgetPercent,
        warnings: envelope.diagnostics.warnings,
      };
      contextAnalysisCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return json(result);
    }

    return null;
  };
}
