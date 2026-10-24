/**
 * MCP tool schemas travel deferred, and load when the model asks for them.
 *
 * WHY. Every MCP tool schema rode in the prefix of every request: 55 tools from
 * exa, context7 and the gateway, about 37k tokens measured on 24/10, paid on each round
 * of each turn of each chat whether a tool was used or not. The CLI stopped
 * paying this long ago (`toolSearch` in `claude/args.ts`); the native engine
 * still did.
 *
 * HOW. The API takes `defer_loading: true` on a tool: the definition is sent
 * but stays out of the model's context until a `tool_reference` names it. The
 * model finds and loads tools with `tool_search`, a tool of ours whose result
 * is a list of `tool_reference` blocks (verified on the subscription OAuth on
 * 24/10; a reference mixed with a text block is refused with a 400). The API
 * expands a reference wherever it sits in the history, so a loaded tool stays
 * loaded for the rest of the conversation and the cached prefix never moves.
 *
 * THE PER-SESSION ALLOWLIST. A reference can leave the history while the calls
 * it enabled stay: history rebuilt from the DB after a restart
 * (`history-rehydrate.ts`) keeps every `tool_use` but writes the search result
 * back as text. The API accepts such a call without its schema, and the model
 * then repeats it blind. So an MCP tool the history CALLS and no longer
 * REFERENCES is sent loaded. Derived from the history on every round, the list
 * needs no storage of its own and cannot drift from the conversation it
 * describes. In a live conversation a tool is called only after it was found,
 * so the list is empty and the prefix stays byte-identical.
 *
 * A TOOL THAT LEFT THE FLEET. The API refuses a request whose history
 * references a tool missing from `tools` ("Tool reference 'x' not found in
 * available tools", a 400), and the reference stays in the history for good.
 * MCP tools leave the fleet while the process lives: a remount from the panel
 * or after an OAuth login, a server that re-lists its tools, a gateway child
 * unmounted. So every referenced tool the fleet no longer offers is still
 * declared, as a stub that says it is gone; a call to it gets "unknown MCP
 * tool", as it did before deferral, and the chat goes on.
 *
 * `TOPICS_TOOL_SEARCH=off` sends every schema loaded again, the same lever as
 * the CLI path.
 */
import { isMcpTool } from "./mcp-fleet";
import type { AgentMessage } from "./agent-loop";
import type { ToolResult, ToolSpec } from "./tools";

export const TOOL_SEARCH_NAME = "tool_search";

/** A tool as it goes in the request body. */
export type OfferedTool = ToolSpec & { defer_loading?: true };

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;

export function toolSearchEnabled(): boolean {
  return process.env.TOPICS_TOOL_SEARCH !== "off";
}

/** Names the history loads through a `tool_reference` inside a `tool_result`. */
export function referencedTools(history: AgentMessage[]): Set<string> {
  const names = new Set<string>();
  for (const m of history) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      for (const inner of b.content as { type?: string; tool_name?: string }[]) {
        if (inner?.type === "tool_reference" && inner.tool_name) names.add(inner.tool_name);
      }
    }
  }
  return names;
}

/** MCP tools the history has called. */
export function calledMcpTools(history: AgentMessage[]): Set<string> {
  const names = new Set<string>();
  for (const m of history) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use" && b.name && isMcpTool(b.name)) names.add(b.name);
  }
  return names;
}

/**
 * The tools of one round as the API should see them. Non-MCP tools first and
 * untouched, then the MCP tools the allowlist keeps loaded, then `tool_search`,
 * then every other MCP tool deferred. Nothing is removed: a deferred tool is
 * still callable once loaded.
 */
export function withDeferredMcp(tools: ToolSpec[], history: AgentMessage[]): OfferedTool[] {
  const referenced = referencedTools(history);
  const offered = deferMcp(tools, history, referenced);
  const gone = [...referenced].filter((name) => !offered.some((t) => t.name === name));
  return gone.length === 0 ? offered : [...offered, ...gone.map(goneToolSpec)];
}

function deferMcp(tools: ToolSpec[], history: AgentMessage[], referenced: Set<string>): OfferedTool[] {
  if (!toolSearchEnabled()) return tools;
  const mcp = tools.filter((t) => isMcpTool(t.name));
  if (mcp.length === 0) return tools;
  const called = calledMcpTools(history);
  const pinned = mcp.filter((t) => called.has(t.name) && !referenced.has(t.name));
  const deferred = mcp.filter((t) => !pinned.includes(t));
  if (deferred.length === 0) return tools;
  return [
    ...tools.filter((t) => !isMcpTool(t.name)),
    ...pinned,
    toolSearchSpec(deferred),
    ...deferred.map((t) => ({ ...t, defer_loading: true as const })),
  ];
}

/**
 * A referenced tool the fleet no longer offers. Deferred like the others: the
 * reference in the history loads it, and its description is all it says.
 */
function goneToolSpec(name: string): OfferedTool {
  return {
    name,
    description: "No longer available: the MCP server that offered this tool does not list it any more. Do not call it.",
    input_schema: { type: "object", properties: {} },
    defer_loading: true,
  };
}

/**
 * The search tool. Its description names every deferred tool, so the model
 * knows what exists without paying for the schemas; it changes only when the
 * deferred set does.
 */
export function toolSearchSpec(deferred: ToolSpec[]): ToolSpec {
  return {
    name: TOOL_SEARCH_NAME,
    description:
      "Load the schemas of deferred tools so you can call them. The tools below are available but their " +
      "parameters are not loaded: call this first, then call the tool. Query with `select:<name>[,<name>...]` " +
      "for exact names, or with keywords (prefix a word with + to require it).\n\nDeferred tools:\n" +
      deferred.map((t) => t.name).join("\n"),
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "`select:name1,name2` or keywords" },
        max_results: { type: "number", description: `How many tools to load (default ${DEFAULT_RESULTS}, at most ${MAX_RESULTS})` },
      },
      required: ["query"],
    },
  };
}

/**
 * Runs a search over `catalog` (the MCP tools this round offers, already
 * filtered by the session's policy). Exact names with `select:`, otherwise a
 * keyword score: a word in the name counts 3, in the description 1.
 */
export function runToolSearch(input: Record<string, unknown>, catalog: ToolSpec[]): ToolResult {
  const query = String(input.query ?? "").trim();
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number(input.max_results) || DEFAULT_RESULTS));
  let found: ToolSpec[];
  const select = query.toLowerCase().startsWith("select:");
  if (select) {
    // Every name asked for, whatever `max_results` says. A bare tool name
    // loads it from every server that has one.
    const wanted = query.slice("select:".length).split(",").map((s) => s.trim()).filter(Boolean);
    found = wanted.flatMap((w) => {
      const exact = catalog.find((t) => t.name === w);
      return exact ? [exact] : catalog.filter((t) => t.name.endsWith(`__${w}`));
    });
  } else {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const required = words.filter((w) => w.startsWith("+")).map((w) => w.slice(1)).filter(Boolean);
    const terms = words.map((w) => w.replace(/^\+/, "")).flatMap((w) => w.split(/[^a-z0-9]+/)).filter(Boolean);
    found = catalog
      .map((t) => {
        const name = t.name.toLowerCase();
        const text = `${name} ${t.description.toLowerCase()}`;
        if (required.some((r) => !text.includes(r))) return { t, score: 0 };
        const score = terms.reduce((s, w) => s + (name.includes(w) ? 3 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0);
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.t.name < b.t.name ? -1 : 1))
      .map((x) => x.t);
  }
  const distinct = [...new Map(found.map((t) => [t.name, t])).values()];
  const unique = select ? distinct : distinct.slice(0, limit);
  if (unique.length === 0) {
    return { content: `No deferred tool matches "${query}". Deferred tools:\n${catalog.map((t) => t.name).join("\n")}` };
  }
  return {
    content: `Loaded ${unique.length} tool(s): ${unique.map((t) => t.name).join(", ")}`,
    references: unique.map((t) => t.name),
  };
}
