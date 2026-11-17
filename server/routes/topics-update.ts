import { canonicalProjectPath } from "../lib/canonical-project-path";
import { clientProjectPathRefused, CLIENT_PROJECT_PATH_ERROR } from "../lib/client-project-path";
import type { AppContext, RouteHandler, Topic } from "../types";
import { type AIProvider } from "../providers";
import { owedChangesOf, refreshAndSay } from "../lib/background-notice";
import type { BrowserService } from "../browser-service";
import { isEligibleGlobalOrchestratorSession, isGlobalOrchestratorTopic, presentGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { archiveTopicFully, reopenTopicFully } from "../services/archive-topic";
import { dropTurnCheckpoints } from "../services/turn-checkpoints";
import { recordRetirement } from "../services/retirement";
import { parkTopicSession } from "../lib/session-parking";
import { EFFORT_TIERS } from "../../shared/effort";
import { cancelAsk } from "../lib/ask-user-bridge";
import { isInterfaceRequest } from "../lib/created-by";
import { purgeTopicFromUiState, reopenDepsFor } from "./topics-ui-state";

/** Is this topic the agent of a board task? (`session-environment.ts` asks the same.) */
function isBoardAgentTopic(db: import("bun:sqlite").Database, topicId: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM tasks WHERE assigned_topic_id = ? LIMIT 1").get(topicId);
  } catch {
    // No board on this installation: no topic is a board agent.
    return false;
  }
}

/** PATCH /api/topics/:id and the archive / unarchive gestures that ride on it. */
export function createTopicUpdateRoutes(
  ctx: AppContext,
  deps: {
    resolveProvider: (topic?: Topic | null) => AIProvider;
    broadcastContextForModelChange: (topic: Topic) => void;
    browserService: BrowserService | undefined;
    stopTopicProcesses: ((topicId: string) => void) | undefined;
  },
): RouteHandler {
  const { resolveProvider, broadcastContextForModelChange, browserService, stopTopicProcesses } = deps;
  const { broadcastToAll, loadTopics, saveSingleTopic, getTopicById, loadUnread, readJSON, json, matchRoute, slugify, worktreeStore, db } = ctx;

  return async function topicUpdateRoutes(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // PATCH /api/topics/:id
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        // Loads all topics: the parent/ancestor cycle check below walks
        // `data.topics[ancestorId]` across the tree, so a single indexed read
        // would not suffice here.
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        // The model of a board card's agent is the card's, not something the
        // agent declares about itself: the thread shows it next to the agent's
        // signature. Only the interface may change it (card 964ea861).
        if (body.model !== undefined && !isInterfaceRequest(req) && isBoardAgentTopic(db, topic.id)) {
          return json({
            error: "the model of a board agent's topic is set by its card, not through the API",
            code: "agent_topic_model_locked",
          }, 403);
        }
        const globalOrchestrator = isGlobalOrchestratorTopic(db, topic.id);
        // A raw registry role can survive a manual/provider corruption, but it
        // must never degrade into an ordinary mutable chat. In particular,
        // model/effort/autonomy changes refresh a provider process below. Keep
        // those side effects behind the usable-capability check; the canonical
        // Kanban ensure endpoint is the sole recovery path for the role.
        if (globalOrchestrator && !isEligibleGlobalOrchestratorSession(db, topic.sessionKey)) {
          // Keep the same harmless presentation controls the marked client
          // exposes even while a damaged registry Topic is awaiting canonical
          // recovery.  In particular, Settings intentionally permits mute.
          const benignPresentationKeys = new Set(["name", "color", "icon", "muted"]);
          const attemptedOperationalChange = Object.keys(body).some(
            (key) => !benignPresentationKeys.has(key),
          );
          if (attemptedOperationalChange) {
            return json({
              error: "global coordinator integrity is invalid; reopen it from the Kanban before changing its operational settings",
              code: "orchestrator_topic_invariant",
            }, 409);
          }
        }
        if (globalOrchestrator && (
          body.systemPrompt !== undefined
          || body.projectPath !== undefined
          || body.worktreeId !== undefined
          || body.parentId !== undefined
          // The same door the context-file routes already close. `/api/media`
          // refuses the coordinator generic context storage with a 403, and
          // this PATCH wrote the list straight onto the row a few lines below:
          // one guard was doing the work of two, and the second entrance was
          // open. An attachment is exactly the ordinary-topic capability the
          // coordinator does not get.
          || body.contextFiles !== undefined
          || (body.provider !== undefined && body.provider !== "codex")
          || (Array.isArray(body.disabledContextSources) && body.disabledContextSources.includes("prompt:system"))
        )) {
          return json({
            error: "the global coordinator keeps a server-owned enabled prompt, takes no attached context files, stays Codex-only, and must remain an unbound top-level Topic",
            code: "orchestrator_topic_invariant",
          }, 403);
        }
        // typeof guard: a non-string name here would set topic.name to garbage
        // and then 500 inside slugify() (.toLowerCase()), after the mutation.
        if (typeof body.name === "string" && body.name) { topic.name = body.name; topic.slug = slugify(body.name); }
        if (body.color !== undefined) topic.color = body.color;
        if (body.icon !== undefined) topic.icon = body.icon;
        if (body.parentId !== undefined) {
          const newParentId = body.parentId || null;
          // Prevent circular reference: topic can't be its own parent or ancestor
          if (newParentId) {
            if (newParentId === params.id) {
              return json({ error: "topic cannot be its own parent" }, 400);
            }
            // Walk up the ancestor chain to detect cycles
            let ancestorId: string | null = newParentId;
            const visited = new Set<string>();
            while (ancestorId) {
              if (visited.has(ancestorId)) break; // already a cycle in existing data
              visited.add(ancestorId);
              if (ancestorId === params.id) {
                return json({ error: "circular reference: topic cannot be nested under its own descendant" }, 400);
              }
              ancestorId = data.topics[ancestorId]?.parentId || null;
            }
          }
          topic.parentId = newParentId;
        }
        if (body.systemPrompt !== undefined) topic.systemPrompt = body.systemPrompt;
        if (body.contextFiles !== undefined) topic.contextFiles = body.contextFiles;
        if (body.pinnedMessages !== undefined) topic.pinnedMessages = body.pinnedMessages;
        // `archived` NON si cambia da qui, e dirlo e' meglio che ignorarlo: la
        // PATCH lo accettava in silenzio e non archiviava niente — un'archiviazione
        // che non archivia e non protesta e' peggio di un errore. La strada vera e'
        // DELETE {archived:true}, che azzera anche gli unread e pulisce ui_state.
        if (body.archived !== undefined) {
          return json({ error: "usa DELETE /api/topics/:id con {archived:true|false}", code: "wrong_route" }, 400);
        }
        if (body.projectPath !== undefined) {
          // A project path from a PAIRED DEVICE becomes a root of the
          // file-route allowlist (source 2), and `canonicalProjectPath` only
          // expands `~` and resolves symlinks: it judges nothing. Without this
          // a phone binds a topic to `~/.ssh` and reads it back from
          // `/api/files/content`, which is the hole the terminal cwd already
          // had closed.
          if (body.projectPath && clientProjectPathRefused(req, body.projectPath, ctx)) {
            return json({ error: CLIENT_PROJECT_PATH_ERROR }, 400);
          }
          topic.projectPath = body.projectPath ? canonicalProjectPath(body.projectPath) : undefined;
        }
        // Provider/model are spawn-time flags for the claude-code CLI (same
        // as effort below): track changes so we can force an idle respawn.
        let spawnConfigChanged = false;
        const configBefore = { autonomy: topic.autonomyLevel, model: topic.model }; // see `owedChangesOf`
        if (body.autonomyLevel !== undefined) {
          const valid: Topic['autonomyLevel'][] = ['ask', 'auto-apply', 'yolo'];
          // Un livello sconosciuto è un ERRORE del chiamante, non un `ask`.
          //
          // Ripiegare su `ask` voleva dire che una stringa sbagliata — un typo,
          // un client vecchio, un rinomino a metà — metteva la chat in PIANO:
          // l'agente smette di toccare i file e chi ha scritto crede di aver
          // impostato tutt'altro. È la deriva già vista due volte fra il CHECK
          // di SQLite e l'union TS, e il ripiego silenzioso è ciò che la
          // rendeva invisibile.
          if (!valid.includes(body.autonomyLevel)) {
            return json({ error: `autonomyLevel must be one of ${valid.join(', ')}`, code: 'invalid_autonomy_level' }, 400);
          }
          const next = body.autonomyLevel as Topic['autonomyLevel'];
          // L'autonomia decide `--permission-mode`, quindi è un flag di SPAWN
          // come provider e modello: senza il respawn la scelta non avrebbe
          // effetto finché la chat non riparte da sola — cioè sembrerebbe
          // un'impostazione che non fa niente.
          if (next !== topic.autonomyLevel) spawnConfigChanged = true;
          topic.autonomyLevel = next;
        }
        if (body.provider !== undefined) {
          const prev = topic.provider ?? null;
          topic.provider = body.provider || null;
          spawnConfigChanged ||= (topic.provider ?? null) !== prev;
        }
        if (body.model !== undefined) {
          const prev = topic.model ?? null;
          topic.model = body.model || null;
          spawnConfigChanged ||= (topic.model ?? null) !== prev;
        }
        if (body.topicsRouting !== undefined) {
          // AICTRL-01: the switch never rewrites provider/model, but it does
          // change which engine executes the next turn, so it needs the same
          // respawn as an actual provider/model change.
          const prev = topic.topicsRouting ?? null;
          topic.topicsRouting = body.topicsRouting === null ? null : !!body.topicsRouting;
          spawnConfigChanged ||= (topic.topicsRouting ?? null) !== prev;
        }
        // Per-topic effort tier (migration 033). Accepts a valid tier, or
        // null/""/"default" to clear the override (fall back to the global
        // env-resolved default). Unknown tiers are rejected so a stale client
        // can't persist garbage that silently disables the flag at spawn time.
        let effortChanged = false;
        if (body.effort !== undefined) {
          const prev = topic.effort ?? null;
          if (body.effort === null || body.effort === "" || body.effort === "default") {
            topic.effort = null;
          } else {
            const tier = String(body.effort).trim().toLowerCase();
            const VALID_EFFORTS = new Set<string>(EFFORT_TIERS);
            if (!VALID_EFFORTS.has(tier)) return json({ error: "invalid effort tier" }, 400);
            topic.effort = tier;
          }
          effortChanged = (topic.effort ?? null) !== prev;
        }
        // Fast Mode (migration 024). Accept boolean only; null/undefined leaves
        // the existing value alone. Coerce non-boolean truthy/falsy inputs
        // defensively so a stale client sending "false" string doesn't toggle.
        if (body.fastMode !== undefined && body.fastMode !== null) {
          topic.fastMode = body.fastMode === true;
        }
        // Per-topic notification mute (migration 073). Boolean only; null/
        // undefined leaves it alone. Pure metadata — unlike effort/model it is
        // NOT a spawn-time flag, so no respawn/context re-broadcast; the
        // `topic:updated` below is all the client needs to re-gate banners.
        if (body.muted !== undefined && body.muted !== null) {
          topic.muted = body.muted === true;
        }
        if (body.disabledContextSources !== undefined) topic.disabledContextSources = body.disabledContextSources;
        // worktreeId update (Phase A · TOPIC-WT-01). NULL = clear binding.
        if (body.worktreeId !== undefined) {
          if (body.worktreeId === null) {
            topic.worktreeId = null;
          } else {
            const wt = worktreeStore.get(body.worktreeId);
            if (!wt) return json({ error: "worktreeId not found" }, 400);
            topic.worktreeId = body.worktreeId;
          }
        }
        // Phase C · TOPIC-IM-01. NULL = clear (renderer PATCHes after dispatch).
        if (body.initialMessage !== undefined) {
          if (body.initialMessage === null || body.initialMessage === "") {
            topic.initialMessage = null;
          } else {
            // eslint-disable-next-line no-control-regex -- removes control characters from text that came from outside, on purpose
            const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
            if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
            topic.initialMessage = cleaned;
          }
        }
        topic.updatedAt = new Date().toISOString();
        saveSingleTopic(topic);
        broadcastToAll({ type: "topic:updated", topic });
        // Effort tier AND model/provider are fixed at CLI spawn time — drop the
        // idle pooled process so the next turn respawns with the new `--effort`
        // / `--model`. Fire-and-forget: failures are non-fatal (the change still
        // applies on the next natural respawn) and must not block the PATCH
        // response.
        if (effortChanged || spawnConfigChanged) {
          // A change the chat's background work makes wait is said in the chat.
          refreshAndSay(ctx, () => resolveProvider(topic), topic, owedChangesOf(configBefore, topic, effortChanged));
          // Il ring cambia DENOMINATORE, non numeratore: cambiare modello cambia
          // la finestra, e l'ultima misura va riletta contro quella nuova. Senza
          // questo il ring resta fermo sul vecchio rapporto fino al turno dopo —
          // e uno che passa a 1M per fare spazio vede un anello che non si muove,
          // che è indistinguibile da un ring rotto.
          try { broadcastContextForModelChange(topic); }
          catch (err) { console.warn(`[topics] context re-broadcast failed for ${topic.sessionKey}:`, err); }
        }
        return json(presentGlobalOrchestratorTopic(db, topic));
      }

      if (params && method === "DELETE") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "not found" }, 404);
        if (isGlobalOrchestratorTopic(db, topic.id)) {
          return json({
            error: "the global coordinator is a durable Topic and cannot be archived from this route",
            code: "orchestrator_topic_invariant",
          }, 403);
        }
        // An empty body means "archive" (the DELETE-without-body default, kept
        // as-is for backward compatibility). A NON-empty body must parse into
        // an object carrying an explicit `archived` boolean — anything else
        // (malformed JSON, `null`, an array, a primitive, a missing/mistyped
        // key like the `archive` typo) is a 400, not a silent archive.
        let archive = true;
        const text = await req.text();
        if (text.trim().length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return json({ error: "archived must be boolean" }, 400);
          }
          const requested = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { archived?: unknown }).archived
            : undefined;
          if (typeof requested !== "boolean") return json({ error: "archived must be boolean" }, 400);
          archive = requested;
        }
        if (archive) {
          // Un solo posto sa cosa vuol dire "archiviato": flag + unread a zero
          // + purge da ui_state. Lo stesso servizio che usa il dispatcher, così
          // i due percorsi non possono più divergere (services/archive-topic.ts).
          const res = archiveTopicFully({
            getTopicById, saveSingleTopic, loadUnread, saveUnreadEntries: ctx.saveUnreadEntries, broadcastToAll,
            purgeFromUiState: (id) =>
              purgeTopicFromUiState(ctx.db, broadcastToAll, id, (c) => browserService?.destroyContext(c)),
            parkClaudeSession: parkTopicSession,
            recordRetirement: (id, at) => recordRetirement(ctx.db, "topic", id, at, "archive"),
            cancelPendingAsk: cancelAsk,
            stopProcesses: stopTopicProcesses,
          }, params.id);
          // Bug #12: if the purge fails we return 500 — topic is archived but
          // ui_state is stale, so client-side reload will see a phantom id.
          if (res.purgeError) {
            return json({ error: "topic archived but ui_state purge failed", details: res.purgeError, topic: res.topic }, 500);
          }
          // Archiving IS the end of the session, so the automatic checkpoints
          // go with it: they are a net for "undo the last turn", and once the
          // chat is closed there is no last turn left to undo. Leaving them
          // would be leaving git objects in somebody's repository forever, one
          // namespace per chat they ever opened. Non-fatal and not awaited: a
          // ref that refuses to die must not turn an archive into a 500.
          if (topic.projectPath) {
            void dropTurnCheckpoints(topic.projectPath, topic.sessionKey).catch((err) =>
              console.warn(`[topics] checkpoint sweep failed for ${topic.sessionKey}:`, err),
            );
          }
          return json(res.topic);
        }
        // Unarchive is a REOPEN: retract the close markers the purge left, or
        // the client's hydrate strip would delete the tab on every load and
        // the chat would be permanently un-openable.
        // The retirement fact goes with the flag and the ui_state markers, or
        // the next boot's reconcile closes the chat again, person inside.
        const reopened = reopenTopicFully(reopenDepsFor(ctx, broadcastToAll), params.id) ?? topic;
        return json(presentGlobalOrchestratorTopic(db, reopened));
      }
    }

    return null;
  };
}
