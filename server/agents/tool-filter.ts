/**
 * What a turn may use, applied to the actual catalog instead of only shown
 * on a screen. One agent's filter is `'all'` (the default: the whole
 * catalog) or `'selected'` (only the named items): the same shape serves the
 * native engine's MCP server allow-list and the gateway's mountable
 * children, because both are just "keep the items whose name is allowed".
 *
 * A FILTER THAT DOES NOT NARROW THE TURN IS NOT A FILTER. Everything here is
 * pure and name-based so the one function that decides what a screen shows
 * is the same one the turn's own request filters through — there is no
 * second copy to drift out of sync with it.
 */
import type { AgentToolFilter, AgentToolsSettings } from "../../shared/agent-tools";

export const ALL_TOOLS_FILTER: AgentToolFilter = { mode: "all", servers: [] };

/** A missing or unknown agent id gets the default filter: the whole catalog. */
export function resolveAgentToolFilter(
  agentId: string | null | undefined,
  settings: Pick<AgentToolsSettings, "agentFilters">,
): AgentToolFilter {
  if (!agentId) return ALL_TOOLS_FILTER;
  return settings.agentFilters[agentId] ?? ALL_TOOLS_FILTER;
}

/** Every catalog name this filter keeps, in the catalog's own order. */
export function allowedNames(filter: AgentToolFilter, catalogNames: string[]): string[] {
  if (filter.mode === "all") return catalogNames;
  const kept = new Set(filter.servers);
  return catalogNames.filter((name) => kept.has(name));
}

/** Filters any named catalog items (MCP servers, skills, CLIs) down to what the filter allows. */
export function filterByName<T extends { name: string }>(filter: AgentToolFilter, items: T[]): T[] {
  if (filter.mode === "all") return items;
  const kept = new Set(filter.servers);
  return items.filter((item) => kept.has(item.name));
}

/** Validates a filter coming from a request body; throws on anything malformed. */
export function parseAgentToolFilter(body: unknown): AgentToolFilter {
  const b = body as { mode?: unknown; servers?: unknown } | null;
  const mode = b?.mode;
  if (mode !== "all" && mode !== "selected") throw new Error("mode must be 'all' or 'selected'");
  const servers = Array.isArray(b?.servers) ? b.servers.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return { mode, servers: [...new Set(servers)] };
}
