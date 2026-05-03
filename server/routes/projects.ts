/**
 * Routes — `/api/projects` (Phase A · migration 016)
 *
 * Surface:
 *   GET    /api/projects[?archived=true|false]  → list
 *   GET    /api/projects?path=<abs>             → lookup-or-null (200 with body=null on miss)
 *   GET    /api/projects/:id                    → single
 *   POST   /api/projects                        → create (auto-generates slug from name when omitted)
 *   PATCH  /api/projects/:id                    → update (name, color, icon)
 *   POST   /api/projects/:id/archive            → set archived=1
 *   POST   /api/projects/:id/restore            → set archived=0
 *   DELETE /api/projects/:id                    → row delete (refuses if any worktree exists)
 *
 * Every successful mutation broadcasts a `project:<verb>` envelope via
 * `broadcastToAll`, mirrored by the response. Validation is structural
 * (length caps, control-char strip, regex on slug) and surfaces 400/404/
 * 409 with clear messages.
 */
import type { AppContext, RouteHandler } from "../types";
import { SlugConflictError, ProjectInUseError } from "../services/project-store";
import { existsSync, statSync } from "node:fs";

const NAME_MAX = 200;
const SLUG_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
// Reasonable cap for an emoji or short string; lets multi-codepoint emoji through.
const ICON_MAX = 16;

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

export function createProjectsRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, projectStore, broadcastToAll } = ctx;

  function emit(type: string, project: unknown) {
    broadcastToAll({ type, project, payload_version: 1 });
  }

  return async function projectsRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    // GET /api/projects (list, optional ?archived=, optional ?path= for lookup)
    if (method === "GET" && pathname === "/api/projects") {
      const path = url.searchParams.get("path");
      if (path !== null) {
        const project = projectStore.getByPath(path);
        return json(project); // null on miss is intentional (200 with body=null)
      }
      const archivedParam = url.searchParams.get("archived");
      let opts: { archived?: boolean } = {};
      if (archivedParam === "true") opts.archived = true;
      else if (archivedParam === "false") opts.archived = false;
      const projects = projectStore.list(opts);
      return json({ projects });
    }

    // POST /api/projects
    if (method === "POST" && pathname === "/api/projects") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");

      const name = stripCtrl(body.name);
      if (!name) return errorResponse(400, "name required");
      if (name.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);

      const path = stripCtrl(body.path);
      if (!path) return errorResponse(400, "path required");
      if (!path.startsWith("/")) return errorResponse(400, "path must be absolute");
      if (!existsSync(path)) return errorResponse(400, `path does not exist: ${path}`);
      if (!statSync(path).isDirectory()) return errorResponse(400, `path is not a directory: ${path}`);

      let slug = stripCtrl(body.slug);
      if (!slug) slug = projectStore.slugify(name);
      if (!SLUG_REGEX.test(slug)) {
        return errorResponse(400, `invalid slug (must match ${SLUG_REGEX})`);
      }

      const color = body.color != null ? stripCtrl(body.color) : null;
      if (color !== null && !COLOR_REGEX.test(color)) {
        return errorResponse(400, "color must be #RRGGBB");
      }
      const icon = body.icon != null ? stripCtrl(body.icon) : null;
      if (icon !== null && icon.length > ICON_MAX) {
        return errorResponse(400, `icon too long (max ${ICON_MAX})`);
      }

      try {
        const project = projectStore.create({ name, slug, path, color, icon });
        emit("project:new", project);
        return json(project, 201);
      } catch (err: any) {
        if (err instanceof SlugConflictError) {
          return errorResponse(409, `slug already in use: ${err.slug}`);
        }
        throw err;
      }
    }

    // /api/projects/:id sub-tree
    {
      const idParams = matchRoute(pathname, "/api/projects/:id");
      if (idParams) {
        if (method === "GET") {
          const project = projectStore.get(idParams.id);
          if (!project) return errorResponse(404, "Project not found");
          return json(project);
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");
          const patch: { name?: string; color?: string | null; icon?: string | null } = {};
          if (body.name !== undefined) {
            const v = stripCtrl(body.name);
            if (!v) return errorResponse(400, "name cannot be empty");
            if (v.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);
            patch.name = v;
          }
          if (body.color !== undefined) {
            if (body.color === null) patch.color = null;
            else {
              const v = stripCtrl(body.color);
              if (v === null || !COLOR_REGEX.test(v)) {
                return errorResponse(400, "color must be #RRGGBB or null");
              }
              patch.color = v;
            }
          }
          if (body.icon !== undefined) {
            if (body.icon === null) patch.icon = null;
            else {
              const v = stripCtrl(body.icon);
              if (v === null || v.length === 0) {
                return errorResponse(400, "icon cannot be empty (use null to clear)");
              }
              if (v.length > ICON_MAX) {
                return errorResponse(400, `icon too long (max ${ICON_MAX})`);
              }
              patch.icon = v;
            }
          }
          const project = projectStore.update(idParams.id, patch);
          if (!project) return errorResponse(404, "Project not found");
          emit("project:updated", project);
          return json(project);
        }
        if (method === "DELETE") {
          try {
            const ok = projectStore.delete(idParams.id);
            if (!ok) return errorResponse(404, "Project not found");
            emit("project:deleted", { id: idParams.id });
            return json({ ok: true });
          } catch (err: any) {
            if (err instanceof ProjectInUseError) {
              return errorResponse(
                409,
                `Project has ${err.worktreeCount} worktree(s) — delete them first`,
              );
            }
            throw err;
          }
        }
      }
    }

    // POST /api/projects/:id/archive
    {
      const params = matchRoute(pathname, "/api/projects/:id/archive");
      if (params && method === "POST") {
        const project = projectStore.archive(params.id);
        if (!project) return errorResponse(404, "Project not found");
        emit("project:archived", project);
        return json(project);
      }
    }

    // POST /api/projects/:id/restore
    {
      const params = matchRoute(pathname, "/api/projects/:id/restore");
      if (params && method === "POST") {
        const project = projectStore.restore(params.id);
        if (!project) return errorResponse(404, "Project not found");
        emit("project:updated", project);
        return json(project);
      }
    }

    return null;
  };
}
