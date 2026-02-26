import type { AppContext, RouteHandler } from "../types";

export function createCronRouter(ctx: AppContext): RouteHandler {
  const { GATEWAY_URL, GATEWAY_TOKEN, readJSON, json, matchRoute } = ctx;

  return async function cronRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/cron/jobs") {
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "cron", args: { action: "list", includeDisabled: true } }) });
        if (!resp.ok) { const errText = await resp.text(); return json({ jobs: [], warning: `Gateway error: ${resp.status} - ${errText}` }); }
        const data = await resp.json() as any;
        const jobs = data.result?.details?.jobs || data.result?.jobs || data.jobs || [];
        return json({ jobs });
      } catch (err: any) { return json({ jobs: [], warning: `Gateway unavailable: ${err.message}` }); }
    }

    const cronJobMatch = matchRoute(pathname, "/api/cron/jobs/:jobId");
    if (cronJobMatch && method === "PATCH") {
      try {
        const body = await readJSON(req);
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "cron", args: { action: "update", jobId: cronJobMatch.jobId, patch: body } }) });
        if (!resp.ok) { const errText = await resp.text(); return json({ error: `Gateway error: ${resp.status} - ${errText}` }, resp.status); }
        return json({ ok: true });
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    const cronRunMatch = matchRoute(pathname, "/api/cron/jobs/:jobId/run");
    if (cronRunMatch && method === "POST") {
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "cron", args: { action: "run", jobId: cronRunMatch.jobId } }) });
        if (!resp.ok) return json({ error: `Gateway error: ${resp.status}` }, resp.status);
        return json({ ok: true });
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    if (cronJobMatch && method === "DELETE") {
      try {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` }, body: JSON.stringify({ tool: "cron", args: { action: "remove", jobId: cronJobMatch.jobId } }) });
        if (!resp.ok) return json({ error: `Gateway error: ${resp.status}` }, resp.status);
        return json({ ok: true });
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    return null;
  };
}
