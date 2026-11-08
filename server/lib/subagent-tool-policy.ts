/**
 * Which tools a native sub-agent's chat sees (subagent-nativi): the ones its
 * profile grants, and no delegation tool at the depth cap. A module of its own
 * because the native provider reads it and must not import the sub-agent
 * runtime (that one imports the providers: the cycle would leave an export
 * undefined at load).
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
 * A profile's `tools:`, written with Claude Code's names, mapped to the
 * engine's. `Agent`/`Task` is delegation, i.e. the five sub-agent tools; a
 * Topics tool reaches the CLI as `mcp__topics__<name>` and the engine by its
 * bare name; other MCP tools stay as they are. What the engine lacks
 * (WebSearch, say) is dropped: declaring it would be an invitation to fail.
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
