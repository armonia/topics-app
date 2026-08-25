/**
 * Tool detail normalizer.
 *
 * Translates a raw tool name + args (as emitted by the Claude Code CLI, the
 * Codex CLI, the OpenClaw gateway, etc.) into the typed `ToolCallDetail`
 * union the renderer branches on. Done at the provider boundary so:
 *   1. The wire format the client sees is uniform across providers.
 *   2. Tool-name aliases (`Bash` / `bash` / `shell` / `exec_command`) collapse
 *      into one `detail.type === "shell"` shape.
 *   3. The renderer doesn't have to JSON-grovel `args` for every tool kind.
 *
 * The mapping is intentionally permissive: when a tool name doesn't match a
 * known kind we return `{ type: "unknown", raw: { args, result? } }` so the
 * renderer falls back to a generic JSON view instead of dropping the call.
 *
 * Mirrored (read-only) on the client at
 * `client/src/components/Chat/toolDetail.ts` for legacy messages whose
 * `detail` was never built server-side. Keep the mapping in sync.
 */

import type { ToolCall, ToolCallDetail } from "../../types";
import { isPlanFile } from "../../../shared/plan-file";

/** Lowercase + strip leading/trailing punctuation for alias match. */
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

/**
 * Build a `ToolCallDetail` from a tool name + args. Result string optional —
 * caller passes it on tool_result events to enrich `output`/`content`/`result`
 * fields per detail kind.
 */
export function deriveToolDetail(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: string,
): ToolCallDetail {
  const c = canon(name);
  const a = asRecord(args);

  // Shell variants — Claude Code, Codex, MCP shell tools.
  if (
    c === "bash" ||
    c === "shell" ||
    c === "exec_command" ||
    c === "run_command" ||
    c === "terminal" ||
    c === "exec"
  ) {
    return {
      type: "shell",
      command: s(a.command) ?? s(a.cmd) ?? s(a.input) ?? "",
      ...(s(a.cwd) ? { cwd: s(a.cwd)! } : {}),
      ...(a.run_in_background === true ? { background: true } : {}),
      ...(result ? { output: result } : {}),
    };
  }

  // Read variants
  if (c === "read" || c === "read_file" || c === "view_file" || c === "view") {
    return {
      type: "read",
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "",
      ...(result ? { content: result } : {}),
      ...(n(a.offset) != null ? { offset: n(a.offset)! } : {}),
      ...(n(a.limit) != null ? { limit: n(a.limit)! } : {}),
    };
  }

  // Edit variants — single Edit, MultiEdit (concat), apply_patch, str_replace
  if (
    c === "edit" ||
    c === "multiedit" ||
    c === "apply_patch" ||
    c === "apply_diff" ||
    c === "str_replace_editor" ||
    c === "str_replace"
  ) {
    // MultiEdit packs an `edits` array — render the first edit's old/new and
    // count the remainder via the diff field which the renderer can show.
    if (c === "multiedit" && Array.isArray(a.edits)) {
      const edits = a.edits as Array<Record<string, unknown>>;
      const first = edits[0] ?? {};
      const tail = edits.length > 1 ? `\n… and ${edits.length - 1} more edit(s)` : "";
      return {
        type: "edit",
        filePath: s(a.file_path) ?? s(a.filePath) ?? "",
        ...(s(first.old_string) ? { oldString: (s(first.old_string) ?? "") + tail } : {}),
        ...(s(first.new_string) ? { newString: (s(first.new_string) ?? "") + tail } : {}),
      };
    }
    return {
      type: "edit",
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "",
      ...(s(a.old_string) ? { oldString: s(a.old_string)! } : {}),
      ...(s(a.new_string) ? { newString: s(a.new_string)! } : {}),
      ...(s(a.unified_diff) ? { unifiedDiff: s(a.unified_diff)! } : {}),
    };
  }

  // Write variants
  if (c === "write" || c === "write_file" || c === "create_file") {
    const filePath = s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? "";
    const content = s(a.content);
    // Una scrittura in `.claude/plans/` NON è una scrittura: è il PIANO.
    //
    // In `--permission-mode plan` la CLI 2.1.223 non espone più `ExitPlanMode`
    // (provato sul wire: 29 tool, e quello non c'è), quindi il modello non ha
    // più un modo di consegnare il piano — e ripiega su quello che gli resta,
    // cioè scriverlo in `~/.claude/plans/<slug>.md`. Lì dentro il piano
    // compariva come una riga `Write` verso una cartella che nessuno apre: il
    // lavoro c'era tutto e a schermo non si vedeva.
    if (content && isPlanFile(filePath)) {
      return { type: "plan", text: content };
    }
    return {
      type: "write",
      filePath,
      ...(content ? { content } : {}),
    };
  }

  // Search variants — distinguish by sub-kind so the UI can show the right
  // count format ("12 files" vs "47 matches").
  if (c === "grep") {
    return {
      type: "search",
      toolName: "grep",
      query: s(a.pattern) ?? s(a.query) ?? "",
      ...(s(a.output_mode) === "files_with_matches" ? { mode: "files_with_matches" } : {}),
      ...(s(a.output_mode) === "count" ? { mode: "count" } : {}),
      ...(s(a.output_mode) === "content" ? { mode: "content" } : {}),
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
  if (c === "search" || c === "websearch" || c === "web_search") {
    return {
      type: "search",
      toolName: "web_search",
      query: s(a.query) ?? s(a.q) ?? "",
      ...(result ? { content: result } : {}),
    };
  }

  // Fetch variants — Claude Code WebFetch, MCP firecrawl, etc.
  if (c === "webfetch" || c === "web_fetch" || c === "fetch") {
    return {
      type: "fetch",
      url: s(a.url) ?? "",
      ...(s(a.prompt) ? { prompt: s(a.prompt)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  // Todo
  if (c === "todowrite" || c === "todo_write") {
    if (Array.isArray(a.todos)) {
      const items = (a.todos as Array<Record<string, unknown>>).map((t) => ({
        content: s(t.content) ?? "",
        status: ((s(t.status) ?? "pending") as "pending" | "in_progress" | "completed"),
        ...(s(t.activeForm) ? { activeForm: s(t.activeForm)! } : {}),
      }));
      return { type: "todo", items };
    }
  }

  // TaskCreate / TaskUpdate — la CLI 2.1.220 ha affiancato al vecchio
  // `TodoWrite` (che portava l'INTERA lista) due tool che agiscono su UN task
  // per volta. Senza questi case la todo non veniva riconosciuta qui, al
  // confine dello stream, e arrivava al client come tool generico: JSON grezzo
  // a schermo al posto della TodoCard.
  //
  // Stessa forma `todo` con una voce sola — la card esiste già.
  //
  // Ma NON sempre: una `TaskUpdate` che porta solo `{taskId, status}` non ha un
  // testo da mostrare, e una voce con etichetta vuota è PEGGIO del tool
  // generico. In quel caso si lascia passare invece di fingere. Stessa scelta
  // per `status: "deleted"`, che non è uno stato di avanzamento: mapparlo su
  // "completed" direbbe una cosa falsa.
  if (c === "taskcreate" || c === "task_create" || c === "taskupdate" || c === "task_update") {
    const content = s(a.subject);
    const rawStatus = s(a.status);
    const known = rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "pending";
    if (content && (rawStatus === undefined || known)) {
      return {
        type: "todo",
        items: [{
          content,
          // Un task nasce sempre `pending`: TaskCreate non porta uno status.
          status: (known ? rawStatus : "pending") as "pending" | "in_progress" | "completed",
          ...(s(a.activeForm) ? { activeForm: s(a.activeForm)! } : {}),
        }],
      };
    }
  }

  // Plan exit / plan tools — show the proposed plan body. `enterplanmode` has
  // no body to show, but it is the same event to a reader ("this turn is about
  // a plan"), and leaving it out made it render as a raw JSON blob.
  if (c === "exitplanmode" || c === "exit_plan_mode" || c === "enterplanmode" || c === "enter_plan_mode") {
    return { type: "plan", text: s(a.plan) ?? s(a.text) ?? "" };
  }

  // Sub-agent (Task tool). The actions[] is filled in by the SidechainTracker
  // via onSubAgentUpdate; here we just seed the metadata so the parent row
  // shows description/subAgentType while the sub-agent runs.
  //
  // `agent` is the SAME tool under its current name. Measured 2026-08-25 on the
  // real transcripts of this machine: `Agent` was emitted 58 times and every
  // one of them rendered as a generic JSON blob, while `Task` - the older name
  // for the identical call - rendered properly. Two names for one operation,
  // one of them invisible.
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
  if (c === "askuserquestion" || c === "ask_user_question") {
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

  if (c === "task" || c === "agent") {
    return {
      type: "sub_agent",
      ...(s(a.subagent_type) ? { subAgentType: s(a.subagent_type)! } : {}),
      ...(s(a.description) ? { description: s(a.description)! } : {}),
      actions: [],
      ...(result ? { result } : {}),
    };
  }

  // Monitor — long-lived event watcher (Bash/ws stream). The `description` is
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

  // L'ATTESA di un processo (`wait_for_process`). Non e' un MCP qualunque: ha un
  // processId, cioe' l'unica cosa che permette alla card di restare VIVA mentre
  // la riga e' aperta — il difetto che la card `monitor` qui sopra dichiara di
  // non poter risolvere. Si intercetta prima del ramo `mcp__`.
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

  // MCP namespaced tool. Names look like `mcp__<server>__<tool>`. Strip the
  // namespace so the renderer can show "<server> · <tool>" with a chip-style
  // label instead of the full ugly name.
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

  // Fallback — unknown kind, render generic.
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
 * provider/route code that already has a ToolCall in hand and wants to attach
 * `detail` to it before broadcasting.
 */
export function deriveToolDetailFromCall(tc: ToolCall): ToolCallDetail {
  return deriveToolDetail(tc.name, tc.args, tc.result);
}
