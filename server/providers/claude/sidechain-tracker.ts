/**
 * Sub-agent (Task tool) sidechain tracker.
 *
 * When the Claude Code CLI spawns a sub-agent via the Task() tool, its
 * intermediate events (text, tool_use, tool_result) arrive on the SAME
 * stream as the parent agent but with a `parent_tool_use_id` field marking
 * them as sidechain. Without special handling, these events would either:
 *   - get attributed to the parent agent (wrong: "ls" called by sub-agent
 *     looks like the parent ran ls), OR
 *   - get dropped (current topics-app behavior — entire sub-agent run
 *     invisible behind a single Task() row showing JSON args).
 *
 * Pattern stolen from Paseo's `ClaudeSidechainTracker`: rather than create a
 * nested timeline (heavy UI cost), flatten each sub-agent invocation into a
 * `detail.sub_agent.actions[]` log on the parent Task call. Each child
 * emission becomes one row `[ToolName] summary`, and the parent's `tool_call`
 * is re-broadcast with growing `actions[]`. The renderer collapses successive
 * updates by `callId` (= parent tool_use_id) and shows a single expandable
 * card per sub-agent invocation.
 *
 * Limits: 200 actions, 160 chars per summary (matches Paseo). Above that we
 * truncate; sub-agents that explode shouldn't blow up the UI.
 */

const MAX_ACTIONS = 200;
const MAX_SUMMARY_CHARS = 160;

export interface SidechainAction {
  index: number;
  toolName: string;
  summary?: string;
  status?: "running" | "success" | "error";
}

export interface SidechainState {
  /** Tool id of the parent Task() call that spawned this sidechain. */
  parentToolUseId: string;
  /** Optional `subagent_type` the parent passed to Task(). Set on first event. */
  subAgentType?: string;
  /** Optional `description` from the parent Task() input. */
  description?: string;
  /** Growing list of activity records. Capped at MAX_ACTIONS. */
  actions: SidechainAction[];
  /** Concatenated assistant text from the sub-agent. Used for the final result body. */
  fullText: string;
  /** True once a `result` event arrives for the parent Task() call. */
  finished: boolean;
}

export class SidechainTracker {
  private states = new Map<string, SidechainState>();
  /** Map child tool_use id → parent tool_use id, so child tool_results route. */
  private childToParent = new Map<string, string>();
  /** Map child tool_use id → action index inside its parent's actions[]. */
  private childToActionIdx = new Map<string, number>();

  /**
   * Register a Task() invocation. Called from the main provider when it sees
   * a parent tool_use named "Task". After this call, sub-agent events tagged
   * with `parent_tool_use_id === toolUseId` will be tracked.
   */
  registerParent(toolUseId: string, input: unknown): void {
    if (this.states.has(toolUseId)) return;
    let subAgentType: string | undefined;
    let description: string | undefined;
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (typeof obj.subagent_type === "string") subAgentType = obj.subagent_type;
      if (typeof obj.description === "string") description = obj.description;
    }
    this.states.set(toolUseId, {
      parentToolUseId: toolUseId,
      subAgentType,
      description,
      actions: [],
      fullText: "",
      finished: false,
    });
  }

  /**
   * Returns true if the given tool_use id is a known Task() parent tracked by
   * this sidechain. Used by the provider to decide whether to route events.
   */
  has(toolUseId: string): boolean {
    return this.states.has(toolUseId);
  }

  /**
   * Get the current state for emitting a parent tool_call snapshot. Returns
   * a fresh shallow copy so the caller can mutate without racing the tracker.
   */
  snapshot(toolUseId: string): SidechainState | null {
    const s = this.states.get(toolUseId);
    if (!s) return null;
    return {
      ...s,
      actions: s.actions.map((a) => ({ ...a })),
    };
  }

  /**
   * Record a child assistant TEXT block (the sub-agent talking).
   * Returns the parent id if tracked, else null.
   */
  recordChildText(parentToolUseId: string, text: string): string | null {
    const state = this.states.get(parentToolUseId);
    if (!state) return null;
    state.fullText += text;
    this.appendAction(state, "text", truncate(text));
    return parentToolUseId;
  }

  /**
   * Record a child TOOL_USE block (the sub-agent calling a tool itself).
   * The summary is built from the tool's input — Bash → command, Read →
   * filePath, etc. — so the parent's log shows e.g. `[Read] src/foo.ts`.
   */
  recordChildToolUse(
    parentToolUseId: string,
    childToolUseId: string,
    toolName: string,
    input: unknown,
  ): string | null {
    const state = this.states.get(parentToolUseId);
    if (!state) return null;
    const summary = summarizeToolInput(toolName, input);
    const idx = this.appendAction(state, toolName, summary, "running");
    this.childToParent.set(childToolUseId, parentToolUseId);
    this.childToActionIdx.set(childToolUseId, idx);
    return parentToolUseId;
  }

  /**
   * Record a child TOOL_RESULT block. Patches the matching action to
   * 'success' or 'error' and optionally appends short result text to its
   * summary so the user sees what came back.
   */
  recordChildToolResult(
    childToolUseId: string,
    result: string,
    isError: boolean,
  ): string | null {
    const parentId = this.childToParent.get(childToolUseId);
    if (!parentId) return null;
    const state = this.states.get(parentId);
    if (!state) return null;
    const idx = this.childToActionIdx.get(childToolUseId);
    if (idx == null || !state.actions[idx]) {
      this.childToParent.delete(childToolUseId);
      this.childToActionIdx.delete(childToolUseId);
      return parentId;
    }
    const action = state.actions[idx];
    action.status = isError ? "error" : "success";
    // Append the first line of the result to the summary so the row shows
    // something useful like `[Bash] ls → 12 files`. Skip if already long.
    if (action.summary && action.summary.length < MAX_SUMMARY_CHARS - 8 && result) {
      const first = result.split("\n")[0]?.trim() ?? "";
      if (first) action.summary = truncate(`${action.summary} → ${first}`);
    }
    this.childToParent.delete(childToolUseId);
    this.childToActionIdx.delete(childToolUseId);
    return parentId;
  }

  /**
   * Mark the parent Task() call as finished. After this the tracker keeps
   * the state available for one more snapshot then drops it.
   */
  finish(parentToolUseId: string, finalResult: string): SidechainState | null {
    const state = this.states.get(parentToolUseId);
    if (!state) return null;
    state.finished = true;
    if (finalResult && !state.fullText) state.fullText = finalResult;
    return this.snapshot(parentToolUseId);
  }

  delete(parentToolUseId: string): void {
    this.states.delete(parentToolUseId);
    // Clean up any orphaned child-tracking refs.
    for (const [child, parent] of this.childToParent) {
      if (parent === parentToolUseId) {
        this.childToParent.delete(child);
        this.childToActionIdx.delete(child);
      }
    }
  }

  clear(): void {
    this.states.clear();
    this.childToParent.clear();
    this.childToActionIdx.clear();
  }

  private appendAction(
    state: SidechainState,
    toolName: string,
    summary?: string,
    status?: SidechainAction["status"],
  ): number {
    if (state.actions.length >= MAX_ACTIONS) {
      // Once at the cap we drop the oldest non-terminal entry to keep
      // the most recent activity visible. If everything is terminal we
      // just stop appending — the user has more than enough to see.
      const firstRunningIdx = state.actions.findIndex((a) => a.status === "running");
      if (firstRunningIdx >= 0) {
        state.actions.splice(firstRunningIdx, 1);
      } else {
        return state.actions.length - 1;
      }
    }
    const action: SidechainAction = { index: state.actions.length, toolName };
    if (summary) action.summary = summary;
    if (status) action.status = status;
    state.actions.push(action);
    return action.index;
  }
}

function truncate(s: string): string {
  if (!s) return "";
  if (s.length <= MAX_SUMMARY_CHARS) return s;
  return s.slice(0, MAX_SUMMARY_CHARS - 1) + "…";
}

/**
 * Tiny inline summarizer — picks the most informative scalar from the tool
 * input for log display. NOT the full detail mapper (that lives in
 * `tool-call-detail.ts`); this one just handles the common Claude tool names
 * to keep the sub-agent log readable.
 */
function summarizeToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const name = toolName.toLowerCase();
  // Bash / shell variants
  if (typeof obj.command === "string") return truncate(obj.command);
  // Read / Edit / Write
  if (typeof obj.file_path === "string") return truncate(obj.file_path);
  if (typeof obj.filePath === "string") return truncate(obj.filePath);
  if (typeof obj.path === "string") return truncate(obj.path);
  // Grep / Glob / WebSearch
  if (typeof obj.pattern === "string") return truncate(obj.pattern);
  if (typeof obj.query === "string") return truncate(obj.query);
  // WebFetch
  if (typeof obj.url === "string") return truncate(obj.url);
  // Task description
  if (typeof obj.description === "string") return truncate(obj.description);
  if (typeof obj.prompt === "string") return truncate(obj.prompt);
  // TodoWrite
  if (Array.isArray(obj.todos)) return `${obj.todos.length} item(s)`;
  // Fallback: first string field we find
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 0) return truncate(`${k}=${v}`);
  }
  // Generic name marker
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return `${parts[1] ?? "mcp"}/${parts[2] ?? toolName}`;
  }
  return undefined;
}
