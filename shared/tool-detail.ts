/**
 * Tool detail normalizer: the ONE implementation.
 *
 * Translates a raw tool name + args (as emitted by the Claude Code CLI, the
 * Codex CLI, the OpenClaw gateway, the native provider, etc.) into the typed
 * `ToolCallDetail` union the renderer branches on. The server runs it at the
 * provider boundary, so:
 *   1. The wire format the client sees is uniform across providers.
 *   2. Tool-name aliases (`Bash` / `bash` / `shell` / `exec_command`) collapse
 *      into one `detail.type === "shell"` shape.
 *   3. The renderer doesn't have to JSON-grovel `args` for every tool kind.
 * The client runs the same function only for a tool call that reached it
 * without a usable `detail` (rows stored before the boundary existed), and
 * otherwise only renders.
 *
 * It used to live twice, `server/providers/claude/tool-detail.ts` and
 * `client/src/components/Chat/toolDetail.ts`, "kept in sync" by a comment. In
 * 90 days 21 commits touched them: 12 both, 9 the client only, 0 the server
 * only. The client copy had drifted ahead (the goal-steps rule below existed
 * only there), so this module is the CLIENT's semantics, proven equal to it on
 * every tool call stored in a copy of the live database.
 *
 * The mapping is intentionally permissive: when a tool name doesn't match a
 * known kind we return `{ type: "unknown", raw: { args, result? } }` so the
 * renderer falls back to a generic JSON view instead of dropping the call.
 */

import type { ToolCall, ToolCallDetail } from "./types";
import { isPlanFile } from "./plan-file";
import { batchEditUnifiedDiff } from "./multi-edit-diff";

/**
 * The Topics bridge tools (`server/mcp/topics-mcp-server.ts`), as the native
 * provider names them: bare. A literal list because shared/ cannot import from
 * `server/`; `server/providers/claude/tool-detail.test.ts` pins it to the real
 * table.
 */
export const TOPICS_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "open_browser_pane", "close_browser_pane", "browser_list_tabs", "browser_focus_tab", "import_chrome",
  "run_script", "run_command", "list_processes", "read_process_output", "stop_process",
  "list_tasks", "create_task", "get_task", "get_goal", "close_goal", "set_goal", "update_goal_steps",
  "update_task", "wait_for_condition", "label_task", "comment_task",
  "list_global_tasks", "get_global_task", "create_global_task", "update_global_task", "comment_global_task",
  "move_session_to_project", "spawn_agent", "send_to_agent", "read_agent", "list_agents", "stop_agent",
  "switch_topic", "new_topic", "create_project", "open_project", "send_chat_message", "read_chat_messages",
  "resolve_tab", "send_mail", "google_call",
]);

/** The in-app browser tools (`server/browser-tool-spec.ts`), also bare. */
export const TOPICS_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser_open", "browser_observe", "browser_act", "browser_extract", "browser_get_text",
  "browser_screenshot", "browser_read_screen", "browser_console", "browser_network", "browser_eval",
  "browser_save_state", "browser_load_state", "browser_point", "browser_import_chrome",
  "browser_status", "browser_upload",
]);

/** Lowercase + trim, for alias match. */
function canon(name: string): string {
  return (name || "").toLowerCase().trim();
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function s(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const SHELL_NAMES = new Set(["bash", "shell", "exec_command", "run_command", "terminal", "exec"]);
const READ_NAMES = new Set(["read", "read_file", "view_file", "view"]);
const EDIT_NAMES = new Set(["edit", "edit_file", "multiedit", "apply_patch", "apply_diff", "str_replace_editor", "str_replace"]);
const WRITE_NAMES = new Set(["write", "write_file", "create_file"]);
const SEARCH_NAMES = new Set(["search", "websearch", "web_search"]);
const FETCH_NAMES = new Set(["webfetch", "web_fetch", "fetch"]);
/** The whole-list form: one call carries the ENTIRE todo list. */
const TODO_LIST_NAMES = new Set(["todowrite", "todo_write"]);
/** The per-item form the CLI 2.1.220 added: one call, one task. */
const TODO_ITEM_NAMES = new Set(["taskcreate", "task_create", "taskupdate", "task_update"]);

/**
 * Every name that can produce a `detail.type === 'todo'` from a todo tool.
 *
 * Exported because `selectLatestTodo` needs the same list as a cheap pre-filter
 * (it runs on the whole transcript at every streaming frame, and Zod-parsing a
 * detail per tool call to answer "no" was the cost it avoids). That list used to
 * be a SECOND copy held in sync by a comment: a name added to the branches below
 * and not to the copy silently lost its strip. One set, two readers.
 */
export const TODO_TOOL_NAMES: ReadonlySet<string> = new Set([...TODO_LIST_NAMES, ...TODO_ITEM_NAMES]);

/** `update_goal_steps`, bare (native provider) or behind any MCP prefix. */
export function isGoalStepsTool(name: string): boolean {
  const c = canon(name);
  return c === "update_goal_steps" || c.endsWith("__update_goal_steps");
}

/** `set_goal`, bare or behind any MCP prefix. */
export function isSetGoalTool(name: string): boolean {
  const c = canon(name);
  return c === "set_goal" || c.endsWith("__set_goal");
}

/**
 * Goal steps as a todo. Same shape as the TodoWrite list (content + status),
 * so same card and same summary "2/7 · current step": before, they were
 * generic JSON with an empty header. An unknown status or an empty list stays
 * generic: an invented todo is worse than the JSON.
 *
 * Deliberately NOT in TODO_TOOL_NAMES: the strip above the composer is for the
 * turn's todos, and GoalBar already shows the goal steps.
 */
export function goalStepsAsTodo(args: unknown): ToolCallDetail | null {
  const steps = asRecord(args).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
  for (const raw of steps) {
    const step = typeof raw === "string" ? { content: raw } : asRecord(raw);
    const content = s(step.content);
    if (!content) continue;
    const status = s(step.status) ?? "pending";
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
    items.push({ content, status });
  }
  return items.length > 0 ? { type: "todo", items } : null;
}

/** The tools that open a page in the in-app browser, under the names they travel with. */
const OPEN_PANE_NAMES = new Set(["open_browser_pane", "mcp__topics__open_browser_pane"]);
const BROWSER_OPEN_NAMES = new Set(["browser_open", "mcp__topics__browser_open"]);

/** The outcome line of `open_browser_pane` (`server/mcp/topics-mcp-server.ts`),
 *  wherever a port warning pushed it. The title is lazy so a `)` inside it stays. */
const OPEN_PANE_OUTCOME = /^(Opened browser pane|Browser context ready) at (\S+)(?: \(title: (.*?)\))?(?= \u2014 |\s*\[contextId:|$)/m;
const OPENED_CONTEXT = /\[contextId: ([^\]\s]+)\]\s*$/;
/** The warning a non-fatal opening (a task chat's) puts ahead of its outcome
 *  when the page never loaded (`server/routes/browser-open-pane-flow.ts`). */
const NAVIGATION_FAILED = /^navigation failed: /m;

/** `host[:port]` of a URL, or the URL itself when it does not parse. */
export function pageHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * A successful opening of a page, as the chat marker draws it (CHAT-BROWSER-01).
 *
 * Null when it is not one: no url to point at, a call the caller knows failed,
 * or a result that is not the tool's success shape (an `HTTP 502`, a `{error}`,
 * a validation message). A row with NO result at all still counts: stored rows
 * older than the result capture only have `args.url`, and they did open.
 */
function browserOpenDetail(c: string, a: Record<string, unknown>, result: string | undefined): ToolCallDetail | null {
  const url = s(a.url);
  if (!url) return null;
  const name = s(a.name)?.trim();
  const base = { type: "browser" as const, url, ...(name ? { name } : {}) };
  if (!result) return base;
  if (OPEN_PANE_NAMES.has(c)) {
    const m = OPEN_PANE_OUTCOME.exec(result);
    if (!m) return null;
    // The context is ready but the page is not: nothing was opened to point at.
    if (NAVIGATION_FAILED.test(result.slice(0, m.index))) return null;
    const contextId = OPENED_CONTEXT.exec(result)?.[1];
    return {
      ...base,
      ...(m[3] ? { title: m[3] } : {}),
      ...(contextId ? { contextId } : {}),
      visible: m[1] === "Opened browser pane",
      result,
    };
  }
  let body: Record<string, unknown>;
  try {
    body = asRecord(JSON.parse(result));
  } catch {
    return null;
  }
  if (body.error !== undefined || !s(body.url)) return null;
  return {
    ...base,
    // The final URL after a redirect: it is the page the agent is looking at.
    url: s(body.url)!,
    ...(s(body.title) ? { title: s(body.title)! } : {}),
    ...(s(body.contextId) ? { contextId: s(body.contextId)! } : {}),
    result,
  };
}

/**
 * Build a `ToolCallDetail` from a tool name + args. Result string optional:
 * the caller passes it on tool_result events to enrich `output`/`content`/
 * `result` fields per detail kind. `failed` is for a caller that knows the
 * call errored: no kind may then claim it produced something (a browser
 * opening that failed opened nothing).
 */
export function deriveToolDetail(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: string,
  opts?: { failed?: boolean },
): ToolCallDetail {
  const c = canon(name);
  const a = asRecord(args);

  if (!opts?.failed && (OPEN_PANE_NAMES.has(c) || BROWSER_OPEN_NAMES.has(c))) {
    const opened = browserOpenDetail(c, a, result);
    if (opened) return opened;
  }

  if (isGoalStepsTool(name)) {
    const todo = goalStepsAsTodo(a);
    if (todo) return todo;
  }

  // Shell variants: Claude Code, Codex, MCP shell tools.
  if (SHELL_NAMES.has(c)) {
    return {
      type: "shell",
      command: s(a.command) ?? s(a.cmd) ?? s(a.input) ?? "",
      // Claude Code writes one on every Bash call: the row's readable label.
      ...(s(a.description) ? { description: s(a.description)! } : {}),
      ...(s(a.cwd) ? { cwd: s(a.cwd)! } : {}),
      ...(a.run_in_background === true ? { background: true } : {}),
      ...(result ? { output: result } : {}),
    };
  }

  if (READ_NAMES.has(c)) {
    return {
      type: "read",
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "",
      ...(result ? { content: result } : {}),
      ...(n(a.offset) != null ? { offset: n(a.offset)! } : {}),
      ...(n(a.limit) != null ? { limit: n(a.limit)! } : {}),
    };
  }

  // Edit variants: single Edit, MultiEdit, apply_patch, str_replace.
  if (EDIT_NAMES.has(c)) {
    if (c === "multiedit" && Array.isArray(a.edits)) {
      // EVERY edit, as hunks of one diff (`shared/multi-edit-diff.ts`): the
      // first-edit-plus-a-count form left the rest of them off the screen.
      const edits = a.edits as Array<Record<string, unknown>>;
      return {
        type: "edit",
        filePath: s(a.file_path) ?? s(a.filePath) ?? "",
        ...(edits.length ? { unifiedDiff: batchEditUnifiedDiff(edits) } : {}),
      };
    }
    return {
      type: "edit",
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "",
      // The native provider's `edit_file` names them `old` / `new`.
      ...((s(a.old_string) ?? s(a.old)) ? { oldString: (s(a.old_string) ?? s(a.old))! } : {}),
      ...((s(a.new_string) ?? s(a.new)) ? { newString: (s(a.new_string) ?? s(a.new))! } : {}),
      ...(s(a.unified_diff) ? { unifiedDiff: s(a.unified_diff)! } : {}),
    };
  }

  if (WRITE_NAMES.has(c)) {
    const filePath = s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "";
    const content = s(a.content);
    // A write into `.claude/plans/` is not a write: it is the PLAN.
    //
    // In `--permission-mode plan` the CLI 2.1.223 no longer exposes
    // `ExitPlanMode` (checked on the wire: 29 tools, that one absent), so the
    // model writes the plan to `~/.claude/plans/<slug>.md` instead. There the
    // plan showed up as a `Write` row into a folder nobody opens.
    if (content && isPlanFile(filePath)) return { type: "plan", text: content };
    return {
      type: "write",
      filePath,
      ...(content ? { content } : {}),
    };
  }

  // Search variants, by sub-kind so the UI can show the right count format
  // ("12 files" vs "47 matches").
  if (c === "grep") {
    const mode = s(a.output_mode);
    return {
      type: "search",
      toolName: "grep",
      query: s(a.pattern) ?? s(a.query) ?? "",
      ...(mode === "files_with_matches" || mode === "count" || mode === "content" ? { mode } : {}),
      ...(result ? { content: result } : {}),
    };
  }
  if (c === "glob") {
    return {
      type: "search",
      toolName: "glob",
      query: s(a.pattern) ?? s(a.query) ?? "",
      ...(result ? { content: result } : {}),
    };
  }
  if (SEARCH_NAMES.has(c)) {
    return {
      type: "search",
      toolName: "web_search",
      query: s(a.query) ?? s(a.q) ?? "",
      ...(result ? { content: result } : {}),
    };
  }

  // Fetch variants: Claude Code WebFetch, MCP firecrawl, etc.
  if (FETCH_NAMES.has(c)) {
    return {
      type: "fetch",
      url: s(a.url) ?? "",
      ...(s(a.prompt) ? { prompt: s(a.prompt)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  if (TODO_LIST_NAMES.has(c)) {
    if (Array.isArray(a.todos)) {
      const items = (a.todos as Array<Record<string, unknown>>).map((t) => ({
        content: s(t.content) ?? "",
        status: ((s(t.status) ?? "pending") as "pending" | "in_progress" | "completed"),
        ...(s(t.activeForm) ? { activeForm: s(t.activeForm)! } : {}),
      }));
      return { type: "todo", items };
    }
  }

  // TaskCreate / TaskUpdate: the CLI 2.1.220 added, next to `TodoWrite` (the
  // WHOLE list in one call), two tools that act on ONE task at a time. They map
  // to the same `todo` shape with a single item: the card already exists.
  //
  // But NOT always: a `TaskUpdate` carrying only `{taskId, status}` has no text
  // to show, and an item with an empty label is WORSE than the generic card. In
  // that case it falls through instead of pretending. Same for
  // `status: "deleted"`, which is not a progress state: mapping it to
  // "completed" would say something false.
  if (TODO_ITEM_NAMES.has(c)) {
    const content = s(a.subject);
    const rawStatus = s(a.status);
    const known = rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "pending";
    if (content && (rawStatus === undefined || known)) {
      return {
        type: "todo",
        items: [{
          content,
          // A task is always born `pending`: TaskCreate carries no status.
          status: (known ? rawStatus : "pending") as "pending" | "in_progress" | "completed",
          ...(s(a.activeForm) ? { activeForm: s(a.activeForm)! } : {}),
        }],
      };
    }
  }

  // Plan exit / plan tools: show the proposed plan body. `enterplanmode` has
  // no body to show, but it is the same event to a reader ("this turn is about
  // a plan"), and leaving it out made it render as a raw JSON blob.
  if (c === "exitplanmode" || c === "exit_plan_mode" || c === "enterplanmode" || c === "enter_plan_mode") {
    return { type: "plan", text: s(a.plan) ?? s(a.text) ?? "" };
  }

  // ── Agent-fleet harness tools ──────────────────────────────────────────────
  // Measured 2026-08-25 on 40 real transcripts: all of these were emitted by
  // the CLI and every one rendered as a raw JSON blob.
  if (c === "sendmessage" || c === "send_message") {
    return {
      type: "agent_message",
      to: s(a.to) ?? "",
      ...(s(a.summary) ? { summary: s(a.summary)! } : {}),
      ...(typeof a.message === "string" ? { message: a.message } : {}),
      ...(result ? { result } : {}),
    };
  }
  if (c === "listagents" || c === "list_agents") {
    return { type: "agent_control", op: "list", ...(result ? { result } : {}) };
  }
  if (c === "taskoutput" || c === "task_output") {
    return {
      type: "agent_control", op: "output",
      ...(s(a.task_id) ?? s(a.taskId) ? { target: (s(a.task_id) ?? s(a.taskId))! } : {}),
      ...(result ? { result } : {}),
    };
  }
  if (c === "taskstop" || c === "task_stop") {
    return {
      type: "agent_control", op: "stop",
      ...(s(a.task_id) ?? s(a.taskId) ?? s(a.shell_id) ? { target: (s(a.task_id) ?? s(a.taskId) ?? s(a.shell_id))! } : {}),
      ...(result ? { result } : {}),
    };
  }
  if (c === "artifact") {
    return {
      type: "artifact",
      action: s(a.action) ?? "publish",
      ...(s(a.title) ? { title: s(a.title)! } : {}),
      ...(s(a.url) ? { url: s(a.url)! } : {}),
      ...(s(a.file_path) ?? s(a.filePath) ? { filePath: (s(a.file_path) ?? s(a.filePath))! } : {}),
      ...(result ? { result } : {}),
    };
  }
  // The question an agent puts TO the human, under every name it travels with:
  // the CLI's own `AskUserQuestion`, the bare `ask_user_question`, and the MCP
  // re-export `mcp__topics__ask_user_question`. The suffix match runs BEFORE
  // the generic `mcp__` branch below, otherwise the one tool whose whole point
  // is to be read renders as an anonymous MCP row. Same name set as
  // `server/providers/ask-user-detector.ts`, which decides whether the turn is
  // waiting on a human: the row and the wait agree on what a question is.
  if (c === "askuserquestion" || c === "ask_user_question" || c.endsWith("__ask_user_question")) {
    const qs = Array.isArray(a.questions) ? (a.questions as Array<Record<string, unknown>>) : [];
    return {
      type: "ask_user",
      questions: qs.map((q) => ({
        question: s(q.question) ?? "",
        ...(s(q.header) ? { header: s(q.header)! } : {}),
        ...(Array.isArray(q.options)
          ? { options: (q.options as Array<Record<string, unknown>>).map((o) => s(o?.label) ?? String(o)) }
          : {}),
      })),
      ...(result ? { result } : {}),
    };
  }
  // ToolSearch IS a search - a query that returns tools - so it reuses the
  // search row instead of inventing a category for it.
  if (c === "toolsearch" || c === "tool_search") {
    return { type: "search", query: s(a.query) ?? "", toolName: "tool_search", ...(result ? { content: result } : {}) };
  }

  // Sub-agent (Task tool). The actions[] is filled in by the SidechainTracker
  // via onSubAgentUpdate; here we just seed the metadata so the parent row
  // shows description/subAgentType while the sub-agent runs. `agent` is the
  // SAME tool under its current name (measured 2026-08-25: `Agent` emitted 58
  // times, every one a generic JSON blob while `Task` rendered properly).
  if (c === "task" || c === "agent") {
    return {
      type: "sub_agent",
      ...(s(a.subagent_type) ? { subAgentType: s(a.subagent_type)! } : {}),
      ...(s(a.description) ? { description: s(a.description)! } : {}),
      actions: [],
      ...(result ? { result } : {}),
    };
  }

  // Topics' own `spawn_agent`, bare (native runtime) or `mcp__topics__`: the
  // sub-agent card, as `Agent` has, not the generic MCP one (SUBAGENT-16). The
  // answer names the agentId and the model that really started.
  if (c === "spawn_agent" || c.endsWith("__spawn_agent")) {
    const agentId = result?.match(/agentId=([0-9a-f-]{36})/)?.[1];
    // `model=default (why)` is the route's note that no `--model` went out:
    // the child runs on the CLI default, which is not a model called "default".
    const modelField = result?.match(/ · model=([^\s·]+)( \()?/);
    const startedModel = modelField && !modelField[2] ? modelField[1] : undefined;
    const prompt = s(a.prompt);
    return {
      type: "sub_agent",
      via: "spawn_agent",
      ...(s(a.agent_type) ? { subAgentType: s(a.agent_type)! } : {}),
      ...(prompt ? { description: prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt } : {}),
      ...(s(a.name) ? { name: s(a.name)! } : {}),
      ...(!modelField?.[2] && (startedModel ?? s(a.model)) ? { model: (startedModel ?? s(a.model))! } : {}),
      ...(agentId ? { agentId } : {}),
      actions: [],
      ...(result ? { result } : {}),
    };
  }

  // Monitor: long-lived event watcher (Bash/ws stream). The `description` is
  // shown in every notification; a `command` or `ws.url` names the source.
  if (c === "monitor") {
    const ws = asRecord(a.ws);
    return {
      type: "monitor",
      description: s(a.description) ?? "",
      ...(s(a.command) ? { command: s(a.command)! } : {}),
      ...(s(ws.url) ? { wsUrl: s(ws.url)! } : {}),
      ...(a.persistent === true ? { persistent: true } : {}),
      ...(result ? { result } : {}),
    };
  }

  // Background-shell lifecycle tools.
  if (c === "bashoutput" || c === "bash_output") {
    return {
      type: "bash_output",
      shellId: s(a.bash_id) ?? s(a.shell_id) ?? s(a.id) ?? "",
      ...(s(a.filter) ? { filter: s(a.filter)! } : {}),
      ...(result ? { output: result } : {}),
    };
  }
  if (c === "killshell" || c === "killbash" || c === "kill_shell" || c === "kill_bash") {
    return {
      type: "kill_shell",
      shellId: s(a.shell_id) ?? s(a.bash_id) ?? s(a.id) ?? "",
      ...(result ? { result } : {}),
    };
  }

  // Notebook editing.
  if (c === "notebookedit" || c === "notebook_edit") {
    return {
      type: "notebook_edit",
      notebookPath: s(a.notebook_path) ?? s(a.notebookPath) ?? s(a.path) ?? "",
      ...(s(a.cell_id) ? { cellId: s(a.cell_id)! } : {}),
      ...(s(a.edit_mode) ? { editMode: s(a.edit_mode)! } : {}),
      ...(s(a.cell_type) ? { cellType: s(a.cell_type)! } : {}),
    };
  }

  // Skill invocation (`/<name>` or the Skill tool).
  if (c === "skill") {
    return {
      type: "skill",
      skill: s(a.skill) ?? s(a.name) ?? "",
      ...(s(a.args) ? { args: s(a.args)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  // Slash command dispatched to the CLI.
  if (c === "slashcommand" || c === "slash_command") {
    return {
      type: "slash_command",
      command: s(a.command) ?? s(a.slash) ?? "",
      ...(result ? { result } : {}),
    };
  }

  // LSP code-intelligence lookups.
  if (c === "lsp") {
    const filePath = s(a.filePath) ?? s(a.file_path);
    return {
      type: "lsp",
      operation: s(a.operation) ?? "",
      ...(filePath ? { filePath } : {}),
      ...(s(a.query) ? { symbol: s(a.query)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  // The WAIT on a process (`wait_for_process`). Not just any MCP: it carries a
  // processId, the one thing that lets the card stay LIVE while the row is
  // open. Caught before the `mcp__` branch.
  if (c === "wait_for_process" || c.endsWith("__wait_for_process")) {
    const timeout = typeof a.timeout_ms === "number" ? a.timeout_ms : undefined;
    return {
      type: "wait",
      processId: s(a.process_id) ?? s(a.processId) ?? "",
      ...(s(a.until) ? { until: s(a.until)! } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      ...(result ? { result } : {}),
    };
  }

  // The native provider calls the Topics bridge tools in-process under their
  // BARE names (`update_task`, `read_agent`), without the `mcp__topics__`
  // prefix the CLI adds. Same tools, same card: without this they all fell to
  // the generic JSON view (about 4,000 calls in two weeks, measured 23/09).
  if (TOPICS_BRIDGE_TOOLS.has(c) || TOPICS_BROWSER_TOOLS.has(c)) {
    return {
      type: "mcp",
      server: TOPICS_BROWSER_TOOLS.has(c) ? "browser" : "topics",
      tool: name,
      ...(args ? { args: a } : {}),
      ...(result ? { result } : {}),
    };
  }

  // MCP namespaced tool. Names look like `mcp__<server>__<tool>`. Strip the
  // namespace so the renderer can show "<server> · <tool>" with a chip-style
  // label instead of the full name.
  if (c.startsWith("mcp__")) {
    const parts = name.split("__");
    return {
      type: "mcp",
      server: parts[1] ?? "mcp",
      tool: parts.slice(2).join("__") || name,
      ...(args ? { args: a } : {}),
      ...(result ? { result } : {}),
    };
  }

  // Fallback: unknown kind, render generic.
  return {
    type: "unknown",
    raw: {
      ...(args ? { args: a } : {}),
      ...(result ? { result } : {}),
    },
  };
}

/**
 * Convenience: derive detail from a ToolCall, merging args + result. Used by
 * code that already has a ToolCall in hand and wants to attach `detail` to it.
 */
export function deriveToolDetailFromCall(tc: ToolCall): ToolCallDetail {
  return deriveToolDetail(tc.name, tc.args, tc.result);
}
