/**
 * The native engine's settings for each always-on agent, in one small file
 * next to the rest of the app data, keyed by the agent id the registry reads
 * from `engine.json` (`server/agents/registry.ts`):
 *
 *   { "agents": { "main": { "compactAtTokens": 200000 } } }
 *
 * Its own file, not a key of `agent-tools.json`: that one is written whole by
 * the tools page, and a setting its writer does not know would be dropped by
 * the first filter edit. A missing or broken file is the empty profile, so a
 * machine that never writes it behaves exactly as before. Read on every turn,
 * like the model and the effort: an edit applies from the next message.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolveAppDataDir } from "./data-dir";
import { AGENT_ENGINE, instanceEntryPath } from "./instance-files";

export interface AgentEngineProfile {
  /** Compact this agent's chats past this many prompt tokens (`compactionThresholds`). */
  compactAtTokens?: number;
}

export interface AgentEngineSettings {
  agents: Record<string, AgentEngineProfile>;
}

export function agentEngineSettingsPath(): string {
  return instanceEntryPath(AGENT_ENGINE, { appDataDir: resolveAppDataDir() });
}

/** Keeps only well-formed entries: a ceiling is a positive whole number of tokens. */
export function parseAgentEngineSettings(raw: unknown): AgentEngineSettings {
  const agents: Record<string, AgentEngineProfile> = {};
  const src = (raw as { agents?: unknown } | null)?.agents;
  if (!src || typeof src !== "object") return { agents };
  for (const [id, value] of Object.entries(src as Record<string, unknown>)) {
    const cap = (value as { compactAtTokens?: unknown } | null)?.compactAtTokens;
    if (typeof cap === "number" && Number.isFinite(cap) && cap >= 1) agents[id] = { compactAtTokens: Math.floor(cap) };
  }
  return { agents };
}

export function readAgentEngineSettings(path: string = agentEngineSettingsPath()): AgentEngineSettings {
  try {
    if (!existsSync(path)) return { agents: {} };
    return parseAgentEngineSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { agents: {} };
  }
}

/** The ceiling of the agent that owns the chat, or `null` for an ordinary chat or an agent without one. */
export function compactAtTokensFor(agentId: string | null | undefined, settings: AgentEngineSettings): number | null {
  if (!agentId) return null;
  return settings.agents[agentId]?.compactAtTokens ?? null;
}
