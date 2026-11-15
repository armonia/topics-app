import { RUN_COMMAND_BOARD_DESCRIPTION, isBoardProfile } from "./command-tools";
import { hasCommandShell } from "../lib/command-process";
import { homedir } from "os";
import { agentTypeDescription, readAgentProfiles } from "../lib/agent-profiles";
import { TOOLS, runScriptDescription } from "./tool-definitions";

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
