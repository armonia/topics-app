import type { AppContext, RouteHandler } from "../types";

export function createUiStateRouter(ctx: AppContext): RouteHandler {
  const { db, json, broadcastToAll } = ctx;

  function getAllUiState(): Record<string, any> {
    const rows = db.query("SELECT key, value FROM ui_state").all() as { key: string; value: string }[];
    const result: Record<string, any> = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
  }

  return async function uiStateRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/ui-state — all keys
    if (method === "GET" && pathname === "/api/ui-state") {
      return json(getAllUiState());
    }

    // GET /api/ui-state/:key
    const getMatch = method === "GET" && pathname.match(/^\/api\/ui-state\/([^/]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as { value: string } | null;
      if (!row) return json(null);
      try { return json(JSON.parse(row.value)); } catch { return json(row.value); }
    }

    // PUT /api/ui-state/:key — single key update
    const putMatch = method === "PUT" && pathname.match(/^\/api\/ui-state\/([^/]+)$/);
    if (putMatch) {
      const key = decodeURIComponent(putMatch[1]);
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const value = JSON.stringify(body);
      db.run(
        "INSERT OR REPLACE INTO ui_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        key, value,
      );
      broadcastToAll({ type: "ui-state:updated", key, value: body });
      return json({ ok: true });
    }

    // PUT /api/ui-state — bulk update
    if (method === "PUT" && pathname === "/api/ui-state") {
      let body: Record<string, any>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (typeof body !== "object" || body === null) return json({ error: "Expected object" }, 400);

      const stmt = db.prepare("INSERT OR REPLACE INTO ui_state (key, value, updated_at) VALUES (?, ?, datetime('now'))");
      const run = db.transaction(() => {
        for (const [key, val] of Object.entries(body)) {
          stmt.run(key, JSON.stringify(val));
        }
      });
      run();

      broadcastToAll({ type: "ui-state:init", data: getAllUiState() });
      return json({ ok: true });
    }

    return null;
  };
}

/** Helper to load all ui_state for WS init push */
export function loadAllUiState(db: import("bun:sqlite").Database): Record<string, any> {
  try {
    const rows = db.query("SELECT key, value FROM ui_state").all() as { key: string; value: string }[];
    const result: Record<string, any> = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
  } catch {
    return {};
  }
}
