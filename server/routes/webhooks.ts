import type { AppContext, RouteHandler } from "../types";

export function createWebhooksRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse } = ctx;

  const stmts = {
    listAll: db.prepare(`SELECT * FROM webhooks ORDER BY created_at DESC`),
    getById: db.prepare(`SELECT * FROM webhooks WHERE id = ?`),
    insert: db.prepare(`
      INSERT INTO webhooks (id, name, url, secret, events, active, retry_count, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE webhooks SET name = ?, url = ?, secret = ?, events = ?, active = ?, retry_count = ?, timeout_ms = ?, updated_at = ?
      WHERE id = ?
    `),
    delete: db.prepare(`DELETE FROM webhooks WHERE id = ?`),
  };

  function rowToWebhook(row: any) {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      events: JSON.parse(row.events || "[]"),
      active: !!row.active,
      retryCount: row.retry_count,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return async function webhooksRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/webhooks - list all
    if (method === "GET" && pathname === "/api/webhooks") {
      const rows = stmts.listAll.all() as any[];
      return json({ webhooks: rows.map(rowToWebhook) });
    }

    // POST /api/webhooks - create
    if (method === "POST" && pathname === "/api/webhooks") {
      const body = await readJSON(req);
      if (!body?.name || !body?.url) return errorResponse(400, "name and url required");

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const events = JSON.stringify(body.events || []);
      const secret = body.secret || crypto.randomUUID();
      const active = body.active !== undefined ? (body.active ? 1 : 0) : 1;
      const retryCount = body.retryCount ?? 5;
      const timeoutMs = body.timeoutMs ?? 5000;

      stmts.insert.run(id, body.name, body.url, secret, events, active, retryCount, timeoutMs, now, now);

      const row = stmts.getById.get(id) as any;
      return json(rowToWebhook(row), 201);
    }

    // POST /api/webhooks/:id/test - test delivery
    {
      const testParams = matchRoute(pathname, "/api/webhooks/:id/test");
      if (testParams && method === "POST") {
        const row = stmts.getById.get(testParams.id) as any;
        if (!row) return errorResponse(404, "Webhook not found");

        const webhook = rowToWebhook(row);
        const deliveryId = crypto.randomUUID();
        const testPayload = {
          event: "webhook.test",
          payload: { message: "Test delivery", webhookId: webhook.id, webhookName: webhook.name },
          timestamp: new Date().toISOString(),
          deliveryId,
        };

        const bodyStr = JSON.stringify(testPayload);

        // Compute HMAC-SHA256 signature
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw", encoder.encode(webhook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(bodyStr));
        const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

        try {
          const resp = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Webhook-Event": "webhook.test",
              "X-Webhook-Delivery": deliveryId,
              "X-Webhook-Signature": signature,
            },
            body: bodyStr,
            signal: AbortSignal.timeout(webhook.timeoutMs),
          });

          return json({
            deliveryId,
            status: resp.ok ? "success" : "failed",
            httpStatus: resp.status,
          });
        } catch (err: any) {
          return json({
            deliveryId,
            status: "failed",
            httpStatus: null,
            error: err.message || "Request failed",
          });
        }
      }
    }

    // PATCH /api/webhooks/:id - update
    {
      const params = matchRoute(pathname, "/api/webhooks/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");

        const row = stmts.getById.get(params.id) as any;
        if (!row) return errorResponse(404, "Webhook not found");

        const existing = rowToWebhook(row);
        const now = new Date().toISOString();

        stmts.update.run(
          body.name ?? existing.name,
          body.url ?? existing.url,
          body.secret ?? existing.secret,
          body.events ? JSON.stringify(body.events) : row.events,
          body.active !== undefined ? (body.active ? 1 : 0) : row.active,
          body.retryCount ?? existing.retryCount,
          body.timeoutMs ?? existing.timeoutMs,
          now,
          params.id,
        );

        const updated = stmts.getById.get(params.id) as any;
        return json(rowToWebhook(updated));
      }

      // DELETE /api/webhooks/:id - delete
      if (params && method === "DELETE") {
        const row = stmts.getById.get(params.id);
        if (!row) return errorResponse(404, "Webhook not found");
        stmts.delete.run(params.id);
        return json({ ok: true });
      }
    }

    return null;
  };
}
