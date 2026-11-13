/**
 * The agents' tools as ONE inventory: MCP servers, skills and agent CLIs.
 *
 * The user menu page and the `topics tools` command read the same payload from
 * `GET /api/agent-tools`, so what a person sees and what an agent is told can
 * never drift apart.
 */

/** `parked` = defined somewhere but not mounted (on purpose or by a rule). */
export type AgentToolMcpState = 'active' | 'parked' | 'needs-auth' | 'failed';

export interface AgentToolMcp {
  name: string;
  state: AgentToolMcpState;
  transport: 'http' | 'stdio' | null;
  /** How many tools it exposes right now (0 when it is not mounted). */
  toolCount: number;
  /** Why it is not active: the connection error, or the rule that parked it. */
  reason?: string;
  /** The file that defines it, as a display label (`~/.claude.json`). */
  source: string;
  /** True when Topics itself parked it (the person can mount it again). */
  parkedByUser: boolean;
}

export interface AgentToolSkill {
  name: string;
  description: string;
  /** The folder it was found in, as a display label. */
  source: string;
}

export interface AgentToolCli {
  id: string;
  name: string;
  installed: boolean;
  path: string | null;
  /** How to install it, shown when it is missing. */
  install: string;
}

export interface AgentToolSource {
  kind: 'mcp' | 'skills';
  label: string;
  found: boolean;
  /** An extra source the person added, as opposed to a standard location. */
  extra: boolean;
}

export interface AgentToolsInventory {
  mcp: AgentToolMcp[];
  skills: AgentToolSkill[];
  clis: AgentToolCli[];
  sources: AgentToolSource[];
}

/** What the person configures: extra places to read, and servers parked by hand. */
export interface AgentToolsSettings {
  extraMcpFiles: string[];
  extraSkillDirs: string[];
  parkedMcp: string[];
}
