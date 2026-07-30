import type { AppContext, RouteHandler } from "../types";

/**
 * Message-branch endpoints. For now: POST /api/messages/:id/switch-branch —
 * point a parent's active branch at a different child thread and return the
 * resulting active thread. Split out of the topics.ts god-file; fully
 * self-contained on ctx (matchRoute/readJSON/json, the message helpers,
 * switchActiveBranch/loadActiveThread, ctx.db). The companion /edit handler
 * stays in topics.ts for now — it terminates in the ~200-line streamEditResponse
 * SSE helper and belongs with a focused streaming-path extraction.
 */
export function createBranchesRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, getMessageById, getMessageSessionKey, switchActiveBranch, loadActiveThread } = ctx;

  return async function branchesRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // DELETE /api/messages/:id — remove a message AND its whole descendant
    // subtree (every branch that hung off it), repairing the branch bookkeeping
    // so navigation stays coherent. La transazione (sottoalbero via CTE,
    // rinumerazione densa dei fratelli, puntatore attivo riagganciato) sta in
    // `ctx.deleteMessageSubtree`: la condivide con lo scarto del turno vuoto
    // sull'abort. Returns the resulting active thread, same contract as
    // switch-branch.
    const delParams = matchRoute(pathname, "/api/messages/:id");
    if (delParams && method === "DELETE") {
      const msg = getMessageById(delParams.id);
      if (!msg) return json({ error: "message not found" }, 404);
      const sessionKey = getMessageSessionKey(delParams.id);
      if (!sessionKey) return json({ error: "session not found" }, 404);
      if (ctx.isStreaming(sessionKey)) return json({ error: "cannot delete while a response is streaming" }, 409);

      ctx.deleteMessageSubtree(sessionKey, delParams.id);

      return json({ messages: loadActiveThread(sessionKey) });
    }

    const params = matchRoute(pathname, "/api/messages/:id/switch-branch");
    if (params && method === "POST") {
      const body = await readJSON(req);
      if (body?.branchIndex === undefined) return json({ error: "branchIndex required" }, 400);

      const msg = getMessageById(params.id);
      if (!msg) return json({ error: "message not found" }, 404);

      const sessionKey = getMessageSessionKey(params.id);
      if (!sessionKey) return json({ error: "session not found" }, 404);

      const parentId = msg.parentId;
      if (!parentId) {
        // Root message — switch active root branch
        ctx.db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES ('__root__', ?, ?)`).run(sessionKey, body.branchIndex);
      } else {
        switchActiveBranch(sessionKey, parentId, body.branchIndex);
      }

      // Return the new active thread
      const thread = loadActiveThread(sessionKey);
      return json({ messages: thread });
    }

    return null;
  };
}
