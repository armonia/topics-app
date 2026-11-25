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
import { RUN_COMMAND_BOARD_DESCRIPTION, callRunCommand, isBoardProfile } from "./command-tools";
import { answerResourceMethod, callShowView, showViewCallResult } from "./view-tools";
import { hasCommandShell } from "../lib/command-process";
import { topicsHome } from "../services/daemon-state";
import { homedir } from "os";
import { agentTypeDescription, readAgentProfiles } from "../lib/agent-profiles";
import type { ParsedArgs } from "./topics-http";
import { TOOLS, runScriptDescription } from "./tool-catalog";
import {
  callBrowserBridge, callCloseBrowserPane, callFocusBrowserTab, callImportChrome, callListBrowserTabs, callOpenBrowserPane, callRequestLogin,
} from "./browser-pane-tools";
import { callCloseGoal, callGetGoal, callSetGoal, callUpdateGoalSteps } from "./goal-tools";
import { callListProcesses, callReadProcessOutput, callRunScript, callStopProcess, callWaitForProcess } from "./process-tools";
import { callCreateProject, callMoveToProject, callNewTopic, callOpenProject, callResolveTab, callSwitchTopic } from "./topic-tools";
import { callListAgents, callReadAgent, callSendToAgent, callSpawnAgent, callStopAgent } from "./agent-tools";
import { callReadChatMessages, callSendChatMessage } from "./chat-tools";
import {
  callCommentGlobalTask, callCommentTask, callCreateGlobalTask, callCreateTask, callGetGlobalTask, callGetTask,
  callLabelTask, callListGlobalTasks, callListTasks, callUpdateGlobalTask, callUpdateTask, callWaitForCondition,
} from "./board-tools";
import { callApprovalPrompt, callAskUserQuestion } from "./human-prompt-tools";

// Re-exported so the tests and callers that import these from the server keep
// their import lines: the handlers moved to one module per tool family.
export * from "./browser-pane-tools";
export * from "./goal-tools";
export * from "./process-tools";
export * from "./topic-tools";
export * from "./agent-tools";
export * from "./chat-tools";
export * from "./board-tools";
export * from "./human-prompt-tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A server→client message with no id: nothing comes back and nothing is waiting
 * for it. Used for `notifications/progress`, which is the ONLY thing that keeps
 * a long tool call alive — see `emitProgress`.
 */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";


export type { ParsedArgs } from "./topics-http";

/**
 * Tools a dispatched board agent never needs — every schema here would ride
 * along in the agent's context on every API call for nothing. Excluded under
 * `--profile=dispatch`, BOTH from tools/list and (defense in depth) tools/call:
 * cross-topic chat, topic/tab navigation, project management, Chrome cookie
 * import. The task tools, the process tools (run_script &c.) and every browser_*
 * verification tool stay.
 *
 * IL FAN-OUT È TORNATO, e con lui la ragione per cui era stato tolto. La
 * motivazione originale — «un agente di board non puo' fare fan-out: sarebbe un
 * secondo dispatcher fuori dal governo dei tetti» — era giusta sul fatto e
 * sbagliata sul rimedio: toglieva lo strumento invece di metterlo sotto
 * governo. Il modello del coordinatore ha bisogno di quello strumento (la
 * sessione del task DECIDE, il lavoro gira nelle figlie), e il governo ora
 * esiste ed è alla porta, non qui:
 *   · il tetto di concorrenza conta le figlie come chiunque altro
 *     (`agent-census.ts`, letto sia dal claim che dalla rotta di spawn);
 *   · il loro consumo si contabilizza sul task padre (`dispatch-usage.ts`);
 *   · profondita' 1: una figlia non apre nipoti (`boardSpawnRefusal`);
 *   · muoiono col padre (`orphanChildSessions`, spazzata del dispatcher).
 * `list_agents` resta fuori: chi ha aperto le figlie e' il coordinatore, che gli
 * id ce li ha gia' dallo `spawn_agent`, e uno schema in meno e' un prefisso in
 * meno moltiplicato per ogni chiamata del turno.
 */
// `read_chat_messages` is NOT excluded: `resolve_tab` (kept on purpose) answers a
// pasted `/tab/chat/<id>` with `next: read_chat_messages`, and a task agent
// that is sent to a tool it does not have cannot read the chat it was shown.
const DISPATCH_EXCLUDED_TOOLS = new Set([
  // A dispatched agent works a card in its own topic, which carries no goal:
  // the two schemas would be paid on every call for a tool it can never use.
  "get_goal",
  "close_goal",
  "set_goal",
  "update_goal_steps",
  "list_agents",
  "send_chat_message",
  "new_topic",
  "switch_topic",
  "import_chrome",
  "move_session_to_project",
  "create_project",
  "open_project",
]);

// Codex task sessions use the same focused dispatch surface, but cannot own
// the interactive Claude PTY that backs `spawn_agent`. Keep child inspection
// and stopping available for existing owned children; only creation is
// provider-specific.
const CODEX_DISPATCH_EXCLUDED_TOOLS = new Set([
  ...DISPATCH_EXCLUDED_TOOLS,
  "spawn_agent",
]);

/**
 * The global coordinator is purpose-built board coordination, not a general
 * agent shell. Keep this positive allowlist intentionally tiny: visibility is
 * not authorization (the routes re-check the registry), but it prevents a
 * model from discovering unrelated controls in the first place.
 */
const GLOBAL_ORCHESTRATOR_TOOL_NAMES = new Set([
  "list_global_tasks",
  "get_global_task",
  "create_global_task",
  "update_global_task",
  "comment_global_task",
]);

/**
 * `approval_prompt` è pubblicato SEMPRE, e non è un'incoerenza: lo spawn passa
 * `--permission-prompt-tool` in ogni modalità, e la CLI toglie da sé il tool
 * designato dall'elenco che il modello vede (verificato sul filo, anche in
 * `bypassPermissions`). Quindi il modello non lo vede mai, e non esiste una
 * combinazione in cui la CLI lo cerchi e il bridge non ce l'abbia — che è
 * esattamente il modo in cui la versione a due flag si rompeva:
 * «MCP tool mcp__topics__approval_prompt … not found» su ogni richiesta.
 */
export function toolsForProfile(
  profile: string | undefined,
  platform: NodeJS.Platform = process.platform,
  /** Where the profiles of `agent_type` are read from: the session's directory and the user's home. */
  opts: { cwd?: string | null; home?: string } = {},
): typeof TOOLS {
  if (profile === "global-orchestrator") {
    return TOOLS.filter((t) => GLOBAL_ORCHESTRATOR_TOOL_NAMES.has(t.name));
  }
  return withAgentProfiles(toolsForOrdinaryProfile(profile, platform), opts);
}

/**
 * `spawn_agent` with the `agent_type` description listing the profiles the
 * server can see now (SUBAGENT-09): built on every tools/list, so a profile
 * added to ~/.claude/agents shows up in the next session without a release.
 */
function withAgentProfiles(tools: typeof TOOLS, opts: { cwd?: string | null; home?: string }): typeof TOOLS {
  const spawn = tools.find((t) => t.name === "spawn_agent");
  if (!spawn) return tools;
  // `cwd: null` says there is no project: only the user's profiles.
  const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd;
  const description = agentTypeDescription(readAgentProfiles({ home: opts.home ?? homedir(), cwd }));
  const schema = spawn.inputSchema as { properties: Record<string, object> };
  const withList = {
    ...spawn,
    inputSchema: { ...schema, properties: { ...schema.properties, agent_type: { type: "string", description } } },
  } as (typeof TOOLS)[number];
  return tools.map((t) => (t === spawn ? withList : t));
}

function toolsForOrdinaryProfile(profile: string | undefined, platform: NodeJS.Platform): typeof TOOLS {
  // Global board tools have no safe meaning outside the registry-backed
  // coordinator. Do not merely hide them from `tools/list`: exclude them from
  // every ordinary profile and deny direct calls below as well.
  const tools = TOOLS.filter((t) =>
    !GLOBAL_ORCHESTRATOR_TOOL_NAMES.has(t.name)
    && (profile !== "dispatch" || !DISPATCH_EXCLUDED_TOOLS.has(t.name))
    && (profile !== "codex-dispatch" || !CODEX_DISPATCH_EXCLUDED_TOOLS.has(t.name))
    // No POSIX shell to run it in (`commandArgv`): offered, it could only fail.
    && (hasCommandShell(platform) || t.name !== "run_command"),
  );
  // A board card's agent waits for its command inside the turn (`isBoardProfile`),
  // and without run_command run_script points to a shell command instead.
  const board = isBoardProfile(profile);
  const shell = hasCommandShell(platform);
  return tools.map((t) => {
    if (board && t.name === "run_command") return { ...t, description: RUN_COMMAND_BOARD_DESCRIPTION };
    if (!shell && t.name === "run_script") return { ...t, description: runScriptDescription(false) };
    return t;
  });
}

export function isToolAllowedForProfile(profile: string | undefined, name: string): boolean {
  // `approval_prompt` resta CHIAMABILE anche quando non è pubblicato: chi lo
  // chiama è la CLI, non il modello, e un `tools/list` che non lo elenca non
  // vuol dire che la CLI non lo designi. Rifiutarlo qui spegnerebbe il canale
  // proprio nelle sessioni che ne hanno bisogno.
  // The permission bridge is invoked by the CLI, not advertised to the model.
  // Ordinary profiles retain it; the global coordinator deliberately has no
  // generic approval/tool-resume channel, only its five board tools.
  if (profile === "global-orchestrator") return GLOBAL_ORCHESTRATOR_TOOL_NAMES.has(name);
  if (name === "approval_prompt") return true;
  if (GLOBAL_ORCHESTRATOR_TOOL_NAMES.has(name)) return false;
  if (profile === "dispatch") return !DISPATCH_EXCLUDED_TOOLS.has(name);
  if (profile === "codex-dispatch") return !CODEX_DISPATCH_EXCLUDED_TOOLS.has(name);
  return true;
}

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

function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * Build a `notifications/progress` frame for a tool call the client asked to be
 * kept informed about (`params._meta.progressToken`).
 *
 * WHY this exists — the third clock over `ask_user_question`. The panel already
 * survives the socket (short poll legs) and the server's stale-stream sweeper
 * (the ask exemption). The one left was the MCP CLIENT's own patience: Claude
 * Code times a tool call out after 30 minutes of hearing NOTHING, and killed a
 * live question with "no response and no progress for 1800s". Its own wording is
 * the fix — the timer resets on progress. So every poll leg says "still here",
 * and the panel lives to the ask's real TTL instead of an unrelated 30-minute
 * cap.
 *
 * `total` is deliberately omitted: we are not 40% of the way to a human
 * answering. Indeterminate progress is the honest shape, and the spec allows it.
 */
function progressNotification(
  progressToken: string | number,
  progress: number,
  message?: string,
): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, ...(message ? { message } : {}) },
  };
}

/** The client's progress token for this request, if it asked for progress. */
function progressTokenOf(params: Record<string, unknown> | undefined): string | number | undefined {
  const meta = (params as { _meta?: { progressToken?: unknown } } | undefined)?._meta;
  const token = meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function error(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
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
    // What was shown rides before the context, so the contextId stays last.
    const shown = r.media ? `${outcome} [media: ${r.media}]` : outcome;
    const body = r.contextId ? `${shown} [contextId: ${r.contextId}]` : shown;
    // The port/project warning (task f9cf765e) LEADS the result: it is the one
    // line an agent skimming "Opened browser pane at ..." must not be able to
    // miss, so it is not appended at the end where a long result truncates it.
    const lead = [r.warning, r.note].filter(Boolean).join("\n");
    return lead ? `${lead}\n${body}` : body;
  },
  request_login: (a, t) => callRequestLogin(a, t),
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
