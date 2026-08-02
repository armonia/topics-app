import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, relative, sep } from "path";
import type { AppContext, RouteHandler } from "../types";

/** One node in the recursively-scanned workspace memory tree. */
interface MemoryNode {
  path: string;
  name: string;
  type: "file" | "dir";
  tokens?: number;
  children?: MemoryNode[];
}

export function createOpenClawContextRouter(ctx: AppContext): RouteHandler {
  const { json, OPENCLAW_DIR } = ctx;
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

    return null;
  };
}
