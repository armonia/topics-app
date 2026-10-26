/**
 * HOW THE TOPICS MCP BRIDGE IS LAUNCHED, in a checkout and in the shipped binary.
 *
 * Every agent CLI gets the bridge as a stdio MCP server. The spec used to be
 *
 *     process.execPath  run  <dir>/../mcp/topics-mcp-server.ts  --base-url=…
 *
 * which is right in a checkout (execPath is the Bun running the server) and
 * wrong in the installed app, where the server is a single-file compiled
 * binary. Measured on 2026-10-26 on Windows, Topics 2.3.30: the MCP config read
 *
 *     topics-server.exe  run  B:\~BUN\mcp\topics-mcp-server.ts  --base-url=…
 *
 * A Bun single-file executable ignores that argv and runs its own entry, so
 * the "bridge" was a SECOND Topics server, and the CLI answered every board
 * agent with "MCP tool mcp__topics__approval_prompt not found. Available MCP
 * tools: none". The agent could not read its card nor comment, and the card
 * reached review with an empty branch.
 *
 * Same cure as the ai-bridge daemon (`ai-bridge-daemon-argv.ts`): ask the disk.
 * The script on disk means a checkout; no script means a binary that embeds
 * the bridge and becomes it when given the flag (`server/sidecar-entry.ts`).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The argv[1] that tells the compiled server binary to be the MCP bridge. */
export const TOPICS_MCP_BRIDGE_FLAG = "--topics-mcp-bridge";

/** The bridge script as it sits in a checkout, relative to `server/lib`. */
export const TOPICS_MCP_SCRIPT_REL = "../mcp/topics-mcp-server.ts";

export interface BridgeLaunchDeps {
  /** Directory of the module asking (defaults to this one). */
  moduleDir?: string;
  /** The runtime currently executing us. */
  execPath?: string;
  /** Injected for the test: does this path exist on the real filesystem? */
  exists?: (path: string) => boolean;
}

/** The command line of the stdio bridge: always our own executable. */
export function topicsMcpBridgeLaunch(
  flags: readonly string[],
  deps: BridgeLaunchDeps = {},
): { command: string; args: string[] } {
  const moduleDir = deps.moduleDir ?? import.meta.dir;
  const command = deps.execPath ?? process.execPath;
  const exists = deps.exists ?? existsSync;
  const script = resolve(moduleDir, TOPICS_MCP_SCRIPT_REL);
  if (exists(script)) return { command, args: ["run", script, ...flags] };
  return { command, args: [TOPICS_MCP_BRIDGE_FLAG, ...flags] };
}
