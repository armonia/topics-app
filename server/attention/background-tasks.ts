/**
 * THE TASKS A TURN LEAVES RUNNING, READ FROM THE HOOKS AND THE TRANSCRIPT
 * (notifications-redesign, design section 5.1; MONITOR-04 modified, ATTN-03).
 *
 * Pure: a hook or a transcript line in, the change to the subject's task map
 * out. `claude-session-tracker.ts` applies it to the attention store, the one
 * holder of the map, and reads back how many tasks count at `Stop`.
 *
 * Ids are the ones the CLI uses everywhere, so the transcript's
 * `<task-notification>` names the same task the hook started (shapes recorded
 * with Claude Code 2.1.282, `tests/fixtures/claude-cli-2.1.282-*.ndjson`):
 *
 *   Bash (run_in_background)  tool_response.backgroundTaskId
 *   Agent (run_in_background) tool_response.agentId
 *   Monitor                   tool_response.taskId
 *   Workflow                  "Task ID: <id>" in the response text
 *   CronCreate                tool_response.id, tool_response.recurring
 *
 * A task enters at its `PreToolUse` under the call's id (so a turn that ends
 * before the `PostToolUse` still waits on it) and is re-keyed to the CLI's id
 * when the `PostToolUse` names it.
 */
import type { AttentionTask } from "../../shared/attention";

type TaskInfo = Omit<AttentionTask, "id">;

export type TaskChange =
  | { op: "add"; id: string; task: TaskInfo; replaces?: string }
  | { op: "remove"; id: string }
  | { op: "remove-kind"; kind: string }
  /** A turn opened after the one that armed them: the one-shot crons have fired (or the person moved on). */
  | { op: "remove-one-shot-crons" }
  | { op: "clear" };

interface HookLike {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
}

function input(h: HookLike): Record<string, unknown> {
  return h.tool_input && typeof h.tool_input === "object" ? (h.tool_input as Record<string, unknown>) : {};
}

function response(h: HookLike): Record<string, unknown> | null {
  return h.tool_response && typeof h.tool_response === "object" ? (h.tool_response as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The text of a response, for the tools that answer in prose ("Task ID: ..."). */
function responseText(h: HookLike): string {
  if (typeof h.tool_response === "string") return h.tool_response;
  const r = response(h);
  if (!r) return "";
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) return r.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
  return typeof r.result === "string" ? r.result : "";
}

/** What kind of background work this call launches, or null for a foreground call. */
function backgroundKind(h: HookLike): string | null {
  const name = h.tool_name;
  const toolInput = input(h);
  if (name === "Monitor") return "monitor";
  if (name === "Workflow") return "workflow";
  if (name === "CronCreate") return "cron";
  if ((name === "Bash" || name === "Agent" || name === "Task") && toolInput.run_in_background === true) return name === "Bash" ? "bash" : "agent";
  return null;
}

function labelOf(h: HookLike, kind: string): string {
  const toolInput = input(h);
  const r = response(h);
  return str(toolInput.description) ?? str(toolInput.command) ?? str(toolInput.name) ?? str(r?.humanSchedule) ?? str(toolInput.cron) ?? str(toolInput.prompt)?.slice(0, 80) ?? kind;
}

/** The CLI's id for the task this call started, read from its response. */
function cliTaskId(h: HookLike): string | null {
  const r = response(h);
  if (r) {
    const id = str(r.backgroundTaskId) ?? str(r.agentId) ?? str(r.taskId) ?? (h.tool_name === "CronCreate" ? str(r.id) : null);
    if (id) return id;
  }
  const m = /Task ID:\s*([A-Za-z0-9_-]+)/.exec(responseText(h));
  return m ? m[1] : null;
}

/** The changes one hook makes to the subject's task map. `at` dates a new task. */
export function taskChangesOfHook(h: HookLike, at: string): TaskChange[] {
  switch (h.hook_event_name) {
    case "SessionStart":
    case "SessionEnd":
      // A new or ended session inherits no wait.
      return [{ op: "clear" }];
    case "MonitorArmed":
      // The legacy hook of older CLIs: one Monitor, with no id of its own.
      return [{ op: "add", id: "monitor:legacy", task: { kind: "monitor", label: "Monitor", startedAt: at } }];
    case "MonitorClosed":
      return [{ op: "remove-kind", kind: "monitor" }];
    case "PreToolUse": {
      if (h.tool_name === "CronDelete") return [];
      const kind = backgroundKind(h);
      // A cron is known only by its response (the id, whether it recurs).
      if (!kind || kind === "cron") return [];
      const id = h.tool_use_id || `${kind}:${at}`;
      return [{ op: "add", id, task: { kind, label: labelOf(h, kind), startedAt: at } }];
    }
    case "PostToolUse": {
      if (h.tool_name === "CronDelete") {
        const id = str(input(h).id);
        return id ? [{ op: "remove", id }] : [];
      }
      const kind = backgroundKind(h);
      if (!kind) return [];
      const id = cliTaskId(h);
      if (kind === "cron") {
        const r = response(h);
        // A durable cron survives the CLI (".claude/scheduled_tasks.json"): nothing to wait on here.
        if (!id || r?.durable === true) return [];
        const recurring = r?.recurring === false ? false : r?.recurring === true ? true : input(h).recurring !== false;
        return [{ op: "add", id, task: { kind, label: labelOf(h, kind), startedAt: at, ...(recurring ? { recurring: true } : {}) } }];
      }
      if (!id) return [];
      return [{ op: "add", id, task: { kind, label: labelOf(h, kind), startedAt: at }, ...(h.tool_use_id && h.tool_use_id !== id ? { replaces: h.tool_use_id } : {}) }];
    }
    default:
      return [];
  }
}

const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function tag(body: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].trim() : null;
}

/** The text of a transcript user line. */
function lineText(parsed: Record<string, unknown>): string {
  const content = (parsed.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
  return "";
}

/**
 * Where a line carries its `<task-notification>`. One that lands while a turn
 * runs never becomes a user line: Claude Code absorbs it mid-turn, and only its
 * `queue-operation` enqueue names it (2.1.292,
 * `tests/fixtures/claude-cli-2.1.292-absorbed-task-notification.transcript.jsonl`).
 * The enqueue is written for every notification, delivered or absorbed.
 */
function notificationText(parsed: Record<string, unknown>): string {
  if (parsed.type === "user") return lineText(parsed);
  if (parsed.type === "queue-operation" && parsed.operation === "enqueue" && typeof parsed.content === "string") return parsed.content;
  return "";
}

/**
 * The tasks a transcript line reports as finished. A Bash, an Agent, a
 * Workflow report once, at their end. A Monitor reports every event: only its
 * END closes it (a `<status>`, or an event that says it expired, ended or
 * stopped). A one-shot cron is closed by its fire, which the transcript does
 * not name: the next turn that opens in a terminal (`remove-one-shot-crons`,
 * `tracker-sync.ts`), `PostToolUse` of `CronDelete`, or the end of the process
 * take it.
 */
export function finishedTasksOfTranscriptLine(line: string, kindOf: (id: string) => string | null): string[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(line); } catch { return []; }
  if (!parsed) return [];
  const text = notificationText(parsed);
  if (!text.includes("<task-notification>")) return [];
  const out: string[] = [];
  for (const m of text.matchAll(TASK_NOTIFICATION)) {
    const body = m[1];
    const id = tag(body, "task-id");
    if (!id) continue;
    if (kindOf(id) === "monitor") {
      const event = tag(body, "event") ?? "";
      const status = tag(body, "status");
      const summary = tag(body, "summary") ?? "";
      const ended = !!status || /\[Monitor expired|stream ended|stopped/i.test(event) || /stream ended|stopped/i.test(summary);
      if (!ended) continue;
    }
    out.push(id);
  }
  return out;
}

/** What `commandWakeState` (`routes/processes.ts`) says of a session's Topics commands. */
export type CommandOwed = "running" | "wake-queued" | "none";

/**
 * A chat's task map with its Topics `run_command`s folded in as ONE task
 * (`command`, design section 5.2): the CLI's snapshot does not know them, the
 * process registry does. Every place that writes a chat's map goes through
 * here, the turn's end and the changes in between (a command started or
 * ended, a CLI task listed or gone), so none of them drops what another put.
 */
export function withCommandTask(
  tasks: Readonly<Record<string, TaskInfo>>,
  owed: CommandOwed,
  startedAt: string,
): { tasks: Record<string, TaskInfo>; count: number; kinds: string[] } {
  const out: Record<string, TaskInfo> = {};
  for (const [id, t] of Object.entries(tasks)) if (id !== "command") out[id] = t;
  if (owed !== "none") out.command = { kind: "command", label: "run_command", startedAt: tasks.command?.startedAt ?? startedAt };
  const counting = Object.values(out).filter((t) => !t.recurring);
  return { tasks: out, count: counting.length, kinds: [...new Set(counting.map((t) => t.kind))] };
}
