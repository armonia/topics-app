/**
 * Builds the agents' tools inventory from standard locations plus the extra
 * sources the person configured. No path of any one machine lives here: the
 * home and the project come in as arguments.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentToolCli, AgentToolFilter, AgentToolMcp, AgentToolSkill, AgentToolSource, AgentToolsInventory, AgentToolsSettings,
} from "../../shared/agent-tools";
import type { McpFleetStatus } from "../../shared/session-environment";
import { ALL_TOOLS_FILTER, filterByName, resolveAgentToolFilter } from "../agents/tool-filter";

/** Chars/4, the same measure the rest of the app uses for context weight
 *  (`server/context/assemble.ts`): computed from the real text, never a
 *  hand-picked number. */
export function measureTokens(text: string): number {
  return Math.round(text.length / 4);
}

export interface InventoryInputs {
  home?: string;
  /** The project whose `.mcp.json` and `.claude/skills` are read too. */
  projectDir?: string | null;
  settings: AgentToolsSettings;
  fleet: McpFleetStatus;
  clis: Array<{ id: string; name: string; path: string | null; installed: boolean; install: string }>;
  /** The always-on agents this catalog is shared by (`server/agents/registry.ts`). */
  agents?: Array<{ id: string; name: string }>;
  /** The fleet's mounted tool schemas, to measure an active server's real
   *  context cost. Keyed by the same prefixed name `McpServerStatus.tools` carries. */
  toolSpecs?: Array<{ name: string; description: string; input_schema: unknown }>;
  /** Scope the answer to what THIS agent may use: the native engine's MCP
   *  allow-list, or the gateway's mountable children. `null`/omitted = every
   *  agent's view, unfiltered (the Sistema › Strumenti catalog page). */
  agentId?: string | null;
}

/** `/home/x/.claude.json` -> `~/.claude.json`: a label, never a place to write. */
function label(path: string, home: string): string {
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}

function expand(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function readMcpFile(path: string): Record<string, { type?: string; url?: string }> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, { type?: string; url?: string }> } | null;
    return parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers ? parsed.mcpServers : {};
  } catch {
    return null;
  }
}

/**
 * Minimal frontmatter reader: only `name` and `description`. A block scalar
 * (`|`, `|-`, `>`, `>-`, with optional `+` or digit) is read from the indented
 * lines that follow and folded into one line, which is enough for a preview.
 */
function readSkillHeader(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const pick = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const value = lines[at].slice(key.length + 1).trim();
    if (/^[|>][+-]?\d*$/.test(value)) {
      const body: string[] = [];
      for (let i = at + 1; i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i])); i++) {
        if (lines[i].trim()) body.push(lines[i].trim());
      }
      return body.join(" ");
    }
    return value.replace(/^["']|["']$/g, "");
  };
  return { name: pick("name"), description: pick("description") };
}

function readSkills(dir: string, sourceLabel: string): AgentToolSkill[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: AgentToolSkill[] = [];
  for (const entry of entries.sort()) {
    const file = join(dir, entry, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf-8");
      const header = readSkillHeader(text);
      out.push({ name: header.name || entry, description: header.description || "", source: sourceLabel, tokens: measureTokens(text) });
    } catch { /* a folder without SKILL.md is not a skill */ }
  }
  return out;
}

/** Ids of the agents whose filter lets them use this catalog item. */
function usersOf(name: string, agents: Array<{ id: string; name: string }>, settings: AgentToolsSettings): string[] {
  return agents
    .filter((a) => {
      const f: AgentToolFilter = settings.agentFilters[a.id] ?? ALL_TOOLS_FILTER;
      return f.mode === "all" || f.servers.includes(name);
    })
    .map((a) => a.id);
}

export function buildAgentToolsInventory(inputs: InventoryInputs): AgentToolsInventory {
  const home = inputs.home ?? process.env.HOME ?? homedir();
  const { settings, fleet } = inputs;
  const sources: AgentToolSource[] = [];
  const mcp = new Map<string, AgentToolMcp>();
  const registryAgents = inputs.agents ?? [];
  const specsByName = new Map((inputs.toolSpecs ?? []).map((s) => [s.name, s]));

  const globalLabel = fleet.source ? label(fleet.source, home) : "~/.claude.json";
  for (const s of fleet.servers) {
    const parkedByUser = settings.parkedMcp.includes(s.name);
    const active = s.state === "ready";
    const tokens = active
      ? s.tools.reduce((sum, toolName) => {
        const spec = specsByName.get(toolName);
        return sum + (spec ? measureTokens(`${spec.name}${spec.description}${JSON.stringify(spec.input_schema)}`) : 0);
      }, 0)
      : null;
    mcp.set(s.name, {
      name: s.name,
      transport: s.transport,
      state: s.state === "ready" ? "active" : s.state === "excluded" ? "parked" : s.state,
      toolCount: s.tools.length,
      reason: parkedByUser ? "Parked from the Tools page." : s.reason,
      source: globalLabel,
      parkedByUser,
      agents: usersOf(s.name, registryAgents, settings),
      tokens,
    });
  }
  sources.push({ kind: "mcp", label: globalLabel, found: fleet.source !== null && existsSync(fleet.source), extra: false });

  const files: Array<{ path: string; extra: boolean }> = [];
  if (inputs.projectDir) files.push({ path: join(inputs.projectDir, ".mcp.json"), extra: false });
  for (const f of settings.extraMcpFiles) files.push({ path: expand(f, home), extra: true });
  for (const { path, extra } of files) {
    const servers = readMcpFile(path);
    sources.push({ kind: "mcp", label: label(path, home), found: servers !== null, extra });
    for (const [name, def] of Object.entries(servers ?? {})) {
      if (mcp.has(name)) continue;
      mcp.set(name, {
        name,
        transport: def.type === "http" || def.url ? "http" : "stdio",
        state: "parked",
        toolCount: 0,
        reason: "Defined here, but Topics does not mount this file.",
        source: label(path, home),
        parkedByUser: false,
        agents: usersOf(name, registryAgents, settings),
        tokens: null,
      });
    }
  }

  const skillDirs: Array<{ path: string; extra: boolean }> = [
    { path: join(home, ".claude", "skills"), extra: false },
    { path: join(home, ".agents", "skills"), extra: false },
  ];
  if (inputs.projectDir) skillDirs.push({ path: join(inputs.projectDir, ".claude", "skills"), extra: false });
  for (const d of settings.extraSkillDirs) skillDirs.push({ path: expand(d, home), extra: true });
  const skills = new Map<string, AgentToolSkill>();
  for (const { path, extra } of skillDirs) {
    sources.push({ kind: "skills", label: label(path, home), found: existsSync(path), extra });
    for (const skill of readSkills(path, label(path, home))) if (!skills.has(skill.name)) skills.set(skill.name, skill);
  }

  const clis: AgentToolCli[] = inputs.clis.map((c) => ({ id: c.id, name: c.name, installed: c.installed, path: c.path, install: c.install }));
  const agentsRoster = registryAgents.map((a) => ({ id: a.id, name: a.name, filter: settings.agentFilters[a.id] ?? ALL_TOOLS_FILTER }));
  const tokenWeight = {
    alwaysOn: [...mcp.values()].reduce((sum, m) => sum + (m.tokens ?? 0), 0),
    onDemand: [...skills.values()].reduce((sum, s) => sum + s.tokens, 0),
  };

  // Acting AS one agent: the turn's own view, narrowed to what it may use —
  // not just a label on an unfiltered list, or the filter is decoration.
  const filter = resolveAgentToolFilter(inputs.agentId, settings);
  const mcpList = filterByName(filter, [...mcp.values()]);
  const skillList = filterByName(filter, [...skills.values()]);

  return { mcp: mcpList, skills: skillList, clis, sources, agents: agentsRoster, tokenWeight };
}
