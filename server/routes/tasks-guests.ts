/**
 * What a guest may do on a shared task: the action matcher and the two writes.
 */

import type { TasksCore } from "./tasks-scope";

/**
 * The only writes a GUEST may make on a shared task, and the minimum level
 * each needs - `read` moves nothing, `unsupported` covers every other route
 * on this router (run, stop, retitle, label, move, merge, land, publish,
 * deploy, ...): those stay out of reach at ANY level, because "start an
 * agent", "code changes", "approval" and "publishing" are distinct actions
 * that a collaboration capability never grants implicitly.
 *
 * `/run` has its own result because it is checked against a separate,
 * owner-issued capability. `/stop` remains unsupported: start does not confer
 * lifecycle or owner powers.
 *
 * Pure and testable on its own: `idInPath` is the EXACT segment read from
 * the path (still url-encoded), so comparing against `pathname` does not
 * need a second regex here.
 */
export function matchGuestTaskAction(
  pathname: string,
  idInPath: string,
  method: string,
): "read" | "comment" | "edit" | "run" | "unsupported" {
  const base = `/api/tasks/${idInPath}`;
  if (method === "GET") return pathname === base ? "read" : "unsupported";
  if (method === "POST" && pathname === `${base}/comments`) return "comment";
  if (method === "POST" && pathname === `${base}/run`) return "run";
  if (method === "PATCH" && pathname === base) return "edit";
  return "unsupported";
}

export function createTasksGuests(core: TasksCore) {
  const { svc, json, readJSON, broadcastToAll } = core;

  /**
   * THE TWO WRITES A GUEST MAY MAKE, each gated by its own level - never
   * behind `edit` on the HUMAN/agent routes (run, stop, retitle, label, move,
   * merge, land, publish, deploy, ...): those stay out of reach at any level,
   * because "start an agent", "code changes", "approval" and "publishing" are
   * distinct actions that no collaboration level grants implicitly.
   */
  async function handleGuestComment(taskId: string, deviceId: string, req: Request): Promise<Response> {
    const body = (await readJSON(req)) as { content?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return json({ error: "empty comment", code: "bad_request" }, 400);
    const got = svc.get(taskId);
    if (!got) return json({ error: "task not found", code: "not_found" }, 404);
    const comment = svc.addComment({
      taskId,
      author: `guest:${deviceId}`,
      content,
      projectId: got.task.projectId,
    });
    const task = svc.get(taskId)?.task ?? got.task;
    broadcastToAll({ type: "task:updated", projectId: got.task.projectId, task });
    return json(comment);
  }

  async function handleGuestEdit(taskId: string, deviceId: string, req: Request): Promise<Response> {
    const body = (await readJSON(req)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text is required", code: "bad_request" }, 400);
    const got = svc.get(taskId);
    if (!got) return json({ error: "task not found", code: "not_found" }, 404);
    const task = svc.update({
      taskId,
      actor: "human",
      by: `guest:${deviceId}`,
      projectId: got.task.projectId,
      patch: { text },
    });
    broadcastToAll({ type: "task:updated", projectId: got.task.projectId, task });
    return json(task);
  }

  return { handleGuestComment, handleGuestEdit };
}
