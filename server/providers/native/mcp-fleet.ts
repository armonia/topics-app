/**
 * The MCP fleet as the native runtime sees it: what is mounted RIGHT NOW, what
 * is not, and why.
 *
 * ONE FLEET PER PROCESS, NOT PER TOPIC. The servers come from one global
 * configuration and answer the same tools to everybody, so mounting them once
 * and sharing them is not an optimisation: mounting them per session is how the
 * CLI branch ends up with one Chrome (or one `node`, or one `npx` download) per
 * open topic, which is the cost the native runtime exists to remove.
 *
 * THE PREFIX IS THE CONTRACT. A tool arrives as `mcp__<server>__<tool>`, the
 * same shape the CLI uses, so a prompt, a permission rule or a transcript
 * written for one runtime still reads on the other. It is also what lets the
 * agent loop tell an MCP tool from a native one without keeping a list in sync.
 *
 * A FAILED SERVER IS A STATE, NOT AN EXCEPTION. One server refusing the
 * handshake must not cost the agent the other three, and it must not be
 * invisible either: it stays in the status with the reason, which is what the
 * screen shows.
 */

import { resolveInheritedMcp, type McpServerDef } from "../mcp-inheritance";
import {
  connectMcpServer,
  McpAuthorizationRequiredError,
  type McpConnection,
  type McpToolDescriptor,
} from "./mcp-client";
import { authorizationHeader } from "./mcp-oauth";
import type { ToolSpec, ToolResult } from "./tools";

export const MCP_TOOL_PREFIX = "mcp__";

/** Anthropic accepts `^[a-zA-Z0-9_-]{1,128}$` as a tool name; a server name may not. */
function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitize(server)}__${sanitize(tool)}`.slice(0, 128);
}

/** Is this a tool that came from an MCP server, whatever server that was? */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

// The three shapes of this status are DECLARED IN `shared/session-environment.ts`,
// not here:
// the Settings panel renders them verbatim, and a second declaration on the
// client is exactly the "KEEP IN SYNC" mirror that `tests/unit/no-type-mirrors`
// exists to refuse. Re-exported so this module stays the place you import them
// from on the server side.
export type { McpFleetStatus } from "../../../shared/session-environment";
import type { McpServerStatus, McpFleetStatus } from "../../../shared/session-environment";

interface MountedTool {
  server: string;
  tool: string;
  spec: ToolSpec;
}

let connections = new Map<string, McpConnection>();
let toolsByName = new Map<string, MountedTool>();
let statuses: McpServerStatus[] = [];
let source: string | null = null;
let mountPromise: Promise<void> | null = null;
/**
 * Has a mount RUN to completion, as opposed to "is there a promise".
 *
 * The obvious reading of "still mounting" is `mountPromise && statuses.length
 * === 0`, and it is wrong for the commonest state of all: a machine with NO
 * configured server produces an empty `statuses` on a finished mount, so the
 * screen would sit on "connecting" forever instead of saying, honestly, that
 * there is nothing to connect to.
 */
let mounted = false;

function enabled(): boolean {
  if (process.env.TOPICS_NATIVE_MCP === "0") return false;
  // A TEST MUST NEVER MOUNT THE MACHINE'S REAL FLEET. Any suite that starts a
  // native session would otherwise open the developer's configured servers,
  // spawn their stdio processes and talk to their remote endpoints, which is a
  // test that reads the world instead of the code. A test that DOES want a
  // fleet says so by pointing `TOPICS_MCP_CONFIG_FILE` at its own config.
  if (process.env.NODE_ENV === "test" && !process.env.TOPICS_MCP_CONFIG_FILE) return false;
  return true;
}

/**
 * A server whose token comes out of the OAuth store, looked up by NAME.
 *
 * Built per mount and not held anywhere: both calls read the store from disk,
 * so a sign-in that completes while the fleet is up is visible to the very next
 * request without anything having to be invalidated.
 */
function authFor(name: string) {
  return {
    header: () => authorizationHeader(name),
    refreshed: () => authorizationHeader(name, { forceRefresh: true }),
  };
}

async function mountOne(name: string, def: McpServerDef): Promise<void> {
  try {
    const conn = await connectMcpServer(name, def, authFor(name));
    const [tools, prompts] = await Promise.all([conn.listTools(), conn.listPrompts()]);
    connections.set(name, conn);
    const mountedNames: string[] = [];
    for (const t of tools) {
      if (!t?.name) continue;
      const full = mcpToolName(name, t.name);
      toolsByName.set(full, {
        server: name,
        tool: t.name,
        spec: {
          name: full,
          description: t.description || `${t.name} (MCP server ${name})`,
          input_schema: normalizeSchema(t.inputSchema),
        },
      });
      mountedNames.push(full);
    }
    statuses.push({
      name,
      transport: conn.transport,
      state: "ready",
      tools: mountedNames,
      skills: prompts.map((p) => p.name).filter(Boolean),
    });
  } catch (err) {
    // WAITING FOR A SIGN-IN IS NOT A FAULT, and the difference is the whole
    // point of the state: `failed` sends a person looking for a broken server,
    // while this one has a button that fixes it. The reason is fixed wording
    // and never the error, because the error came off the wire and this string
    // is rendered.
    const needsAuth = err instanceof McpAuthorizationRequiredError;
    statuses.push({
      name,
      transport: (def as { type?: string }).type === "stdio" || !(def as { url?: string }).url ? "stdio" : "http",
      state: needsAuth ? "needs-auth" : "failed",
      tools: [],
      skills: [],
      reason: needsAuth
        ? "This server requires sign-in before it can be used."
        : err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * An MCP schema that the Anthropic API will accept.
 *
 * A server is free to answer `tools/list` with a schema that has no
 * `properties`, or none at all. The API refuses that, and it refuses the whole
 * request, so one sloppy server would take down every turn of every session
 * instead of just its own tool.
 */
function normalizeSchema(schema: unknown): ToolSpec["input_schema"] {
  const s = (schema ?? {}) as { type?: string; properties?: Record<string, unknown>; required?: unknown };
  return {
    type: "object",
    properties: (s.properties as Record<string, unknown>) ?? {},
    ...(Array.isArray(s.required) ? { required: s.required.map(String) } : {}),
  };
}

async function mountFleet(): Promise<void> {
  connections = new Map();
  toolsByName = new Map();
  statuses = [];
  mounted = false;
  const resolved = resolveInheritedMcp();
  source = resolved.source;
  for (const e of resolved.excluded) {
    statuses.push({ name: e.name, transport: null, state: "excluded", tools: [], skills: [], reason: e.detail });
  }
  // `servers === null` means "do not scope": the CLI reads that as "stay
  // additive and let the host load everything". The native runtime has no host
  // loading anything, so the honest reading here is the whole configured set.
  const toMount = resolved.servers ?? {};
  await Promise.all(Object.entries(toMount).map(([name, def]) => mountOne(name, def)));
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  mounted = true;
}

/**
 * Mount the fleet if it is not mounted yet, and wait for it.
 *
 * Idempotent and shared: N sessions starting a turn at the same moment produce
 * one mount, not N.
 */
export function ensureMcpFleet(): Promise<void> {
  if (!enabled()) return Promise.resolve();
  if (!mountPromise) mountPromise = mountFleet().catch(() => { /* a fleet that fails is an empty fleet */ });
  return mountPromise;
}

/** Drop every connection and mount again: used by the screen's refresh. */
export async function remountMcpFleet(): Promise<void> {
  for (const conn of connections.values()) {
    try { conn.close(); } catch { /* already gone */ }
  }
  mountPromise = null;
  await ensureMcpFleet();
}

/**
 * The tool schemas to append to the native registry. Empty until mounted.
 *
 * SORTED, and COPIES. Both words earn their keep once the list can change
 * while the process runs.
 *
 * Sorted, because a re-list deletes a server's entries and puts them back,
 * which moves them to the end of the Map's insertion order. The serialized
 * array would then differ even when the set is identical, and the order of
 * `params.tools` is the FIRST cache breakpoint of the prefix: a session would
 * pay a full cache miss for having gained nothing.
 *
 * Copies, because `applyPromptCache` marks the last tool IN PLACE. Handing out
 * the stored objects means that marker sticks to the fleet itself, so every
 * later read carries it and the breakpoints pile up round after round until
 * the API refuses the whole turn for exceeding the cap.
 */
export function mcpToolSpecs(): ToolSpec[] {
  return [...toolsByName.values()]
    .map((t) => ({ ...t.spec }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Re-list ONE server, in place, without touching the others.
 *
 * This is what makes a tool mounted at runtime reachable. A gateway that
 * mounts a child on the agent's request grows its own tool list, and the
 * fleet used to hold the photograph taken at mount time: the agent called the
 * new tool and read `unknown MCP tool` for something the server really offered.
 *
 * Deliberately NOT `remountMcpFleet()`, which is a hammer: that one closes
 * every connection and empties both maps before refilling them, so for the
 * whole rebuild any other session's tool call answers `unknown MCP tool` for
 * the ENTIRE fleet, and every stdio server pays its cold start again.
 */
export async function relistMcpServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (!conn) return;
  let tools: McpToolDescriptor[];
  try {
    tools = await conn.listTools();
  } catch {
    // The tool call itself succeeded; a stale list beats an empty one.
    return;
  }
  // Re-read the connection NOW, not from the closure: a refresh may have
  // replaced the maps while we were awaiting, and this answer would then
  // belong to a connection that is already dead.
  if (connections.get(name) !== conn) return;

  // One synchronous pass, so no reader can observe a half-empty map.
  for (const [full, entry] of [...toolsByName.entries()]) {
    if (entry.server === name) toolsByName.delete(full);
  }
  const mountedNames: string[] = [];
  for (const t of tools) {
    if (!t?.name) continue;
    const full = mcpToolName(name, t.name);
    toolsByName.set(full, {
      server: name,
      tool: t.name,
      spec: {
        name: full,
        description: t.description || `${t.name} (MCP server ${name})`,
        input_schema: normalizeSchema(t.inputSchema),
      },
    });
    mountedNames.push(full);
  }
  const status = statuses.find((st) => st.name === name);
  // The settings panel is the second surface that used to go quiet: it kept
  // showing the boot list and still said `ready`.
  if (status) status.tools = mountedNames;
}

export function mcpFleetStatus(): McpFleetStatus {
  return {
    enabled: enabled(),
    mounting: Boolean(mountPromise) && !mounted,
    source,
    servers: statuses,
  };
}

/**
 * Run one MCP tool.
 *
 * Never throws: the agent loop turns a result into a `tool_result` block, and an
 * exception here would kill a turn for a server that was merely down. The agent
 * reads the reason and can go another way.
 */
export async function executeMcpTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const mounted = toolsByName.get(name);
  if (!mounted) {
    return { content: `unknown MCP tool: ${name}`, isError: true };
  }
  const conn = connections.get(mounted.server);
  if (!conn) return { content: `MCP server '${mounted.server}' is not connected`, isError: true };
  try {
    const out = await conn.callTool(mounted.tool, input);
    // A SUCCESSFUL call may have changed this server's own tool list: that is
    // exactly what a gateway does when the agent asks it to mount a child.
    //
    // The predicate is the server's DECLARATION, not a list of tool names that
    // mount things: such a list rots the moment a server gains a new one.
    //
    // Serialized on purpose, not fire-and-forget. The guarantee worth giving is
    // that when the mounting tool RETURNS, its new tools are already callable:
    // a dispatched agent has one turn, and the difference between deterministic
    // and eventually is the difference between works and does not.
    if (!out.isError && conn.listChanged) await relistMcpServer(mounted.server);
    return { content: out.content, isError: out.isError };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Close everything: the server is shutting down. */
export function closeMcpFleet(): void {
  for (const conn of connections.values()) {
    try { conn.close(); } catch { /* already gone */ }
  }
  connections = new Map();
  toolsByName = new Map();
  mountPromise = null;
  mounted = false;
}
