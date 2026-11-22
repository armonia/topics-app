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
  /** Ids of the agents whose filter allows this server (`agentFilters`). */
  agents: string[];
  /** Measured token weight of its mounted tool schemas (name+description+input_schema),
   *  the cost paid on EVERY turn since an active server's tools ride along every
   *  round. `null` when it is not mounted, so there is nothing to measure. */
  tokens: number | null;
}

export interface AgentToolSkill {
  name: string;
  description: string;
  /** The folder it was found in, as a display label. */
  source: string;
  /** Measured token weight of the whole `SKILL.md`, the cost paid only when the
   *  skill is actually invoked, as opposed to an MCP server's `tokens` above. */
  tokens: number;
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

/** `all` = every catalog item (the default); `selected` = only the named ones. */
export type AgentToolFilterMode = 'all' | 'selected';

export interface AgentToolFilter {
  mode: AgentToolFilterMode;
  /** Item names kept when `mode` is `'selected'`; ignored (and normally empty) for `'all'`. */
  servers: string[];
}

export interface AgentToolsInventory {
  mcp: AgentToolMcp[];
  skills: AgentToolSkill[];
  clis: AgentToolCli[];
  sources: AgentToolSource[];
  /** The agents that can use these tools, each with its own filter. */
  agents: Array<{ id: string; name: string; filter: AgentToolFilter }>;
  /** Measured context cost, split by when it is paid: every round (active MCP
   *  servers) against only when invoked (skills). Used by Sistema › Harness. */
  tokenWeight: { alwaysOn: number; onDemand: number };
}

/** What the person configures: extra places to read, servers parked by hand,
 *  and each agent's own tool filter. */
export interface AgentToolsSettings {
  extraMcpFiles: string[];
  extraSkillDirs: string[];
  parkedMcp: string[];
  agentFilters: Record<string, AgentToolFilter>;
}
