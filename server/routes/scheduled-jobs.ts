/**
 * `/api/scheduled-jobs`: the door of the scheduled-jobs engine (rule R25).
 *
 *   GET    /api/scheduled-jobs[?projectId=]   the jobs, and whether starts are paused
 *   POST   /api/scheduled-jobs                create (an id and an initial `enabled` may be given)
 *   GET    /api/scheduled-jobs/:id
 *   PATCH  /api/scheduled-jobs/:id            change; never the kind of the job or of its action
 *   DELETE /api/scheduled-jobs/:id            delete; a run in flight is stopped (`cancelled`)
 *   POST   /api/scheduled-jobs/:id/run        run now
 *   POST   /api/scheduled-jobs/:id/postpone   move the next occurrence later, the job stays as it is
 *   GET    /api/scheduled-jobs/:id/runs       the history
 *   POST   /api/scheduled-jobs/starts/pause   no run starts (shutdown, planned restart: R28)
 *   POST   /api/scheduled-jobs/starts/resume
 *
 * Guests never get here: `isGuestAllowedPath` is an allowlist and this path is not in it.
 */
import type { AppContext, RouteHandler } from "../types";
import { JobsError, type createJobsService } from "../schedule/jobs-service";

export interface StartsControl {
  pauseStarts(): void;
  resumeStarts(): void;
  isPaused(): boolean;
  inFlight(): number;
}

export function createScheduledJobsRouter(ctx: AppContext, jobs: ReturnType<typeof createJobsService>, starts: StartsControl): RouteHandler {
  const { json } = ctx;
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const parsed = await req.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const state = () => ({ startsPaused: starts.isPaused(), inFlight: starts.inFlight() });

  return async function scheduledJobsRouter(req, url, pathname, method) {
    if (pathname !== "/api/scheduled-jobs" && !pathname.startsWith("/api/scheduled-jobs/")) return null;
    const parts = pathname.slice("/api/scheduled-jobs".length).split("/").filter(Boolean);
    try {
      if (parts.length === 0) {
        if (method === "GET") return json({ jobs: jobs.list({ projectId: url.searchParams.get("projectId") ?? undefined }), ...state() });
        if (method === "POST") return json(jobs.create(await body(req)), 201);
        return null;
      }
      if (parts[0] === "starts" && parts.length === 2 && method === "POST") {
        if (parts[1] === "pause") starts.pauseStarts();
        else if (parts[1] === "resume") starts.resumeStarts();
        else return null;
        return json(state());
      }
      const id = decodeURIComponent(parts[0]);
      if (parts.length === 1) {
        if (method === "GET") return json(jobs.get(id));
        if (method === "PATCH") return json(jobs.update(id, await body(req)));
        if (method === "DELETE") { jobs.remove(id); return json({ ok: true }); }
        return null;
      }
      if (parts.length === 2 && method === "POST" && parts[1] === "run") return json(jobs.runNow(id), 202);
      if (parts.length === 2 && method === "POST" && parts[1] === "postpone") return json(jobs.postpone(id, await body(req)));
      if (parts.length === 2 && method === "GET" && parts[1] === "runs") {
        const limit = Number(url.searchParams.get("limit"));
        return json({ runs: jobs.runs(id, Number.isFinite(limit) && limit > 0 ? limit : undefined) });
      }
      return null;
    } catch (error) {
      if (error instanceof JobsError) return json({ error: error.message }, error.status);
      throw error;
    }
  };
}
