/**
 * Builds the agents' tools inventory from standard locations plus the extra
 * sources the person configured. No path of any one machine lives here: the
 * home and the project come in as arguments.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentToolCli, AgentToolMcp, AgentToolSkill, AgentToolSource, AgentToolsInventory, AgentToolsSettings,
} from "../../shared/agent-tools";
import type { McpFleetStatus } from "../../shared/session-environment";

export interface InventoryInputs {
  home?: string;
  /** The project whose `.mcp.json` and `.claude/skills` are read too. */
  projectDir?: string | null;
  settings: AgentToolsSettings;
  fleet: McpFleetStatus;
  clis: Array<{ id: string; name: string; path: string | null; installed: boolean; install: string }>;
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

/** Minimal frontmatter reader: only `name` and `description`, one line each. */
function readSkillHeader(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const pick = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]);
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : undefined;
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
      const header = readSkillHeader(readFileSync(file, "utf-8"));
      out.push({ name: header.name || entry, description: header.description || "", source: sourceLabel });
    } catch { /* a folder without SKILL.md is not a skill */ }
  }
  return out;
}

export function buildAgentToolsInventory(inputs: InventoryInputs): AgentToolsInventory {
  const home = inputs.home ?? process.env.HOME ?? homedir();
  const { settings, fleet } = inputs;
  const sources: AgentToolSource[] = [];
  const mcp = new Map<string, AgentToolMcp>();

  const globalLabel = fleet.source ? label(fleet.source, home) : "~/.claude.json";
  for (const s of fleet.servers) {
    const parkedByUser = settings.parkedMcp.includes(s.name);
    mcp.set(s.name, {
      name: s.name,
      transport: s.transport,
      state: s.state === "ready" ? "active" : s.state === "excluded" ? "parked" : s.state,
      toolCount: s.tools.length,
      reason: parkedByUser ? "Parked from the Tools page." : s.reason,
      source: globalLabel,
      parkedByUser,
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
  return { mcp: [...mcp.values()], skills: [...skills.values()], clis, sources };
}
