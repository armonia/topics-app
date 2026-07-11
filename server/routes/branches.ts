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
    // subtree (every branch that hung off it), then repair the branch
    // bookkeeping so navigation stays coherent:
    //  · remaining siblings are renumbered DENSE (the arrows step ±1 on
    //    literal branch_index values — a hole would strand them);
    //  · the parent's active pointer is clamped onto a surviving sibling,
    //    or dropped entirely when 0/1 children remain (index 0 default);
    //  · active_branches rows keyed by any deleted id are dropped.
    // Returns the resulting active thread, same contract as switch-branch.
    const delParams = matchRoute(pathname, "/api/messages/:id");
    if (delParams && method === "DELETE") {
      const msg = getMessageById(delParams.id);
      if (!msg) return json({ error: "message not found" }, 404);
      const sessionKey = getMessageSessionKey(delParams.id);
      if (!sessionKey) return json({ error: "session not found" }, 404);
      if (ctx.isStreaming(sessionKey)) return json({ error: "cannot delete while a response is streaming" }, 409);

      const deletedIndex = msg.branchIndex ?? 0;
      const parentKey = msg.parentId ?? "__root__";
      ctx.db.transaction(() => {
        // Subtree ids (self included) via recursive CTE, session-scoped.
        const subtree = ctx.db
          .prepare(
            `WITH RECURSIVE sub(id) AS (
               SELECT id FROM messages WHERE id = ? AND session_key = ?
               UNION ALL
               SELECT m.id FROM messages m JOIN sub ON m.parent_id = sub.id
             ) SELECT id FROM sub`,
          )
          .all(delParams.id, sessionKey) as Array<{ id: string }>;
        const ids = subtree.map(r => r.id);
        const placeholders = ids.map(() => "?").join(",");
        ctx.db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
        ctx.db
          .prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id IN (${placeholders})`)
          .run(sessionKey, ...ids);

        // Renumber the surviving siblings densely, preserving their order.
        const siblings = ctx.db
          .prepare(
            msg.parentId
              ? `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id = ? ORDER BY branch_index ASC`
              : `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id IS NULL ORDER BY branch_index ASC`,
          )
          .all(...(msg.parentId ? [sessionKey, msg.parentId] : [sessionKey])) as Array<{ id: string; branch_index: number }>;
        const renumber = ctx.db.prepare(`UPDATE messages SET branch_index = ? WHERE id = ?`);
        siblings.forEach((s, i) => { if (s.branch_index !== i) renumber.run(i, s.id); });

        if (siblings.length <= 1) {
          ctx.db
            .prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id = ?`)
            .run(sessionKey, parentKey);
        } else {
          // Land on the sibling that took the deleted branch's slot (or the
          // last one when the deleted branch was the highest index).
          const nextActive = Math.min(deletedIndex, siblings.length - 1);
          ctx.db
            .prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`)
            .run(parentKey, sessionKey, nextActive);
        }
      })();

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
