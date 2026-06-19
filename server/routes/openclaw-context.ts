import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, sep } from "path";
import type { AppContext, RouteHandler } from "../types";
import { loadMemoryForTopic } from "./memory";
import { assembleTopicContext, getProviderStrategy } from "../context";
import { getProvider, getDefaultProvider } from "../providers";

// ── Context analysis cache (15s TTL) ─────────────────────────────────────
const CONTEXT_CACHE_TTL = 15000;

/** Legacy `/api/context/analyze` response envelope (see wrapper below). */
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
  // Matches the envelope's diagnostics.warnings shape (the actual data sent);
  // was mis-annotated as string[] — runtime always emitted {type,detail}.
  warnings: { type: string; detail: string }[];
}

/** One node in the recursively-scanned workspace memory tree. */
interface MemoryNode {
  path: string;
  name: string;
  type: "file" | "dir";
  tokens?: number;
  children?: MemoryNode[];
}

const contextAnalysisCache = new Map<string, { data: ContextAnalysisResult; timestamp: number }>();

export function invalidateContextCache(topicId: string) {
  // Cache keys are `${topicId}::${providerName}` since change
  // `topic-context-canonical` (provider strategy can shape the envelope).
  // Clear every entry for this topic regardless of provider.
  for (const key of contextAnalysisCache.keys()) {
    if (key === topicId || key.startsWith(`${topicId}::`)) {
      contextAnalysisCache.delete(key);
    }
  }
}

export function createOpenClawContextRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute, loadTopics, OPENCLAW_DIR } = ctx;
  const WORKSPACE_DIR = join(OPENCLAW_DIR, "workspace");

  // Known OpenClaw workspace files (injected by gateway)
  const WORKSPACE_FILES = ["SOUL.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "IDENTITY.md", "USER.md"];

  function estimateTokens(text: string): number {
    return Math.round(text.length / 4);
  }

  function readSafe(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /** Ensure requested path stays within workspace */
  function resolveWorkspacePath(requestedPath: string): string | null {
    const resolved = resolve(WORKSPACE_DIR, requestedPath);
    // Guard against sibling-dir traversal (e.g. `/ws-evil` shares the `/ws`
    // prefix): require an exact match or a path *inside* the workspace dir.
    if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + sep)) return null;
    return resolved;
  }

  /** Recursively scan memory directory tree */
  function scanMemoryTree(dir: string, depth = 0, maxDepth = 3): MemoryNode[] {
    if (depth > maxDepth || !existsSync(dir)) return [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith("."))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(entry => {
          const fullPath = join(dir, entry.name);
          const relPath = relative(WORKSPACE_DIR, fullPath);
          if (entry.isDirectory()) {
            return {
              path: relPath,
              name: entry.name,
              type: "dir" as const,
              children: scanMemoryTree(fullPath, depth + 1, maxDepth),
            };
          }
          const content = readSafe(fullPath);
          return {
            path: relPath,
            name: entry.name,
            type: "file" as const,
            tokens: content ? estimateTokens(content) : 0,
          };
        });
    } catch {
      return [];
    }
  }

  return async function openclawContextRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/openclaw/context — all OpenClaw workspace context files
    if (method === "GET" && pathname === "/api/openclaw/context") {
      const files: Record<string, { content: string; tokens: number } | null> = {};
      let totalTokens = 0;

      for (const name of WORKSPACE_FILES) {
        const filePath = join(WORKSPACE_DIR, name);
        const content = readSafe(filePath);
        if (content) {
          const tokens = estimateTokens(content);
          files[name.replace(".md", "").toLowerCase()] = { content, tokens };
          totalTokens += tokens;
        } else {
          files[name.replace(".md", "").toLowerCase()] = null;
        }
      }

      // Scan memory tree
      const memoryDir = join(WORKSPACE_DIR, "memory");
      const memoryIndex = scanMemoryTree(memoryDir);
      let memoryTokens = 0;
      const countTokensRecursive = (items: MemoryNode[]) => {
        for (const item of items) {
          if (item.tokens) memoryTokens += item.tokens;
          if (item.children) countTokensRecursive(item.children);
        }
      };
      countTokensRecursive(memoryIndex);
      totalTokens += memoryTokens;

      return json({
        ...files,
        memoryIndex,
        memoryTokens,
        totalTokens,
        workspacePath: WORKSPACE_DIR,
      });
    }

    // GET /api/openclaw/context/file?path=memory/people/cecilia.md
    if (method === "GET" && pathname === "/api/openclaw/context/file") {
      const requestedPath = url.searchParams.get("path");
      if (!requestedPath) return json({ error: "path parameter required" }, 400);

      const resolved = resolveWorkspacePath(requestedPath);
      if (!resolved) return json({ error: "Invalid path" }, 403);

      const content = readSafe(resolved);
      if (content === null) return json({ error: "File not found" }, 404);

      return json({
        content,
        tokens: estimateTokens(content),
        path: requestedPath,
      });
    }

    // GET /api/context/analyze?topicId=xxx — aggregate all context sources for a topic.
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
