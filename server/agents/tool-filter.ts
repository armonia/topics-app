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
import type { McpFleetStatus } from "../../shared/session-environment";
import { resolveAgentIdForWorkspace, type AgentRecord } from "./registry";

export const ALL_TOOLS_FILTER: AgentToolFilter = { mode: "all", servers: [] };

/** A missing or unknown agent id gets the default filter: the whole catalog. */
export function resolveAgentToolFilter(
  agentId: string | null | undefined,
  settings: Pick<AgentToolsSettings, "agentFilters">,
): AgentToolFilter {
  if (!agentId) return ALL_TOOLS_FILTER;
  return settings.agentFilters[agentId] ?? ALL_TOOLS_FILTER;
}

/** Filters any named catalog items (MCP servers, skills, CLIs) down to what the filter allows. */
export function filterByName<T extends { name: string }>(filter: AgentToolFilter, items: T[]): T[] {
  if (filter.mode === "all") return items;
  const kept = new Set(filter.servers);
  return items.filter((item) => kept.has(item.name));
}

/**
 * Narrows the live fleet's own tool specs (`mcp__<server>__<tool>`, exactly
 * what a turn sends to the model) to one agent's filter, using the fleet's
 * `tools` list to go from a server name to the prefixed names it actually
 * mounted. This is the function a turn calls, not the inventory route: the
 * inventory shows the same rule, but only this call narrows what the model
 * is offered.
 */
export function filterMcpToolSpecsForAgent<T extends { name: string }>(
  agentId: string | null | undefined,
  settings: Pick<AgentToolsSettings, "agentFilters">,
  fleet: McpFleetStatus,
  toolSpecs: T[],
): T[] {
  const filter = resolveAgentToolFilter(agentId, settings);
  if (filter.mode === "all") return toolSpecs;
  const allowedNames = new Set(filterByName(filter, fleet.servers).flatMap((s) => s.tools));
  return toolSpecs.filter((t) => allowedNames.has(t.name));
}

/**
 * The whole chain a turn runs, in one pure call: which agent (if any) owns
 * this workspace, then that agent's filter applied to the live fleet's tool
 * specs. This is what `provider.ts` calls to build the turn's own tool
 * list — not a second copy of the two steps composed inline, so a mutation
 * dropping either step turns this function's own test red.
 */
export function turnToolSpecsFor<T extends { name: string }>(
  workspace: string | null | undefined,
  agents: AgentRecord[],
  settings: Pick<AgentToolsSettings, "agentFilters">,
  fleet: McpFleetStatus,
  toolSpecs: T[],
): T[] {
  const agentId = resolveAgentIdForWorkspace(workspace, agents);
  return filterMcpToolSpecsForAgent(agentId, settings, fleet, toolSpecs);
}

/** Validates a filter coming from a request body; throws on anything malformed. */
export function parseAgentToolFilter(body: unknown): AgentToolFilter {
  const b = body as { mode?: unknown; servers?: unknown } | null;
  const mode = b?.mode;
  if (mode !== "all" && mode !== "selected") throw new Error("mode must be 'all' or 'selected'");
  const servers = Array.isArray(b?.servers) ? b.servers.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return { mode, servers: [...new Set(servers)] };
}
