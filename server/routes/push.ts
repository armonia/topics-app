import type { AppContext, RouteHandler } from "../types";
import { getVapidPublicKey } from "../push-service";

export function createPushRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON } = ctx;

  return async function pushRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/push/vapid-public-key
    if (method === "GET" && pathname === "/api/push/vapid-public-key") {
      return json({ publicKey: getVapidPublicKey() });
    }

    // POST /api/push/subscribe
    if (method === "POST" && pathname === "/api/push/subscribe") {
      const body = await readJSON(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const { endpoint, keys } = body;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return json({ error: "Invalid subscription" }, 400);
      }

      db.run(
        `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, user_agent)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh = ?, keys_auth = ?`,
        endpoint, keys.p256dh, keys.auth, req.headers.get("user-agent") || null,
        keys.p256dh, keys.auth
      );

      return json({ ok: true });
    }

    // POST /api/push/unsubscribe
    if (method === "POST" && pathname === "/api/push/unsubscribe") {
      const body = await readJSON(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const { endpoint } = body;

      if (!endpoint) {
        return json({ error: "endpoint required" }, 400);
      }

      db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
      return json({ ok: true });
    }

    return null;
  };
}
