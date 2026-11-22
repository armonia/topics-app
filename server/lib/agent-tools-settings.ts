/**
 * The person's own choices about the agents' tools, in one small file next to
 * the rest of the app data. Read on demand (a missing or broken file is the
 * empty settings), written whole.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppDataDir } from "./data-dir";
import type { AgentToolFilter, AgentToolsSettings } from "../../shared/agent-tools";

const EMPTY: AgentToolsSettings = { extraMcpFiles: [], extraSkillDirs: [], parkedMcp: [], agentFilters: {} };

function settingsPath(): string {
  return join(resolveAppDataDir(), "agent-tools.json");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))] : [];
}

function agentFilters(value: unknown): Record<string, AgentToolFilter> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, AgentToolFilter> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const f = raw as { mode?: unknown; servers?: unknown } | null;
    if (f?.mode !== "all" && f?.mode !== "selected") continue;
    out[id] = { mode: f.mode, servers: strings(f.servers) };
  }
  return out;
}

export function readAgentToolsSettings(): AgentToolsSettings {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return { ...EMPTY, agentFilters: {} };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentToolsSettings> | null;
    return {
      extraMcpFiles: strings(raw?.extraMcpFiles),
      extraSkillDirs: strings(raw?.extraSkillDirs),
      parkedMcp: strings(raw?.parkedMcp),
      agentFilters: agentFilters(raw?.agentFilters),
    };
  } catch {
    return { ...EMPTY, agentFilters: {} };
  }
}

export function writeAgentToolsSettings(next: Partial<AgentToolsSettings>): AgentToolsSettings {
  const current = readAgentToolsSettings();
  const merged: AgentToolsSettings = {
    extraMcpFiles: strings(next.extraMcpFiles ?? current.extraMcpFiles),
    extraSkillDirs: strings(next.extraSkillDirs ?? current.extraSkillDirs),
    parkedMcp: strings(next.parkedMcp ?? current.parkedMcp),
    agentFilters: next.agentFilters ? agentFilters(next.agentFilters) : current.agentFilters,
  };
  const path = settingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}

/** One agent's filter, merged over the current settings and written whole. */
export function writeAgentToolFilter(agentId: string, filter: AgentToolFilter): AgentToolsSettings {
  const current = readAgentToolsSettings();
  return writeAgentToolsSettings({ agentFilters: { ...current.agentFilters, [agentId]: filter } });
}
