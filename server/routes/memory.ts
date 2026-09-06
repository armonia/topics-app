import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { AppContext, RouteHandler } from "../types";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";

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
  const { json, readJSON, matchRoute, broadcastToAll, getTopicById } = ctx;
  const MEMORY_DIR = resolve(ctx.STATE_DIR, "memory");
  mkdirSync(MEMORY_DIR, { recursive: true });

  /**
   * Keep every route-owned memory filename beneath the one server-owned root.
   * A caller string concatenated into a path is not a boundary: `..` escapes
   * under `join`, and an absolute component takes over under `resolve`.
   * `relative` also handles sibling prefixes such as `/state/memory-old`,
   * which a simple startsWith check would accept.
   */
  function containedMemoryPath(filename: string): string | null {
    const filepath = resolve(MEMORY_DIR, filename);
    const rel = relative(MEMORY_DIR, filepath);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return filepath;
  }

  // A literal still goes through the same containment guard as caller-derived
  // paths.  This route has no caller Topic/session to inspect, so preserving
  // normal global-memory semantics is intentional.
  const globalMemoryPath = containedMemoryPath("_global.md");
  if (!globalMemoryPath) throw new Error("global memory path escaped its root");

  function getMemoryPath(topicId: string): string | null {
    // Topic ids are UUIDs in normal operation.  Treat a malformed/imported id
    // as invalid rather than allowing it to address a nested file, alias
    // another Topic's file through `..`, or collide with global memory.
    if (
      topicId === "_global"
      || topicId.includes("/")
      || topicId.includes("\\")
    ) return null;
    return containedMemoryPath(`${topicId}.md`);
  }

  function resolveTopicMemoryTarget(topicId: string): { topicId: string; filepath: string } | Response {
    if (!topicId) return json({ error: "topic not found" }, 404);

    // Resolve a real Topic before deriving any filesystem path.  The URL is
    // only an address; it is never an authority to create or target memory.
    const topic = getTopicById(topicId);
    if (!topic || topic.id !== topicId) return json({ error: "topic not found" }, 404);

    // Raw identity is the denial boundary.  A registered coordinator with a
    // corrupt backing Topic must not fall through to ordinary topic memory.
    if (isGlobalOrchestratorTopic(ctx.db, topic.id)) {
      return json({
        error: "the global coordinator cannot use topic memory",
        code: "orchestrator_topic_invariant",
      }, 403);
    }

    const filepath = getMemoryPath(topic.id);
    if (!filepath) return json({ error: "invalid topic id" }, 400);
    return { topicId: topic.id, filepath };
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
      const content = loadMemory(globalMemoryPath);
      return json({ content, type: "global", maxBytes: MAX_GLOBAL_MEMORY_BYTES });
    }

    // PUT /api/memory — update global memory
    if (method === "PUT" && pathname === "/api/memory") {
      const body = await readJSON(req);
      if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
      if (Buffer.byteLength(body.content, "utf-8") > MAX_GLOBAL_MEMORY_BYTES) {
        return json({ error: `Global memory exceeds ${MAX_GLOBAL_MEMORY_BYTES / 1024}KB limit` }, 413);
      }
      const locked = await acquireLock(globalMemoryPath);
      if (!locked) return json({ error: "Memory is locked by another write" }, 409);
      try {
        saveMemory(globalMemoryPath, body.content);
        broadcastToAll({ type: "memory:updated", scope: "global" });
        return json({ ok: true });
      } finally {
        releaseLock(globalMemoryPath);
      }
    }

    // DELETE /api/memory/global — clear global memory
    if (method === "DELETE" && pathname === "/api/memory/global") {
      const locked = await acquireLock(globalMemoryPath);
      if (!locked) return json({ error: "Memory is locked by another write" }, 409);
      try {
        if (existsSync(globalMemoryPath)) unlinkSync(globalMemoryPath);
        broadcastToAll({ type: "memory:updated", scope: "global" });
        return json({ ok: true });
      } finally {
        releaseLock(globalMemoryPath);
      }
    }

    // DELETE /api/memory/topic/:topicId — clear topic memory
    {
      const params = matchRoute(pathname, "/api/memory/topic/:topicId");
      if (params && method === "DELETE") {
        const target = resolveTopicMemoryTarget(params.topicId);
        if (target instanceof Response) return target;
        const locked = await acquireLock(target.filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          if (existsSync(target.filepath)) unlinkSync(target.filepath);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: target.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(target.filepath);
        }
      }
    }

    // GET /api/memory/:topicId — topic memory (includes global)
    {
      const params = matchRoute(pathname, "/api/memory/:topicId");
      if (params && method === "GET") {
        const target = resolveTopicMemoryTarget(params.topicId);
        if (target instanceof Response) return target;
        const topicContent = loadMemory(target.filepath);
        const globalContent = loadMemory(globalMemoryPath);
        return json({
          topicContent,
          globalContent,
          topicId: target.topicId,
          maxTopicBytes: MAX_TOPIC_MEMORY_BYTES,
          maxGlobalBytes: MAX_GLOBAL_MEMORY_BYTES,
        });
      }

      // PUT /api/memory/:topicId — update topic memory
      if (params && method === "PUT") {
        const target = resolveTopicMemoryTarget(params.topicId);
        if (target instanceof Response) return target;
        const body = await readJSON(req);
        if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
        if (Buffer.byteLength(body.content, "utf-8") > MAX_TOPIC_MEMORY_BYTES) {
          return json({ error: `Topic memory exceeds ${MAX_TOPIC_MEMORY_BYTES / 1024}KB limit` }, 413);
        }
        const locked = await acquireLock(target.filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          saveMemory(target.filepath, body.content);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: target.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(target.filepath);
        }
      }
    }

    // POST /api/memory/:topicId/append — append a snippet to topic memory
    {
      const params = matchRoute(pathname, "/api/memory/:topicId/append");
      if (params && method === "POST") {
        const target = resolveTopicMemoryTarget(params.topicId);
        if (target instanceof Response) return target;
        const body = await readJSON(req);
        if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
        const locked = await acquireLock(target.filepath);
        if (!locked) return json({ error: "Memory is locked by another write" }, 409);
        try {
          const existing = loadMemory(target.filepath);
          const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const entry = `\n\n- [${timestamp}] ${body.content}`;
          const newContent = existing + entry;
          if (Buffer.byteLength(newContent, "utf-8") > MAX_TOPIC_MEMORY_BYTES) {
            return json({ error: `Topic memory would exceed ${MAX_TOPIC_MEMORY_BYTES / 1024}KB limit` }, 413);
          }
          saveMemory(target.filepath, newContent);
          broadcastToAll({ type: "memory:updated", scope: "topic", topicId: target.topicId });
          return json({ ok: true });
        } finally {
          releaseLock(target.filepath);
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
