import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";
import type { AppContext, RouteHandler } from "../types";
import { loadMemoryForTopic } from "./memory";

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
    if (!resolved.startsWith(WORKSPACE_DIR)) return null;
    return resolved;
  }

  /** Recursively scan memory directory tree */
  function scanMemoryTree(dir: string, depth = 0, maxDepth = 3): { path: string; name: string; type: "file" | "dir"; tokens?: number; children?: any[] }[] {
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
      const countTokensRecursive = (items: any[]) => {
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

    // GET /api/context/analyze?topicId=xxx — aggregate all context sources for a topic
    if (method === "GET" && pathname === "/api/context/analyze") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);

      const topicsData = loadTopics();
      const topic = topicsData.topics[topicId];
      if (!topic) return json({ error: "Topic not found" }, 404);

      const sources: {
        id: string;
        label: string;
        category: "openclaw" | "memory" | "prompt" | "template" | "file" | "pinned";
        tokens: number;
        enabled: boolean;
        editable: boolean;
        preview?: string;
        countInBudget: boolean;
      }[] = [];
      const warnings: { type: string; detail: string }[] = [];
      const disabledSources = topic.disabledContextSources || [];

      // 1. OpenClaw workspace files (always-on, read-only)
      for (const name of WORKSPACE_FILES) {
        const filePath = join(WORKSPACE_DIR, name);
        const content = readSafe(filePath);
        if (content) {
          sources.push({
            id: `openclaw:${name}`,
            label: name,
            category: "openclaw",
            tokens: estimateTokens(content),
            enabled: true,
            editable: false,
            preview: content.slice(0, 200),
            countInBudget: true,
          });
        }
      }

      // 2. OpenClaw memory tree (counted as single source)
      const memoryDir = join(WORKSPACE_DIR, "memory");
      if (existsSync(memoryDir)) {
        let memTokens = 0;
        const countDir = (dir: string) => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith(".")) continue;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) { countDir(full); continue; }
              const c = readSafe(full);
              if (c) memTokens += estimateTokens(c);
            }
          } catch {}
        };
        countDir(memoryDir);
        if (memTokens > 0) {
          sources.push({
            id: "openclaw:memory-tree",
            label: "OpenClaw Memory Archive",
            category: "openclaw",
            tokens: memTokens,
            enabled: true,
            editable: false,
            countInBudget: false,
          });
        }
      }

      // 3. Global memory
      const MEMORY_DIR = join(ctx.BASE_DIR, "memory");
      const globalPath = join(MEMORY_DIR, "_global.md");
      const globalContent = readSafe(globalPath) || "";
      if (globalContent) {
        sources.push({
          id: "memory:global",
          label: "Global Memory",
          category: "memory",
          tokens: estimateTokens(globalContent),
          enabled: !disabledSources.includes("memory:global"),
          editable: true,
          preview: globalContent.slice(0, 200),
          countInBudget: true,
        });
      }

      // 4. Topic memory
      const topicMemPath = join(MEMORY_DIR, `${topicId}.md`);
      const topicMemContent = readSafe(topicMemPath) || "";
      if (topicMemContent) {
        sources.push({
          id: "memory:topic",
          label: "Topic Memory",
          category: "memory",
          tokens: estimateTokens(topicMemContent),
          enabled: !disabledSources.includes("memory:topic"),
          editable: true,
          preview: topicMemContent.slice(0, 200),
          countInBudget: true,
        });
      }

      // 5. System prompt
      if (topic.systemPrompt) {
        sources.push({
          id: "prompt:system",
          label: "System Prompt",
          category: "prompt",
          tokens: estimateTokens(topic.systemPrompt),
          enabled: !disabledSources.includes("prompt:system"),
          editable: true,
          preview: topic.systemPrompt.slice(0, 200),
          countInBudget: true,
        });
      }

      // 6. Context templates (project files)
      if (topic.projectPath) {
        const projectDir = ctx.resolveProjectPath(topic.projectPath);
        if (projectDir && existsSync(projectDir)) {
          const TEMPLATE_FILES = ["CLAUDE.md", "README.md", ".cursorrules", "AGENTS.md"];
          for (const name of TEMPLATE_FILES) {
            let filePath = join(projectDir, name);
            let displayName = name;
            if (!existsSync(filePath) && name === "CLAUDE.md") {
              const altPath = join(projectDir, ".claude", "CLAUDE.md");
              if (existsSync(altPath)) { filePath = altPath; displayName = ".claude/CLAUDE.md"; }
            }
            if (existsSync(filePath)) {
              const content = readSafe(filePath);
              if (content) {
                sources.push({
                  id: `template:${name}`,
                  label: displayName,
                  category: "template",
                  tokens: estimateTokens(content),
                  enabled: true,
                  editable: false,
                  preview: content.slice(0, 200),
                  countInBudget: true,
                });
              }
            }
          }
        }
      }

      // 7. Context files (uploads)
      if (topic.contextFiles && topic.contextFiles.length > 0) {
        for (const filePath of topic.contextFiles) {
          if (existsSync(filePath)) {
            const content = readSafe(filePath);
            const fileName = filePath.split("/").pop() || filePath;
            sources.push({
              id: `file:${filePath}`,
              label: fileName,
              category: "file",
              tokens: content ? estimateTokens(content) : 0,
              enabled: !disabledSources.includes(`file:${filePath}`),
              editable: false,
              countInBudget: true,
            });
          }
        }
      }

      // 8. Pinned messages
      if (topic.pinnedMessages && topic.pinnedMessages.length > 0) {
        const localMsgs = ctx.loadLocalMessages(topic.sessionKey);
        const pinned = localMsgs.filter(m => topic.pinnedMessages!.includes(m.id));
        if (pinned.length > 0) {
          const pinnedText = pinned.map(m => m.content).join("\n\n");
          sources.push({
            id: "pinned:messages",
            label: `Pinned Messages (${pinned.length})`,
            category: "pinned",
            tokens: estimateTokens(pinnedText),
            enabled: !disabledSources.includes("pinned:messages"),
            editable: false,
            preview: pinnedText.slice(0, 200),
            countInBudget: true,
          });
        }
      }

      // Calculate totals (only sources that count in budget)
      const totalTokens = sources.filter(s => s.enabled && s.countInBudget).reduce((sum, s) => sum + s.tokens, 0);
      const budgetLimit = 200000; // Typical context budget

      // Generate warnings
      const budgetPercent = Math.round((totalTokens / budgetLimit) * 100);
      if (budgetPercent > 80) {
        warnings.push({
          type: "budget",
          detail: `Context usage is at ${budgetPercent}% of budget (${totalTokens} / ${budgetLimit} tokens)`,
        });
      }

      const largeSources = sources.filter(s => s.enabled && s.tokens > 10000);
      for (const s of largeSources) {
        warnings.push({
          type: "large-source",
          detail: `"${s.label}" is very large (${s.tokens} tokens)`,
        });
      }

      return json({
        sources,
        totalTokens,
        budgetLimit,
        budgetPercent,
        warnings,
      });
    }

    return null;
  };
}
