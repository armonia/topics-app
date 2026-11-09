/**
 * REST of the Plan (Project -> Area -> Milestone -> Card -> Sources). Logic is
 * in `services/plan.ts`; this file only routes and maps errors.
 * No route touches the cards: linking or deleting in the Plan never changes the board.
 */
import type { AppContext, RouteHandler } from "../types";
import {
  PlanError, addSource, buildPlan, createArea, createMilestone, deleteArea, deleteMilestone,
  deleteSource, linkTask, unlinkTask, updateArea, updateMilestone,
} from "../services/plan";

export function createPlanRouter(ctx: AppContext, opts?: { listProjectDirs?: () => string[] }): RouteHandler {
  const { db, json, readJSON, matchRoute } = ctx;

  const fail = (e: unknown): Response => {
    if (e instanceof PlanError) {
      return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400);
    }
    throw e;
  };
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const b = await readJSON(req);
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch { return {}; }
  };

  return async function planRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/plan")) return null;
    try {
      if (pathname === "/api/plan" && method === "GET") {
        const p = url.searchParams;
        let knownDirs: string[] = [];
        try { knownDirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort: names fall back to the registered ones */ }
        return json(buildPlan(db, { projectId: p.get("projectId") ?? undefined, includeDone: p.get("includeDone") === "1", knownDirs }));
      }
      if (pathname === "/api/plan/areas" && method === "POST") return json(createArea(db, await body(req)), 201);
      const area = matchRoute(pathname, "/api/plan/areas/:id");
      if (area && method === "PATCH") return json(updateArea(db, area.id, await body(req)));
      if (area && method === "DELETE") { deleteArea(db, area.id); return json({ ok: true }); }

      if (pathname === "/api/plan/milestones" && method === "POST") return json(createMilestone(db, await body(req)), 201);
      const ms = matchRoute(pathname, "/api/plan/milestones/:id");
      if (ms && method === "PATCH") return json(updateMilestone(db, ms.id, await body(req)));
      if (ms && method === "DELETE") { deleteMilestone(db, ms.id); return json({ ok: true }); }

      const link = matchRoute(pathname, "/api/plan/links/:taskId");
      if (link && method === "PUT") { linkTask(db, link.taskId, (await body(req)).milestoneId); return json({ ok: true }); }
      if (link && method === "DELETE") { unlinkTask(db, link.taskId); return json({ ok: true }); }

      if (pathname === "/api/plan/sources" && method === "POST") return json(addSource(db, await body(req)), 201);
      const src = matchRoute(pathname, "/api/plan/sources/:id");
      if (src && method === "DELETE") { deleteSource(db, src.id); return json({ ok: true }); }
      return null;
    } catch (e) { return fail(e); }
  };
}
