#!/usr/bin/env bun
/**
 * Topics-app MCP server — bridge between Claude Code CLI (and any other
 * MCP-aware tool host) and the topics-app HTTP surface.
 *
 * Spawned by the claude-code provider as a subprocess via `--mcp-config`.
 * Exposes one tool: `open_browser_pane(url)` — surfaces the URL in the
 * user-facing topics-app browser pane (the same UX the legacy
 * `{{BROWSER:url}}` marker triggers, but deterministic and tool-shaped).
 *
 * Wire protocol: JSON-RPC 2.0 over stdio (one JSON message per stdin line,
 * one JSON message per stdout line). Implements the minimal MCP subset the
 * Claude Code CLI exercises: initialize, tools/list, tools/call.
 *
 * argv contract:
 *   --base-url=http://localhost:3333     (required) topics-app server origin
 *   --session-key=<key>                  (required) sessionKey of the spawning
 *                                        claude-code process; topics-app resolves
 *                                        it to the target topic
 *   --topics-home=<dir>                  (optional) Topics home of the server; its
 *                                        daemon-state.json token goes out as
 *                                        X-Daemon-Token. Default: TOPICS_HOME or ~/.topics
 *
 * No external deps — keeps the spawn cold-start under 50ms.
 */
import { createInterface } from "readline";
import { BRIDGED_BROWSER_ENDPOINTS } from "../browser-tool-spec";
import { callGoogleCall, callSendMail } from "./outbound-tools";
import { callRunCommand } from "./command-tools";
import { answerResourceMethod, callShowView, showViewCallResult } from "./view-tools";
import { topicsHome } from "../services/daemon-state";
import type { ParsedArgs } from "./topics-http";
import { type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, error, progressNotification, progressTokenOf, send } from "./jsonrpc";
import { isToolAllowedForProfile, toolsForProfile } from "./tool-definitions";
import { callBrowserBridge, callCloseBrowserPane, callFocusBrowserTab, callImportChrome, callListBrowserTabs, callOpenBrowserPane } from "./browser-calls";
import { callCloseGoal, callGetGoal, callMoveToProject, callRunScript, callSetGoal, callUpdateGoalSteps } from "./goal-calls";
import { callCreateProject, callListAgents, callNewTopic, callOpenProject, callReadAgent, callSendToAgent, callSpawnAgent, callStopAgent, callSwitchTopic } from "./agent-calls";
import { callReadChatMessages, callSendChatMessage } from "./chat-calls";
import { callCommentGlobalTask, callCommentTask, callCreateGlobalTask, callCreateTask, callGetGlobalTask, callGetTask, callLabelTask, callListGlobalTasks, callListProcesses, callListTasks, callReadProcessOutput, callResolveTab, callStopProcess, callUpdateGlobalTask, callUpdateTask, callWaitForCondition, callWaitForProcess } from "./task-calls";
import { callApprovalPrompt, callAskUserQuestion } from "./ask-calls";
export { isToolAllowedForProfile, toolsForProfile } from "./tool-definitions";
export { ASK_LEG_MS, ASK_MAX_LEGS, ASK_TRANSPORT_GRACE_MS, PERMISSION_ECHO_MAX_BYTES, PERMISSION_MAX_LEGS, callApprovalPrompt, callAskUserQuestion } from "./ask-calls";
export { RESTART_NOTICE_OPENING, callReadChatMessages, callSendChatMessage } from "./chat-calls";
export { callCreateProject, callListAgents, callNewTopic, callOpenProject, callReadAgent, callSendToAgent, callSpawnAgent, callStopAgent, callSwitchTopic } from "./agent-calls";
export { callBrowserBridge, callFocusBrowserTab, callListBrowserTabs, callOpenBrowserPane } from "./browser-calls";
export { callCloseGoal, callGetGoal, callMoveToProject, callRunScript, callSetGoal, callUpdateGoalSteps } from "./goal-calls";
export { CHECKS_MAX_LEGS, callCommentTask, callCreateTask, callGetTask, callListProcesses, callListTasks, callReadProcessOutput, callResolveTab, callStopProcess, callUpdateGlobalTask, callUpdateTask, callWaitForCondition, callWaitForProcess } from "./task-calls";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export type { ParsedArgs } from "./topics-http";
export function parseArgs(argv: string[]): ParsedArgs {
  const map: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) map[m[1]] = m[2];
  }
  const baseUrl = map["base-url"];
  const sessionKey = map["session-key"];
  if (!baseUrl) throw new Error("topics-mcp-server: --base-url is required");
  if (!sessionKey) throw new Error("topics-mcp-server: --session-key is required");
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    sessionKey,
    topicsHome: map["topics-home"],
    profile: map["profile"],
  };
}

/**
 * Tool dispatch registry. Each handler returns the human-readable text that
 * becomes the tool result's `content[0].text`. Adding a tool = one entry here
 * + one entry in TOOLS, nothing else.
 *
 * Handlers always use the global `fetch` in production: `handleMessage` never
 * threads a fetchImpl through `tools/call` (tests patch `globalThis.fetch`
 * instead). The underlying call* functions still take an explicit fetchImpl
 * for direct unit testing — the registry just relies on their default.
 */
/**
 * I mestieri di Topics, per nome.
 *
 * Esportata perché il RUNTIME NATIVO la usa in-process: quel runtime non
 * spawna questo file come processo MCP (è tutto il suo punto), ma i tool sono
 * gli stessi e riscriverli sarebbe due implementazioni che divergono al primo
 * bugfix. Vedi `providers/native/topics-tools.ts`.
 */
export const TOOL_HANDLERS: Record<
  string,
  (args: ParsedArgs, toolArgs: Record<string, unknown>, ctx?: ToolCallContext) => Promise<string>
> = {
  open_browser_pane: async (a, t) => {
    const r = await callOpenBrowserPane(a, t as { url?: unknown; name?: unknown });
    const where = `${r.url}` + (r.title ? ` (title: ${r.title})` : "");
    // I due esiti DEVONO leggersi diversi. Finché il messaggio era lo stesso,
    // «pane aperta» e «contesto vivo che nessuno vede» erano indistinguibili da
    // fuori: né l'agente né l'umano potevano accorgersi del guasto.
    const outcome = r.visible
      ? `Opened browser pane at ${where}`
      : `Browser context ready at ${where} — but NO visible pane is mounted (no Topics window took it). The page is loaded and drivable with browser_*; call browser_focus_tab to surface it, or tell the user it is not on screen.`;
    // The context goes LAST, so every reader of the prefix (pane-nav-outcome,
    // the agents themselves) keeps reading what it always read. The chat
    // marker parses it back out (`shared/tool-detail.ts`).
    const body = r.contextId ? `${outcome} [contextId: ${r.contextId}]` : outcome;
    // The port/project warning (task f9cf765e) LEADS the result: it is the one
    // line an agent skimming "Opened browser pane at ..." must not be able to
    // miss, so it is not appended at the end where a long result truncates it.
    return r.warning ? `${r.warning}\n${body}` : body;
  },
  close_browser_pane: (a, t) => callCloseBrowserPane(a, t as { contextId?: unknown }),
  browser_list_tabs: (a, t) => callListBrowserTabs(a, t),
  browser_focus_tab: (a, t) => callFocusBrowserTab(a, t as { contextId?: unknown }),
  import_chrome: (a, t) => callImportChrome(a, t as { domains?: unknown; profile?: unknown; dry_run?: unknown; browser?: unknown }),
  run_script: (a, t) => callRunScript(a, t),
  run_command: (a, t) => callRunCommand(a, t),
  list_processes: (a, t) => callListProcesses(a, t),
  read_process_output: (a, t) => callReadProcessOutput(a, t),
  wait_for_process: (a, t) => callWaitForProcess(a, t),
  stop_process: (a, t) => callStopProcess(a, t),
  list_tasks: (a, t) => callListTasks(a, t),
  create_task: (a, t) => callCreateTask(a, t),
  get_task: (a, t) => callGetTask(a, t),
  list_global_tasks: (a, t) => callListGlobalTasks(a, t),
  get_global_task: (a, t) => callGetGlobalTask(a, t),
  create_global_task: (a, t) => callCreateGlobalTask(a, t),
  update_global_task: (a, t, ctx) =>
    callUpdateGlobalTask(a, t, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "i check pre-review stanno girando")
        : undefined,
    }),
  comment_global_task: (a, t) => callCommentGlobalTask(a, t),
  get_goal: (a) => callGetGoal(a),
  close_goal: (a, t) => callCloseGoal(a, t as { status?: unknown; summary?: unknown }),
  set_goal: (a, t) => callSetGoal(a, t as { content?: unknown }),
  update_goal_steps: (a, t) => callUpdateGoalSteps(a, t as { steps?: unknown }),
  // `onProgress` come per le domande all'umano, e per lo stesso motivo: una
  // consegna fa girare i check pre-review, che durano minuti, e un client MCP
  // che non sente niente dichiara piantata la chiamata.
  update_task: (a, t, ctx) =>
    callUpdateTask(a, t, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "i check pre-review stanno girando")
        : undefined,
    }),
  comment_task: (a, t) => callCommentTask(a, t),
  label_task: (a, t) => callLabelTask(a, t),
  send_mail: (a, t, ctx) =>
    callSendMail(a, t, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "in attesa della conferma dell'umano")
        : undefined,
    }),
  google_call: (a, t, ctx) =>
    callGoogleCall(a, t, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "in attesa della conferma dell'umano")
        : undefined,
    }),
  ask_user_question: (a, t, ctx) =>
    callAskUserQuestion(a, t as { questions?: unknown }, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "in attesa della risposta dell'umano")
        : undefined,
    }),
  // Il canale di permesso: stesso trattamento del pannello delle domande —
  // `onProgress` a ogni gamba, perché è ciò che impedisce al client MCP di
  // dichiarare piantata una chiamata sotto la quale c'è solo una persona che
  // sta ancora leggendo.
  approval_prompt: (a, t, ctx) =>
    callApprovalPrompt(a, t as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown }, fetch, {
      onProgress: ctx?.onProgress
        ? (leg) => ctx.onProgress?.(leg, "in attesa del permesso dell'umano")
        : undefined,
    }),
  wait_for_condition: (a, t) => callWaitForCondition(a, t),
  move_session_to_project: (a, t) => callMoveToProject(a, t as { project_path?: unknown }),
  // `onProgress` for the foreground wait: a beat per empty leg (SUBAGENT-13).
  spawn_agent: (a, t, ctx) =>
    callSpawnAgent(a, t, fetch, {
      onProgress: ctx?.onProgress ? (leg) => ctx.onProgress?.(leg, "the sub-agent is working") : undefined,
    }),
  send_to_agent: (a, t) => callSendToAgent(a, t as { agent_id?: unknown; input?: unknown }),
  read_agent: (a, t) => callReadAgent(a, t as { agent_id?: unknown; since?: unknown }),
  list_agents: (a, t) => callListAgents(a, t),
  stop_agent: (a, t) => callStopAgent(a, t as { agent_id?: unknown }),
  switch_topic: (a, t) => callSwitchTopic(a, t as { topic_id?: unknown }),
  new_topic: (a, t) => callNewTopic(a, t as { title?: unknown }),
  send_chat_message: (a, t) => callSendChatMessage(a, t as { topic_id?: unknown; message?: unknown }),
  read_chat_messages: (a, t) => callReadChatMessages(a, t as { topic_id?: unknown; limit?: unknown }),
  create_project: (a, t) => callCreateProject(a, t as { name?: unknown }),
  open_project: (a, t) => callOpenProject(a, t as { ref?: unknown }),
  // Volutamente FUORI da DISPATCH_EXCLUDED_TOOLS: anche un agente di board
  // riceve link incollati dall'umano nel thread del task.
  resolve_tab: (a, t) => callResolveTab(a, t as { ref?: unknown }),
  show_view: (a, t) => callShowView(a, t as Record<string, unknown>),
};

// Register the ref-based browser tools (observe/act/extract/get_text/screenshot/
// eval/…) generically from the single source of truth, so adding a browser tool
// = one entry in browser-tool-spec.ts (no edit here).
for (const [endpoint, toolName] of Object.entries(BRIDGED_BROWSER_ENDPOINTS)) {
  TOOL_HANDLERS[toolName] = (a, t) => callBrowserBridge(a, t, endpoint);
}

/**
 * What a tool handler may do BESIDES returning its result. Only long-blocking
 * tools need it; everything else ignores the argument entirely.
 */
export interface ToolCallContext {
  /** Report "still working" to the client. No-op when it asked for no progress. */
  onProgress?: (progress: number, message?: string) => void;
}

export async function handleMessage(
  raw: JsonRpcRequest,
  args: ParsedArgs,
  /** Server→client notifications (progress). Defaults to stdout, patched by tests. */
  emit: (msg: JsonRpcNotification) => void = send,
): Promise<JsonRpcResponse | null> {
  const { id = null, method, params } = raw;

  // Notifications carry no id; respond with null (no message back).
  if (id === undefined || (id === null && method.startsWith("notifications/"))) {
    return null;
  }

  // `resources/*`: the views as `ui://` documents for MCP Apps hosts (GENUI-08).
  const viewAnswer = method.startsWith("resources/") ? await answerResourceMethod(args, method, params) : undefined;
  if (viewAnswer) return { jsonrpc: "2.0", id, ...viewAnswer };

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // `resources`: the views as `ui://` documents for MCP Apps hosts (GENUI-08).
          capabilities: { tools: {}, resources: {} },
          serverInfo: {
            name: "topics-app",
            version: "1.0.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: toolsForProfile(args.profile) },
      };

    case "tools/call": {
      const name = (params as { name?: string } | undefined)?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
      // Defense in depth: a profile-excluded tool is not callable either, even
      // if a client ignores the filtered tools/list.
      if (name && !isToolAllowedForProfile(args.profile, name)) {
        return error(id, -32601, `Tool not available in this session profile: ${name}`);
      }
      const handler = name ? TOOL_HANDLERS[name] : undefined;
      if (!handler) {
        return error(id, -32601, `Unknown tool: ${name}`);
      }
      const progressToken = progressTokenOf(params);
      const ctx: ToolCallContext = progressToken === undefined
        ? {}
        : { onProgress: (progress, message) => emit(progressNotification(progressToken, progress, message)) };
      try {
        // Over MCP show_view also carries the drawn view, in `_meta` (GENUI-08).
        if (name === "show_view") return { jsonrpc: "2.0", id, result: await showViewCallResult(args, toolArgs) };
        const text = await handler(args, toolArgs, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: msg }],
          },
        };
      }
    }

    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

/** The stdio loop. Exported so the compiled sidecar can become the bridge (`sidecar-entry.ts`). */
export async function runTopicsMcpServer(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const args: ParsedArgs = { ...parsed, topicsHome: parsed.topicsHome ?? topicsHome() };
  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (e) {
      // Parse error: respond with id=null per JSON-RPC spec.
      send(error(null, -32700, "Parse error", String(e)));
      return;
    }
    try {
      const resp = await handleMessage(req, args);
      if (resp) send(resp);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      send(error(req.id ?? null, -32603, "Internal error", msg));
    }
  });

  // Keep the process alive until stdin closes.
  rl.on("close", () => process.exit(0));
}

// Only run the loop when executed directly (not when imported by the test file).
if (import.meta.main) {
  runTopicsMcpServer().catch((e) => {
    // Surface boot errors on stderr — the CLI host will log them.
    console.error("[topics-mcp-server] fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
