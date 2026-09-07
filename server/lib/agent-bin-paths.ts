/**
 * The path an agent CLI was pointed at BY HAND, when the probe could not find it.
 *
 * `claude-bin.ts`, `codex-bin.ts` and `kimi-bin.ts` walk a list of known install
 * locations. The list works for the install methods the vendors document, and it
 * cannot work for the others: a custom npm prefix, a version manager, a portable
 * copy on a second volume. Whoever installed the CLI somewhere else saw Settings
 * say the provider was not there, with no way to contradict it (card 38d9f64b) —
 * the environment variables (`CODEX_BIN`, `CLAUDE_BIN`) only help someone who
 * starts the server from a shell, which is not how the desktop app runs.
 *
 * So the override is persisted with the rest of the settings and read by the
 * resolvers FIRST: an explicit answer beats a guess. It is validated on the way
 * in (`POST /api/providers/cli/configure`) and again here on the way out, because
 * a binary can be uninstalled after it was chosen and a stale path would register
 * a provider that cannot answer.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { getAppSettings, updateAppSettings } from "../services/app-settings";

/** The agent CLIs Topics knows how to look for. Mirrors `detect-agents.ts`. */
export const CLI_AGENT_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "kimi-code",
  "gemini",
] as const;

export type CliAgentId = (typeof CLI_AGENT_IDS)[number];

/**
 * The file name each CLI installs itself as. The session-type id is not it:
 * `claude-code` ships a binary called `claude`, `kimi-code` one called `kimi`.
 * Needed when somebody points at a DIRECTORY instead of the binary, which is
 * what a file picker gives you when the CLI lives inside an app bundle.
 */
export const CLI_AGENT_BIN_NAMES: Record<CliAgentId, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  "kimi-code": "kimi",
  gemini: "gemini",
};

export function isCliAgentId(value: unknown): value is CliAgentId {
  return typeof value === "string" && (CLI_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * `~/bin/codex` is what a person types; `existsSync` does not expand it.
 * Exported because the route validates the same string before storing it, and
 * the two must expand it the same way.
 */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return homedir() + trimmed.slice(1);
  }
  return trimmed;
}

/** The stored map, tolerant of anything that is not the shape we wrote. */
export function readAgentBinPaths(): Partial<Record<CliAgentId, string>> {
  const raw = getAppSettings().agentBinPaths;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<CliAgentId, string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isCliAgentId(key) && typeof value === "string" && value.trim() !== "") {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * The override for one agent, or `null` when there is none or the file it points
 * at is gone. A path that no longer resolves is treated as absent rather than
 * returned: the caller would spawn it.
 */
export function agentBinPath(id: CliAgentId): string | null {
  const stored = readAgentBinPaths()[id];
  if (!stored) return null;
  const expanded = expandHome(stored);
  return existsSync(expanded) ? expanded : null;
}

/** Set (or, with `null`, clear) the override for one agent. */
export function writeAgentBinPath(id: CliAgentId, path: string | null): void {
  const map = readAgentBinPaths();
  if (path === null) delete map[id];
  else map[id] = path.trim();
  const remaining = Object.keys(map).length;
  updateAppSettings({ agentBinPaths: remaining === 0 ? null : JSON.stringify(map) });
}
