/**
 * `GET  /api/memory-stores`                         → { stores, problems } (T6, see `../memory/stores.ts`)
 * `GET  /api/memory-stores/search?q=<word>`         → { results } (SYSTEM-05: one deposit search, no external service)
 * `GET  /api/memory-stores/turn?agent=<id>`          → [{ store, path, content }]: the indexes that agent receives, scope applied
 * `GET  /api/memory-stores/:id/cards/:file`         → { content }
 * `POST /api/memory-stores/:id/cards/:file`         { content } → write with backup
 * `POST /api/memory-stores/:id/cards/:file/archive` → move the card into the store's ARCHIVE.md, with backup
 *
 * `:id` is a store id as `discoverStores` names it (`agent:<id>` or
 * `project:<slug>`), never a filesystem path: every write resolves it back to
 * a known store's own folder first, so the request body is never the
 * authority over which folder gets written to.
 */
import { readFileSync } from "fs";
import { readAgents, registryHome } from "../agents/registry";
import { homedir } from "os";
import type { AppContext, RouteHandler } from "../types";
import {
  archiveCard,
  claudeProjectsHome,
  discoverStores,
  readCard,
  readMemoryStoresConfig,
  searchStores,
  storeProblems,
  storesForTurn,
  writeCard,
  type MemoryStore,
} from "../memory/stores";

export interface MemoryStoresDeps {
  /** The channel engine's home, where `engine.json` (agents + grants) lives. Same resolver as `/api/agent-config`. */
  engineHome: () => string;
  expand: (p: string) => string;
}

export function defaultMemoryStoresDeps(env: Record<string, string | undefined> = process.env): MemoryStoresDeps {
  return { engineHome: () => registryHome(env), expand: (p) => p.replace(/^~(?=\/|$)/, homedir()) };
}

function loadStores(deps: MemoryStoresDeps): MemoryStore[] {
  const home = deps.engineHome();
  const agents = readAgents(home, deps.expand);
  const config = readMemoryStoresConfig(home);
  return discoverStores(agents, { claudeProjectsHome: claudeProjectsHome(), config });
}

export function createMemoryStoresRouter(ctx: Pick<AppContext, "json">, deps: MemoryStoresDeps = defaultMemoryStoresDeps()): RouteHandler {
  return async function memoryStoresRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/memory-stores")) return null;

    if (method === "GET" && pathname === "/api/memory-stores") {
      const stores = loadStores(deps);
      return ctx.json({ stores, problems: stores.flatMap(storeProblems) });
    }

    if (method === "GET" && pathname === "/api/memory-stores/search") {
      const q = url.searchParams.get("q") ?? "";
      return ctx.json({ results: searchStores(loadStores(deps), q) });
    }

    if (method === "GET" && pathname === "/api/memory-stores/turn") {
      const agentId = url.searchParams.get("agent") ?? "";
      if (!agentId) return ctx.json({ error: "agent required" }, 400);
      const blocks: { store: string; path: string; content: string }[] = [];
      for (const store of storesForTurn(agentId, loadStores(deps))) {
        if (!store.index) continue;
        let content = "";
        try {
          content = readFileSync(store.index.path, "utf8");
        } catch {
          continue;
        }
        if (content.trim()) blocks.push({ store: store.id, path: store.index.path, content });
      }
      return ctx.json(blocks);
    }

    const cardMatch = /^\/api\/memory-stores\/([^/]+)\/cards\/([^/]+)(\/archive)?$/.exec(pathname);
    if (!cardMatch) return null;
    const [, storeId, file, archiveSuffix] = cardMatch;
    const store = loadStores(deps).find((s) => s.id === decodeURIComponent(storeId!));
    if (!store) return ctx.json({ error: "unknown store" }, 404);
    const cardFile = decodeURIComponent(file!);

    if (method === "GET" && !archiveSuffix) {
      return ctx.json({ content: readCard(store.path, cardFile) });
    }
    if (method === "POST" && archiveSuffix) {
      try {
        const res = archiveCard(store.path, cardFile);
        return ctx.json({ ok: true, archivePath: res.archivePath, backup: res.backup });
      } catch (err) {
        return ctx.json({ error: (err as Error).message }, 400);
      }
    }
    if (method === "POST" && !archiveSuffix) {
      let body: { content?: unknown };
      try {
        body = await req.json();
      } catch {
        return ctx.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.content !== "string") return ctx.json({ error: "content required" }, 400);
      try {
        const res = writeCard(store.path, cardFile, body.content);
        return ctx.json({ ok: true, backup: res.backup });
      } catch (err) {
        return ctx.json({ error: (err as Error).message }, 400);
      }
    }
    return null;
  };
}
