/** Response shapes and helpers shared by more than one family of bridge tools. */

/**
 * Response shapes returned by the topics-app HTTP surface for the Phase-1
 * bridge tools. These live at a trust boundary (a remote process with no tsc
 * gate), so callers declare the field they read rather than passing `any`
 * around. Fields stay optional — the parsed body is still untrusted input and
 * each caller guards what it actually uses.
 */
export interface RunScriptResp { processId?: string; pid?: number }
export interface ScriptRow {
  status?: string;
  scriptName?: string;
  processId?: string;
  pid?: number;
  ports?: number[];
  exitCode?: number | null;
}
export interface ScriptsResp { scripts?: ScriptRow[] }
export interface ProcessOutputResp {
  output?: string;
  offset?: number;
  status?: string;
  done?: boolean;
  exitCode?: number | null;
}
export interface ProcessWaitResp extends ProcessOutputResp {
  reason?: string;
  waitedMs?: number;
  truncatedLines?: number;
  scriptName?: string;
}
export interface TaskRow {
  status?: string;
  text?: string;
  id?: string;
  projectId?: string;
  project_id?: string;
  priority?: number;
  assignedTo?: string;
  assigned_to?: string;
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}
export interface TasksResp { tasks?: TaskRow[] }
/**
 * `pending` = i check pre-review stanno ancora girando (202). Non e' un esito:
 * il task non si e' mosso, e sta a noi rimetterci in fila con un'altra gamba.
 */
export interface UpdateTaskResp { status?: string; id?: string; pending?: boolean }
export interface CommentRow { id?: string; author?: string; content?: string }
export interface GetTaskResp { task?: TaskRow; comments?: CommentRow[] }
export interface CreateTaskResp { id?: string; status?: string; deduped?: boolean }
export interface CommentResp { id?: string }

/** Pause between poll legs; shared by the board and human-prompt tools. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
