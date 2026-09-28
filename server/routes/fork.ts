import type { AppContext, RouteHandler, Topic } from "../types";
import type { AIProvider } from "../providers";
import { forkModeFor } from "../../shared/chat-fork";
import { cliForkBlocker, copyThreadForFork, forkPointIndex } from "../lib/chat-fork";
import { insertChatFork } from "../lib/chat-fork-store";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";

export interface ForkDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
}

/**
 * The CLI runtimes say where a fork of their session starts: the session
 * (`ref`: a Claude Code session id, a Codex thread id) and the point in it
 * (`at`: the transcript uuid of the last answer, the rollout's byte size), and
 * for Claude Code the last answer's text. Null = nothing to fork from.
 */
type ForkPointSource = { forkPoint?(sessionKey: string): { ref: string; at: string; text?: string } | null };

/**
 * `POST /api/topics/:id/fork`: «Fork into a new chat» and `/fork` (CHAT-FORK-01).
 *
 * ONE door, one transaction. The branch's topic, its copy of the history and
 * its `chat_forks` row are written together, so a half-made branch never
 * appears; three client calls (create, copy, bind) would leave one at the
 * first network error, with the CLI session still to bind.
 *
 * The original is only read: its rows, `active_branches` and its provider
 * session do not change.
 *
 * Every refusal comes BEFORE the first write, and each carries a `code` the
 * client translates: the coordinator (403, as edit.ts), a turn in flight (409
 * `turn_in_progress`: a branch is born from a finished answer), a runtime with
 * no way to carry the memory (409 `fork_unsupported`, shared/chat-fork.ts), a
 * branch with no finished answer yet (400 `nothing_to_fork`).
 */
export function createForkRouter(ctx: AppContext, deps: ForkDeps): RouteHandler {
  const {
    db, json, readJSON, matchRoute, getTopicById, isStreaming, loadActiveThread,
    saveSingleTopic, saveLocalMessages, slugify, broadcastToAll,
  } = ctx;

  return async function forkRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    const params = matchRoute(pathname, "/api/topics/:id/fork");
    if (!params || method !== "POST") return null;

    const parent = getTopicById(params.id);
    if (!parent) return json({ error: "topic not found" }, 404);
    if (isGlobalOrchestratorSession(db, parent.sessionKey)) {
      return json({ error: "the global coordinator cannot be forked", code: "orchestrator_topic_invariant" }, 403);
    }
    if (isStreaming(parent.sessionKey)) {
      return json({ error: "wait for the turn to end before forking", code: "turn_in_progress" }, 409);
    }
    // The RESOLVED provider, not the column: a topic with no provider runs on the installation's.
    // One that does not resolve (not connected, not routable) could not run the branch either.
    let provider: AIProvider;
    try { provider = deps.resolveProvider(parent); } catch (err) {
      return json({ error: (err as Error).message, code: "fork_unsupported" }, 409);
    }
    const runtime = forkModeFor(provider.name);
    if (!runtime) {
      return json({ error: `${provider.name} keeps its conversation outside Topics: this chat cannot be forked`, code: "fork_unsupported" }, 409);
    }
    const thread = loadActiveThread(parent.sessionKey, { withBlocks: true });
    const point = forkPointIndex(thread);
    if (point < 0) return json({ error: "there is no finished answer to fork from", code: "nothing_to_fork" }, 400);

    const body = await readJSON(req);
    const name = (typeof body?.name === "string" ? body.name.trim() : "") || `${parent.name} (ramo)`;

    // The CLI runtimes fork the parent's own session, unless its memory would
    // not match the copy (`cliForkBlocker`): then the copy is the memory, and
    // the branch's first start carries its recap (CCLI-06).
    let parentRef: string | null = null;
    let parentAt: string | null = null;
    let branchRef: string | null = null;
    if (runtime !== "db-history") {
      const from = (provider as AIProvider & ForkPointSource).forkPoint?.(parent.sessionKey) ?? null;
      const blocker = !from
        ? "no-parent-session"
        : cliForkBlocker(thread, point, runtime === "claude-cli" ? { last: { uuid: from.at, text: from.text ?? "" } } : undefined);
      if (from && !blocker) {
        parentRef = from.ref;
        parentAt = from.at;
        if (runtime === "claude-cli") branchRef = crypto.randomUUID();
      } else {
        console.log(`[fork] ${parent.sessionKey}: the branch starts from the copied history (${blocker})`);
      }
    }

    const id = crypto.randomUUID();
    const sessionKey = "topic:" + id.slice(0, 8);
    const now = new Date().toISOString();
    const copy = copyThreadForFork(thread.slice(0, point + 1));
    db.transaction(() => {
      // Inherited: how the chat works. Not inherited: what the page remembers
      // (pinned messages, the goal, the browser, a queued first message) and
      // the board's MCP scoping, which belongs to a dispatched session.
      const topic: Topic = {
        id, name, slug: slugify(name), parentId: null, links: [], sessionKey,
        color: parent.color, icon: parent.icon, createdAt: now, updatedAt: now, archived: false,
        systemPrompt: parent.systemPrompt ?? "", contextFiles: parent.contextFiles ?? [], pinnedMessages: [],
        disabledContextSources: parent.disabledContextSources,
        sortOrder: (db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number }).n,
        provider: parent.provider ?? null, model: parent.model ?? null, effort: parent.effort ?? null,
        autonomyLevel: parent.autonomyLevel, fastMode: parent.fastMode, topicsRouting: parent.topicsRouting ?? null,
        projectPath: parent.projectPath, standalone: parent.standalone, worktreeId: parent.worktreeId ?? null,
      };
      saveSingleTopic(topic);
      saveLocalMessages(sessionKey, copy);
      insertChatFork(db, {
        sessionKey, parentTopicId: parent.id, parentName: parent.name, forkPointMessageId: copy[copy.length - 1].id,
        runtime, parentRef, parentAt, branchRef, createdAt: now,
      });
      // The branch's session, minted here so the fork is bound to it (lib/chat-fork.ts,
      // `forkStartFor`). `import_offset` NULL: not an adopted session, the import sweep must not follow it.
      if (branchRef) {
        db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
          .run(sessionKey, branchRef, now, now);
      }
    })();

    const branch = getTopicById(id)!;
    broadcastToAll({ type: "topic:created", topic: branch });
    return json(branch, 201);
  };
}
