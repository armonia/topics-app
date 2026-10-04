/**
 * Quali strumenti vede la chat di un sotto-agente nativo (subagent-nativi):
 * quelli che il suo profilo concede, e nessuno strumento di delega al tetto
 * di profondità. Modulo a parte perché lo legge il provider nativo, che non
 * deve importare il runtime dei sotto-agenti (quello importa i provider: il
 * giro chiuso lascerebbe un export indefinito al caricamento).
 */
import { getSubagentBySessionKey, subagentDepth } from "./subagent-store";

/**
 * Max spawned-agent ancestry depth (a top-level orchestrator's child = 1):
 * a child may delegate once, a grandchild may not (subagent-nativi, choice 3).
 */
export const MAX_AGENT_DEPTH = 2;

/** The five tools that drive sub-agents: a child at the depth cap sees none of them. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["spawn_agent", "send_to_agent", "read_agent", "list_agents", "stop_agent"]);

export interface SubagentToolPolicy {
  /** The names the profile allows; null = all of them. */
  allowed: ReadonlySet<string> | null;
  noDelegation: boolean;
}

/**
 * Il `tools:` di un profilo, scritto coi nomi di Claude Code, tradotto nei
 * nomi del motore. `Agent`/`Task` è la delega, cioè i cinque strumenti dei
 * sotto-agenti; un tool di Topics arriva alla CLI come `mcp__topics__<nome>`,
 * qui col nome nudo; gli altri MCP restano come sono. Quel che il motore non
 * ha (WebSearch, per dire) cade: dichiararlo sarebbe un invito a fallire.
 */
const CLI_TO_ENGINE: Record<string, string[]> = {
  Read: ["read_file"], Write: ["write_file"], Edit: ["edit_file"], MultiEdit: ["edit_file"], NotebookEdit: ["edit_file"],
  Bash: ["bash"], Grep: ["grep"], Glob: ["glob"], LS: ["glob"], TodoWrite: ["todo_write"], WebFetch: ["web_fetch"],
  Skill: ["skill"], Agent: [...SUBAGENT_TOOL_NAMES], Task: [...SUBAGENT_TOOL_NAMES],
};

export function engineToolsOfProfile(tools: readonly string[] | null | undefined): string[] | null {
  if (!tools || tools.length === 0) return null;
  const out = new Set<string>();
  for (const raw of tools) {
    const name = raw.trim();
    if (!name) continue;
    if (name.startsWith("mcp__topics__")) out.add(name.slice("mcp__topics__".length));
    else if (name.startsWith("mcp__")) out.add(name);
    else for (const t of CLI_TO_ENGINE[name] ?? []) out.add(t);
  }
  return [...out];
}

/** The policy of this session, if it is a native child's chat; null for every other chat. */
export function nativeSubagentToolPolicy(sessionKey: string): SubagentToolPolicy | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the database module is loaded at the first call, as the provider does
    const { getDatabase } = require("../db");
    const db = getDatabase();
    const row = getSubagentBySessionKey(db, sessionKey);
    if (!row) return null;
    return { allowed: row.tools ? new Set(row.tools) : null, noDelegation: subagentDepth(db, sessionKey) >= MAX_AGENT_DEPTH };
  } catch {
    return null;
  }
}

/** Is this tool one the session may use, by its sub-agent policy? A non-child may use all. */
export function toolAllowedByPolicy(policy: SubagentToolPolicy | null, name: string): boolean {
  if (!policy) return true;
  if (policy.noDelegation && SUBAGENT_TOOL_NAMES.has(name)) return false;
  return !policy.allowed || policy.allowed.has(name);
}
