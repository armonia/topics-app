import type { AppContext, RouteHandler } from "../types";

export function createTagsRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse } = ctx;

  const stmts = {
    listTags: db.prepare(`SELECT * FROM tags ORDER BY name ASC`),
    getTag: db.prepare(`SELECT * FROM tags WHERE id = ?`),
    getTagByName: db.prepare(`SELECT * FROM tags WHERE name = ?`),
    insertTag: db.prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)`),
    updateTag: db.prepare(`UPDATE tags SET name = ?, color = ? WHERE id = ?`),
    deleteTag: db.prepare(`DELETE FROM tags WHERE id = ?`),
  };

  return async function tagsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/tags
    if (method === "GET" && pathname === "/api/tags") {
      const rows = stmts.listTags.all() as any[];
      return json({ tags: rows.map(r => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at })) });
    }

    // POST /api/tags
    if (method === "POST" && pathname === "/api/tags") {
      const body = await readJSON(req);
      if (!body?.name) return errorResponse(400, "name required");

      const existing = stmts.getTagByName.get(body.name);
      if (existing) return errorResponse(409, "Tag already exists");

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      stmts.insertTag.run(id, body.name, body.color || '#6366f1', now);
      return json({ id, name: body.name, color: body.color || '#6366f1', createdAt: now }, 201);
    }

    // PATCH /api/tags/:id
    {
      const params = matchRoute(pathname, "/api/tags/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");
        const row = stmts.getTag.get(params.id) as any;
        if (!row) return errorResponse(404, "Tag not found");
        stmts.updateTag.run(body.name ?? row.name, body.color ?? row.color, params.id);
        return json({ id: params.id, name: body.name ?? row.name, color: body.color ?? row.color, createdAt: row.created_at });
      }

      // DELETE /api/tags/:id
      if (params && method === "DELETE") {
        const row = stmts.getTag.get(params.id);
        if (!row) return errorResponse(404, "Tag not found");
        stmts.deleteTag.run(params.id);
        return json({ ok: true });
      }
    }

    return null;
  };
}
