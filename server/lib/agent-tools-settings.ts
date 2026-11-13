/**
 * The person's own choices about the agents' tools, in one small file next to
 * the rest of the app data. Read on demand (a missing or broken file is the
 * empty settings), written whole.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppDataDir } from "./data-dir";
import type { AgentToolsSettings } from "../../shared/agent-tools";

const EMPTY: AgentToolsSettings = { extraMcpFiles: [], extraSkillDirs: [], parkedMcp: [] };

function settingsPath(): string {
  return join(resolveAppDataDir(), "agent-tools.json");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))] : [];
}

export function readAgentToolsSettings(): AgentToolsSettings {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return { ...EMPTY };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentToolsSettings> | null;
    return {
      extraMcpFiles: strings(raw?.extraMcpFiles),
      extraSkillDirs: strings(raw?.extraSkillDirs),
      parkedMcp: strings(raw?.parkedMcp),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function writeAgentToolsSettings(next: Partial<AgentToolsSettings>): AgentToolsSettings {
  const merged: AgentToolsSettings = {
    extraMcpFiles: strings(next.extraMcpFiles ?? readAgentToolsSettings().extraMcpFiles),
    extraSkillDirs: strings(next.extraSkillDirs ?? readAgentToolsSettings().extraSkillDirs),
    parkedMcp: strings(next.parkedMcp ?? readAgentToolsSettings().parkedMcp),
  };
  const path = settingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}
