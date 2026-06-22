import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

const MAX_TOPIC_MEMORY_BYTES = 10 * 1024;  // 10KB per topic
const MAX_GLOBAL_MEMORY_BYTES = 50 * 1024; // 50KB global

// Simple in-process write locking
const activeLocks = new Set<string>();

async function acquireLock(filepath: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (activeLocks.has(filepath)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, 30));
  }
  activeLocks.add(filepath);
  return true;
}

function releaseLock(filepath: string) {
  activeLocks.delete(filepath);
}

export function createMemoryRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, broadcastToAll } = ctx;
  const MEMORY_DIR = join(ctx.STATE_DIR, "memory");
  mkdirSync(MEMORY_DIR, { recursive: true });

  function getMemoryPath(topicId: string): string {
    return join(MEMORY_DIR, `${topicId}.md`);
  }

  function getGlobalMemoryPath(): string {
    return join(MEMORY_DIR, "_global.md");
  }

  function loadMemory(filepath: string): string {
    try {
      return readFileSync(filepath, "utf-8");
    } catch {
      return "";
    }
  }

  function saveMemory(filepath: string, content: string): void {
    writeFileSync(filepath, content, "utf-8");
  }

  return async function memoryRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/memory — global memory
    if (method === "GET" && pathname === "/api/memory") {
      const content = loadMemory(getGlobalMemoryPath());
      return json({ content, type: "global", maxBytes: MAX_GLOBAL_MEMORY_BYTES });
    }

    // PUT /api/memory — update global memory
    if (method === "PUT" && pathname === "/api/memory") {
      const body = await readJSON(req);
      if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
      if (Buffer.byteLength(body.content, "utf-8") > MAX_GLOBAL_MEMORY_BYTES) {
        return json({ error: `Global memory exceeds ${MAX_GLOBAL_MEMORY_BYTES / 1024}KB limit` }, 413);
      }
      const filepath = getGlobalMemoryPath();
      const locked = await acquireLock(filepath);
      if (!locked) return json({ error: "Memory is locked by another write" }, 409);
      try {
        saveMemory(filepath, body.content);
        broadcastToAll({ type: "memory:updated", scope: "global" });
        return json({ ok: true });
      } finally {
        releaseLock(filepath);
      }
    }

    // DELETE /api/memory/global — clear global memory
    if (method === "DELETE" && pathname === "/api/memory/global") {
      const filepath = getGlobalMemoryPath();
      const locked = await acquireLock(filepath);
      if (!locked) return json({ error: "Memory is locked by another write" }, 409);
      try {
        if (existsSync(filepath)) unlinkSync(filepath);
        broadcastToAll({ type: "memory:updated", scope: "global" });
        return json({ ok: true });
      } finally {
        releaseLock(filepath);
      }
    }

    // DELETE /api/memory/topic/:topicId — clear topic memory
    {
      const params = matchRoute(pathname, "/api/memory/topic/:topicId");
      if (params && method === "DELETE") {
        const filepath = getMemoryPath(params.topicId);
        const locked = await acquireLock(filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          if (existsSync(filepath)) unlinkSync(filepath);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: params.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(filepath);
        }
      }
    }

    // GET /api/memory/:topicId — topic memory (includes global)
    {
      const params = matchRoute(pathname, "/api/memory/:topicId");
      if (params && method === "GET") {
        const topicContent = loadMemory(getMemoryPath(params.topicId));
        const globalContent = loadMemory(getGlobalMemoryPath());
        return json({
          topicContent,
          globalContent,
          topicId: params.topicId,
          maxTopicBytes: MAX_TOPIC_MEMORY_BYTES,
          maxGlobalBytes: MAX_GLOBAL_MEMORY_BYTES,
        });
      }

      // PUT /api/memory/:topicId — update topic memory
      if (params && method === "PUT") {
        const body = await readJSON(req);
        if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
        if (Buffer.byteLength(body.content, "utf-8") > MAX_TOPIC_MEMORY_BYTES) {
          return json({ error: `Topic memory exceeds ${MAX_TOPIC_MEMORY_BYTES / 1024}KB limit` }, 413);
        }
        const filepath = getMemoryPath(params.topicId);
        const locked = await acquireLock(filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          saveMemory(filepath, body.content);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: params.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(filepath);
        }
      }
    }

    // POST /api/memory/:topicId/append — append a snippet to topic memory
    {
      const params = matchRoute(pathname, "/api/memory/:topicId/append");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
        const filepath = getMemoryPath(params.topicId);
        const locked = await acquireLock(filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          const existing = loadMemory(filepath);
          const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const entry = `\n\n- [${timestamp}] ${body.content}`;
          const newContent = existing + entry;
          if (Buffer.byteLength(newContent, "utf-8") > MAX_TOPIC_MEMORY_BYTES) {
            return json({ error: `Topic memory would exceed ${MAX_TOPIC_MEMORY_BYTES / 1024}KB limit` }, 413);
          }
          saveMemory(filepath, newContent);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: params.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(filepath);
        }
      }
    }

    return null;
  };
}

/**
 * Load combined memory content for injection into system prompt.
 * Called from topics.ts during chat message sending.
 */
export function loadMemoryForTopic(baseDir: string, topicId: string, options?: { includeGlobal?: boolean; includeTopic?: boolean }): string {
  const includeGlobal = options?.includeGlobal ?? true;
  const includeTopic = options?.includeTopic ?? true;
  const MEMORY_DIR = join(baseDir, "memory");
  const parts: string[] = [];

  // Global memory
  if (includeGlobal) {
    const globalPath = join(MEMORY_DIR, "_global.md");
    if (existsSync(globalPath)) {
      try {
        const content = readFileSync(globalPath, "utf-8").trim();
        if (content) parts.push(`### Global Memory\n${content}`);
      } catch {}
    }
  }

  // Topic-specific memory
  if (includeTopic) {
    const topicPath = join(MEMORY_DIR, `${topicId}.md`);
    if (existsSync(topicPath)) {
      try {
        const content = readFileSync(topicPath, "utf-8").trim();
        if (content) parts.push(`### Topic Memory\n${content}`);
      } catch {}
    }
  }

  if (parts.length === 0) return "";
  return `\n\n## Memory\nThe following memories/notes have been saved for context:\n\n${parts.join("\n\n")}`;
}
