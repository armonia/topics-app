import { subagentProcesses } from "./subagentProcesses";
import { writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import type { AppContext, RouteHandler, Topic } from "../types";
import { getDefaultProviderName, type AIProvider } from "../providers";
import { declaredProviderName, reasoningElsewhereMessage } from "./commandRouting";
import { refreshAndSay } from "../lib/background-notice";
import { consumeFork } from "../lib/chat-fork-store";
import { topicCommandProcesses } from "./processes";
import { liveWorkOf } from "./live-work";
import { isEligibleGlobalOrchestratorSession, isGlobalOrchestratorSession, isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { clearActionFor } from "./clearPolicy";
import { EFFORT_TIERS } from "../../shared/effort";
import { insertCompactionMarkerIfNew } from "../db/compaction-markers";
import type { CompactNowResult } from "../providers/native/provider";
import { sessionStatus } from "./sessionStatus";
import type { ProjectBinding } from "./topics-projects";

/** POST /api/command, GET /api/processes, POST /api/open-project. */
export function createCommandRoutes(
  ctx: AppContext,
  deps: {
    resolveProvider: (topic?: Topic | null) => AIProvider;
    providerForSessionKey: (sessionKey: string) => AIProvider;
    defaultModelOfDeclaredProvider: (topicProvider: string | null | undefined) => string | null;
    projects: ProjectBinding;
  },
): RouteHandler {
  const { resolveProvider, providerForSessionKey, defaultModelOfDeclaredProvider, projects } = deps;
  const { broadcastToAll, saveSingleTopic, getTopicById, getTopicBySessionKey, loadLocalMessages, saveLocalMessages, readJSON, json, matchRoute, errorResponse, db } = ctx;

  return async function commandRoutes(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Slash commands ---
    if (method === "POST" && pathname === "/api/command") {
      const body = await readJSON(req);
      if (!body?.command || !body?.sessionKey) return json({ error: "command and sessionKey required" }, 400);
      const { command, sessionKey, args } = body;
      const isGlobalCoordinatorCommand = isGlobalOrchestratorSession(db, sessionKey);
      if (isGlobalCoordinatorCommand && !isEligibleGlobalOrchestratorSession(db, sessionKey)) {
        return json({
          error: "the global coordinator topic invariant is violated",
          code: "orchestrator_topic_invariant",
        }, 409);
      }
      try {
        switch (command) {
          case "status": {
            // The report itself lives in `sessionStatus.ts`, where a test can
            // reach it; this branch only gathers what it reads.
            const topic = getTopicBySessionKey(sessionKey);
            const output = sessionStatus({
              sessionKey,
              topic: topic as never,
              // CMD-07: unpinned, name the model the next turn would get.
              modelloDiRipiego: topic?.model ? null : defaultModelOfDeclaredProvider(topic?.provider),
            });
            return json({ ok: true, command: "status", output });
          }
          case "clear": {
            const existingMsgs = loadLocalMessages(sessionKey);
            if (existingMsgs.length > 0) {
              const backupDir = join(ctx.BASE_DIR, "backups");
              try { mkdirSync(backupDir, { recursive: true }); const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); const backupFile = join(backupDir, `${sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.json`); writeFileSync(backupFile, JSON.stringify(existingMsgs, null, 2)); console.log(`[clear] Backed up ${existingMsgs.length} messages to ${backupFile}`); } catch (err) { console.warn("[clear] Backup failed:", err); }
            }
            saveLocalMessages(sessionKey, []);
            // A branch emptied by the person takes nobody's history back: its
            // pending fork is consumed on every runtime (CHAT-FORK-01). Codex
            // needs it most, since `clearActionFor` answers `none` for it.
            consumeFork(db, sessionKey);
            // Svuotare la tabella pulisce solo quello che si VEDE: al provider
            // va detto a parte, o il modello ricorda tutto (vedi clearPolicy.ts
            // — la regola sta lì, pura e testata).
            const clearProvider = providerForSessionKey(sessionKey);
            const clearAction = clearActionFor(clearProvider);
            try {
              if (clearAction.kind === "reset") await clearProvider.resetSession!(sessionKey);
              else if (clearAction.kind === "in-band") await clearProvider.sendToSession!(sessionKey, "/clear");
              else console.warn(`[clear] ${clearProvider.name} non sa dimenticare una sessione: svuotata solo la chat`);
            } catch (err) { console.warn("Failed to clear provider session:", err); }
            broadcastToAll({ type: "clear", sessionKey });
            return json({ ok: true, command: "clear", message: "Conversation cleared" });
          }
          case "model": {
            const modelName = args?.model;
            if (!modelName) return json({ error: "model name required" }, 400);
            // claude-code (and any respawn provider): the model is a spawn-time
            // `--model` flag. Persist it per-topic and drop the idle pooled
            // process so the next turn respawns with it — same path as PATCH
            // /api/topics/:id. (Previously this returned a hard 400.)
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevModel = topic.model ?? null;
            topic.model = String(modelName).trim() || null;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            const pending = (topic.model ?? null) !== prevModel ? refreshAndSay(ctx, () => resolveProvider(topic), topic, { model: true }) : {};
            return json({ ok: true, command: "model", model: topic.model, ...pending, message: `Modello impostato: ${topic.model}. Attivo dal prossimo turno.` });
          }
          case "effort": {
            // Per-topic reasoning-effort tier for claude-code (spawn-time
            // `--effort`).
            const tier = String(args?.level || args?.effort || "").trim().toLowerCase();
            const VALID_EFFORTS = new Set<string>(EFFORT_TIERS);
            if (!tier || !VALID_EFFORTS.has(tier)) {
              return json({ error: "Uso: /effort <low|medium|high|xhigh|max>" }, 400);
            }
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevEffort = topic.effort ?? null;
            topic.effort = tier;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            const pending = (topic.effort ?? null) !== prevEffort ? refreshAndSay(ctx, () => resolveProvider(topic), topic, { effort: true }) : {};
            return json({ ok: true, command: "effort", level: tier, ...pending, message: `Effort impostato: ${tier}. Attivo dal prossimo turno.` });
          }
          case "compact": {
            // `/compact` on an engine that compacts on request but has no
            // command parser: Topics' native engine (CMDUI-06). The CLI does
            // its own on Claude Code; there the message travels as typed and
            // never reaches this branch.
            const engine = providerForSessionKey(sessionKey) as AIProvider & { compactNow?: (key: string) => CompactNowResult };
            if (typeof engine.compactNow !== "function") {
              return json({ error: "this engine does not compact on request", code: "compact_unsupported" }, 400);
            }
            const r = engine.compactNow(sessionKey);
            if (!r.compacted && r.reason === "busy") return json({ error: "a turn is running", code: "turn_in_progress" }, 409);
            if (!r.compacted) return json({ ok: true, command: "compact", compacted: false });
            // The same divider the automatic compaction draws, marked manual.
            const owner = getTopicBySessionKey(sessionKey);
            const stored = insertCompactionMarkerIfNew(db, {
              sessionKey,
              topicId: owner?.id ?? null,
              afterMessageId: loadLocalMessages(sessionKey).at(-1)?.id ?? null,
              marker: { trigger: "manual", preTokens: r.before, postTokens: r.after },
            });
            broadcastToAll({
              type: "stream:compaction",
              sessionKey,
              topicId: owner?.id,
              markerId: stored.id,
              afterMessageId: stored.afterMessageId,
              trigger: stored.trigger,
              ...(stored.preTokens != null ? { preTokens: stored.preTokens } : {}),
              ...(stored.postTokens != null ? { postTokens: stored.postTokens } : {}),
              createdAt: stored.createdAt,
            });
            return json({ ok: true, command: "compact", compacted: true, before: r.before, after: r.after });
          }
          case "reasoning": {
            // No on/off switch on any provider: name the DECLARED provider (CMD-08), not «claude-code» everywhere.
            const declared = declaredProviderName(getTopicBySessionKey(sessionKey)?.provider, getDefaultProviderName());
            return json({ ok: true, command: "reasoning", message: reasoningElsewhereMessage(declared) });
          }
          case "project": {
            const sub = args?.sub || "info"; // create | open | info
            const value = (args?.value || "").trim();
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            if (isGlobalOrchestratorTopic(db, topic.id)) {
              return json({
                error: "the global coordinator has no project-control authority",
                code: "orchestrator_topic_invariant",
              }, 403);
            }

            // THE ANSWER IS DATA, the sentence is the client's. It used to be
            // English with emoji («📍 No project bound to this topic.») in an
            // Italian app; now each outcome carries a `code`, and the composer
            // writes it in the reader's language (`chat.project.*`).
            if (sub === "create") {
              if (!value) return json({ error: "/project create <name> requires a project name", code: "project_name_required" }, 400);
              const safeName = value.replace(/[^a-zA-Z0-9_-]/g, "");
              if (!safeName) return json({ error: "Invalid project name (only letters, digits, _ and - allowed)", code: "project_name_invalid" }, 400);
              let targetDir: string;
              try {
                const r = projects.scaffoldProject(safeName);
                if (r.exists) return json({ error: `Project "${safeName}" already exists at ${r.dir}`, code: "project_exists" }, 409);
                targetDir = r.dir;
              } catch (err: any) {
                return json({ error: `Failed to create project: ${err.message}` }, 500);
              }
              projects.bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "create", code: "project_created", name: safeName, path: targetDir });
            }

            if (sub === "open") {
              if (!value) return json({ error: "/project open <name-or-path> requires a target", code: "project_target_required" }, 400);
              const targetDir = projects.resolveProjectRef(value, { trustRawPaths: true });
              if (!targetDir) {
                return json({ error: `Project not found: ${value}`, code: "project_not_found" }, 404);
              }
              projects.bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "open", code: "project_opened", path: targetDir });
            }

            // info (no args): the current binding and the workspace projects.
            const wsProjects = projects.getWorkspaceProjects();
            return json({ ok: true, command: "project", sub: "info", code: "project_info", path: topic.projectPath ?? null, projects: wsProjects.slice(0, 20), moreProjects: Math.max(0, wsProjects.length - 20) });
          }
          default: return json({ error: `Unknown command: ${command}` }, 400);
        }
      } catch (err: any) { return json({ error: `Command failed: ${err.message}` }, 500); }
    }

    // --- Processes API ---
    if (method === "GET" && pathname === "/api/processes") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);
      if (isGlobalOrchestratorTopic(db, topicId)) {
        return json({
          error: "the global coordinator cannot enumerate generic processes",
          code: "orchestrator_topic_invariant",
        }, 403);
      }
      // The chat's own `run_command` processes first: the ones its line and its
      // server row show (BGVIS-08). Before, only the provider's sub-agents were
      // here, and a chat showing a server answered `[]`.
      const commands = topicCommandProcesses(topicId);
      try {
        const procProvider = resolveProvider(getTopicById(topicId));
        let result: any;
        if (procProvider.listSessions) {
          result = await procProvider.listSessions({ kinds: ["other"], activeMinutes: 30 });
        } else {
          return json(commands);
        }
        const sessions = result?.result?.sessions || [];
        return json([...commands, ...subagentProcesses(sessions)]);
      } catch { return json(commands); }
    }

    {
      // The strip under the chat: what works for it now (chat-live-work).
      const params = matchRoute(pathname, "/api/topics/:topicId/live-work");
      if (params && method === "GET") {
        const topic = getTopicById(params.topicId);
        return topic ? json(liveWorkOf(ctx, topic)) : json({ error: "Topic not found" }, 404);
      }
    }

    {
      const params = matchRoute(pathname, "/api/topics/:topicId/project-id");
      if (params && method === "GET") {
        if (isGlobalOrchestratorTopic(db, params.topicId)) {
          return json({ error: "Topic has no project" }, 400);
        }
        const projectId = projects.getProjectIdForTopic(params.topicId);
        if (!projectId) return json({ error: "Topic has no project" }, 400);
        return json({ projectId });
      }
    }

    // --- Open project (broadcast to UI) ---
    if (method === "POST" && pathname === "/api/open-project") {
      try {
        const body = await req.json();
        const rawPath = body?.path;
        if (!rawPath || typeof rawPath !== "string") {
          return json({ error: "path is required" }, 400);
        }
        const projectPath = resolve(rawPath);
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json({ error: "Directory does not exist" }, 404);
        }
        broadcastToAll({ type: "open-project", projectPath });
        return json({ ok: true, projectPath });
      } catch (e: any) {
        return errorResponse(500, e instanceof Error ? e.message : String(e));
      }
    }

    return null;
  };
}
