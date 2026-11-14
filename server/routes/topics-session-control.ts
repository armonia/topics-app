import type { AppContext, RouteHandler } from "../types";
import { getTerminalSessionById } from "./terminal";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { switchTopicCore, createTopicCore } from "../lib/session-control-core";
import type { ProjectBinding } from "./topics-projects";

/** POST /api/sessions/:sessionKey/{switch-topic,new-topic,create-project,open-project}. */
export function createSessionControlRoutes(
  ctx: AppContext,
  deps: {
    projects: ProjectBinding;
  },
): RouteHandler {
  const { projects } = deps;
  const { broadcastToAll, loadTopics, saveSingleTopic, getTopicById, getTopicBySessionKey, readJSON, json, matchRoute, slugify, db } = ctx;

  return async function sessionControlRoutes(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // POST /api/sessions/:sessionKey/{switch-topic,new-topic,create-project,open-project}
    //
    // Tool-shaped successors to the {{TOPIC_SWITCH/TOPIC_NEW/PROJECT_CREATE/
    // PROJECT_OPEN}} markers (the MCP `switch_topic`/`new_topic`/`create_project`/
    // `open_project` tools + the SDK-passthrough dispatcher both hit these).
    // AI-driven: project refs go through projects.resolveProjectRef(trustRawPaths:false),
    // so a model (or prompt injection) can't open a pane rooted at /etc or ~/.ssh.
    //
    // The CALLER is resolved from its sessionKey, which is EITHER a chat topic OR
    // a Claude Code terminal tab:
    //   - open-project / create-project work from BOTH surfaces. A chat topic
    //     binds via projects.bindTopicToProject; a terminal tab (no chat topic) falls back
    //     to projects.moveTerminalPaneToProject — the tab pane is spliced out of the
    //     app-level store and into the project's membership (same as
    //     move-to-project, but resolving the ref by name/slug like the chat
    //     branch, not an absolute path). create-project scaffolds the dir first
    //     (409 on collision) either way, then routes by surface.
    //   - switch-topic / new-topic act on chat topics only (they migrate/split a
    //     conversation; a terminal tab has no conversation to switch). A terminal
    //     session gets a structured 400 naming open_project/move_session_to_project,
    //     not a bare 404 — so the caller knows the RIGHT tool, not just that this
    //     one didn't apply.
    //
    // switch/new reproduce the UI `topic:switch` broadcast but do NOT migrate
    // already-streamed messages (that was marker-only mid-turn surgery, not
    // reproducible by a tool call) — tool-driven switch is UI-only by design.
    {
      const switchM = matchRoute(pathname, "/api/sessions/:sessionKey/switch-topic");
      const newM = matchRoute(pathname, "/api/sessions/:sessionKey/new-topic");
      const createM = matchRoute(pathname, "/api/sessions/:sessionKey/create-project");
      const openM = matchRoute(pathname, "/api/sessions/:sessionKey/open-project");
      const topicControlSession = switchM ?? newM ?? createM ?? openM;

      if (topicControlSession && method === "POST"
        && isGlobalOrchestratorSession(db, decodeURIComponent(topicControlSession.sessionKey))) {
        return json({
          error: "the global coordinator has no project or topic-control authority",
          code: "orchestrator_topic_invariant",
        }, 403);
      }

      if (switchM && method === "POST") {
        const skRaw = decodeURIComponent(switchM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to switch — tell it the right
          // tool instead of a bare 404 (which reads like "session doesn't exist").
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "switch_topic acts on chat topics; this is a terminal Claude tab with no conversation to switch. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "switch_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { topicId?: unknown } | null;
        const targetId = typeof body?.topicId === "string" ? body.topicId : "";
        if (!targetId) return json({ error: "topicId (string) is required" }, 400);
        const r = switchTopicCore(cur, targetId, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        if (!r.ok) {
          // AC-01: archived is a client error distinct from "doesn't exist" — the
          // topic IS there, it's just not switchable (unarchive/open it first).
          if (r.code === "archived") return json({ error: r.message, code: "topic_archived", topicId: targetId }, 400);
          return json({ error: r.message }, 404);
        }
        return json({ ok: true, toTopicId: r.toTopicId });
      }

      if (newM && method === "POST") {
        const skRaw = decodeURIComponent(newM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to fork a new one from.
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "new_topic forks a new chat topic from the current one; this is a terminal Claude tab with no conversation. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "new_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { title?: unknown } | null;
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!title) return json({ error: "title (string) is required" }, 400);
        const { topic: newTopic } = createTopicCore(cur, title, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        return json({ ok: true, topicId: newTopic.id });
      }

      if (createM && method === "POST") {
        const skRaw = decodeURIComponent(createM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can create a project. Resolve
        // the terminal fallback up front so we only scaffold when a caller exists.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { name?: unknown } | null;
        const rawName = typeof body?.name === "string" ? body.name.trim() : "";
        const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required" }, 400);
        // AC-01: create means CREATE — a name collision is a 409, never a silent
        // bind to whatever already lives there (that's open-project/bind-project).
        const { dir: targetDir, exists } = projects.scaffoldProject(safeName);
        if (exists) {
          return json(
            { error: `project "${safeName}" already exists`, code: "project_exists", name: safeName, projectPath: targetDir },
            409,
          );
        }
        if (cur) {
          if (!projects.bindTopicToProject(cur.id, targetDir, { focus: true })) {
            return json({ error: "topic not found for this session", code: "project_created_unbound", projectPath: targetDir }, 404);
          }
        } else if (term) {
          // Terminal tab: move the pane into the freshly-scaffolded project and
          // focus it (same focus semantics as the chat bind, via open-project).
          projects.moveTerminalPaneToProject(term, targetDir);
          broadcastToAll({ type: "open-project", projectPath: targetDir });
        }
        return json({ ok: true, projectPath: targetDir });
      }

      if (openM && method === "POST") {
        const skRaw = decodeURIComponent(openM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can open a project.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { ref?: unknown } | null;
        const ref = typeof body?.ref === "string" ? body.ref : "";
        if (!ref) return json({ error: "ref (string) is required" }, 400);
        // Same resolver as the chat branch (trustRawPaths:false): "apri il
        // progetto yup" resolves by name/slug against known projects, and a model
        // still can't reach /etc or ~/.ssh from a terminal tab either.
        const dir = projects.resolveProjectRef(ref, { trustRawPaths: false });
        if (!dir) return json({ error: "project not found (must be a project Topics already knows)" }, 404);
        if (cur) {
          if (!projects.bindTopicToProject(cur.id, dir, { focus: true })) {
            return json({ error: "topic not found for this session" }, 404);
          }
        } else if (term) {
          // Terminal tab: move the pane into the project and focus it (the
          // open-project broadcast gives the same focus semantics as the bind).
          projects.moveTerminalPaneToProject(term, dir);
          broadcastToAll({ type: "open-project", projectPath: dir });
        }
        return json({ ok: true, projectPath: dir });
      }
    }

    return null;
  };
}
