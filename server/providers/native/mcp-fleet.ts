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
import { connectMcpServer, type McpConnection } from "./mcp-client";
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

export type McpServerState = "ready" | "failed" | "excluded";

export interface McpServerStatus {
  name: string;
  transport: "http" | "stdio" | null;
  state: McpServerState;
  /** Prefixed tool names, exactly as the model sees them. */
  tools: string[];
  /** What the server exposes besides tools (MCP prompts), by name. */
  skills: string[];
  /** Why it is not there: the connection error, or the inheritance rule. */
  reason?: string;
}

export interface McpFleetStatus {
  /** False when the native MCP client is switched off (TOPICS_NATIVE_MCP=0). */
  enabled: boolean;
  /** True while the first mount is still in flight. */
  mounting: boolean;
  /** The config the fleet was read from. */
  source: string | null;
  servers: McpServerStatus[];
}

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

function enabled(): boolean {
  return process.env.TOPICS_NATIVE_MCP !== "0";
}

async function mountOne(name: string, def: McpServerDef): Promise<void> {
  try {
    const conn = await connectMcpServer(name, def);
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
    statuses.push({
      name,
      transport: (def as { type?: string }).type === "stdio" || !(def as { url?: string }).url ? "stdio" : "http",
      state: "failed",
      tools: [],
      skills: [],
      reason: err instanceof Error ? err.message : String(err),
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

/** The tool schemas to append to the native registry. Empty until mounted. */
export function mcpToolSpecs(): ToolSpec[] {
  return [...toolsByName.values()].map((t) => t.spec);
}

export function mcpFleetStatus(): McpFleetStatus {
  return {
    enabled: enabled(),
    mounting: Boolean(mountPromise) && statuses.length === 0,
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
}
