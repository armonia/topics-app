/**
 * WHICH global MCP servers a Topics session inherits, and WHY the others are not
 * there.
 *
 * ONE RULE, TWO RUNTIMES. This used to live inside `claude-code.ts`, on the CLI
 * branch only, and that is precisely how the native runtime ended up with no
 * MCP at all: the policy was written where only one host could reach it. A
 * second copy for the native loop would answer the same question in two places
 * and drift on the first fix, so the policy moved here and both hosts read it.
 *
 * THE EXCLUSIONS ARE PART OF THE ANSWER, not a side effect. Before this file a
 * dropped server left a single line on the server's stdout, which nobody sees:
 * a tool that is missing without an explanation is indistinguishable from a
 * bug, and people go looking for it in the wrong place. `resolveInheritedMcp`
 * returns the excluded names WITH the reason so a screen can show them.
 *
 * Overrides stay in the environment (no code change, no rebuild):
 *   TOPICS_SESSION_MCP_INHERIT_ALL=1 -> legacy: inherit everything, no scoping
 *   TOPICS_SESSION_MCP_ALLOW="a,b"   -> allowlist (these only)
 *   TOPICS_SESSION_MCP_DENY="x,y"    -> inherit all EXCEPT these
 *   TOPICS_SESSION_MCP_COLDBOOT_OK=1 -> keep the cold-boot servers too
 *   TOPICS_MCP_CONFIG_FILE=<path>    -> read that config instead of ~/.claude.json
 */

import { readFileSync } from "fs";
import { join } from "path";

/** A server definition, copied verbatim so it is mounted/spawned identically. */
export type McpServerDef = Record<string, unknown>;

/**
 * Default-deny: chrome-devtools spawns a real ~1.2GB Chrome per session, it is
 * redundant with the browser Topics already drives, and it is the single
 * heaviest idle offender.
 */
const DEFAULT_DENY_MCP = new Set(["chrome-devtools"]);

/** Why a globally configured server is NOT mounted. */
export type McpExclusionReason = "deny" | "allowlist" | "cold-boot";

export interface McpExclusion {
  name: string;
  reason: McpExclusionReason;
  /** One readable line: this is what a person reads on the screen. */
  detail: string;
}

export interface ResolvedMcpFleet {
  /**
   * The servers to mount, or `null` when we must NOT scope at all
   * (`TOPICS_SESSION_MCP_INHERIT_ALL=1`, no HOME, unreadable config). The CLI
   * then stays additive and loses nothing; the native runtime mounts nothing,
   * because it has no ambient fleet to stay additive with.
   */
  servers: Record<string, McpServerDef> | null;
  excluded: McpExclusion[];
  /** The file the answer came from, for the screen. */
  source: string | null;
}

/**
 * A server that COLD-BOOTS on every spawn does not belong in a long working
 * session, and the rule is structural, not a list of names.
 *
 * A `stdio` server launched with `npx -y <pkg>` (or `npm exec -y`, or `bunx`)
 * resolves and downloads the package on every start: it is cold-boot by
 * construction, and fragile for the same reason. When that process dies the
 * host drops its tools from the schema and then puts them back, and every such
 * round changes the PREFIX of the prompt. A prefix that changes has to be
 * written to cache in full, and in an agentic session the cache is 96% of the
 * volume read.
 *
 * Measured on the armonia-site transcript (275 answers): 8 requests, 2.9% of
 * them, carry 85% of ALL the cache writes of the session, 1.97M tokens for
 * ~$20-33. They are the 8 that follow a tool-set removal, and the server that
 * moved was the only global one matching this rule: the others are `http` (no
 * boot at all) or `node` on a local path.
 *
 * The chats lose nothing unique: web search stays available through the `http`
 * search server and the native WebSearch/WebFetch. To put an excluded server
 * back: `TOPICS_SESSION_MCP_ALLOW="<name>,…"` (the allowlist wins) or
 * `TOPICS_SESSION_MCP_COLDBOOT_OK=1` to switch the rule off wholesale.
 */
export function isColdBootServer(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const d = def as { type?: string; command?: string; args?: unknown };
  // stdio only: an http server has no process to restart.
  if (d.type && d.type !== "stdio") return false;
  const cmd = (d.command || "").split("/").pop() || "";
  if (!/^(npx|bunx|pnpx)$/.test(cmd) && !(cmd === "npm" && Array.isArray(d.args) && d.args.includes("exec"))) {
    return false;
  }
  // `npx pkg` without `-y` stops to ask for confirmation and never starts at
  // all: the auto-confirm flag is what makes the download silent, hence repeated.
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  return args.includes("-y") || args.includes("--yes");
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The global config file the fleet is read from, or null when there is none. */
export function globalMcpConfigPath(): string | null {
  const override = process.env.TOPICS_MCP_CONFIG_FILE;
  if (override) return override;
  const home = process.env.HOME;
  return home ? join(home, ".claude.json") : null;
}

/**
 * Resolve which GLOBAL MCP servers a Topics session should inherit, and why the
 * rest are out. Server definitions are copied verbatim so they mount
 * identically to the way the user configured them.
 */
export function resolveInheritedMcp(): ResolvedMcpFleet {
  const path = globalMcpConfigPath();
  if (process.env.TOPICS_SESSION_MCP_INHERIT_ALL === "1") {
    return { servers: null, excluded: [], source: path };
  }
  if (!path) return { servers: null, excluded: [], source: null };
  let global: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, unknown> };
    global = (parsed && typeof parsed === "object" && parsed.mcpServers) || {};
  } catch {
    return { servers: null, excluded: [], source: path }; // unreadable -> don't risk stripping tools
  }
  const allow = parseCsvEnv("TOPICS_SESSION_MCP_ALLOW");
  const deny = new Set([...parseCsvEnv("TOPICS_SESSION_MCP_DENY"), ...DEFAULT_DENY_MCP]);
  const coldBootOk = process.env.TOPICS_SESSION_MCP_COLDBOOT_OK === "1";
  const excluded: McpExclusion[] = [];
  const servers: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(global)) {
    if (name === "topics") continue; // our own bridge is wired by the host, not inherited
    if (allow.length > 0) {
      if (allow.includes(name)) servers[name] = def as McpServerDef;
      else excluded.push({ name, reason: "allowlist", detail: "not in TOPICS_SESSION_MCP_ALLOW" });
    } else if (deny.has(name)) {
      excluded.push({ name, reason: "deny", detail: "in the exclusion list (TOPICS_SESSION_MCP_DENY)" });
    } else if (!coldBootOk && isColdBootServer(def)) {
      excluded.push({
        name,
        reason: "cold-boot",
        detail: "restarts on every spawn and invalidates the prompt cache (TOPICS_SESSION_MCP_COLDBOOT_OK=1 keeps it)",
      });
    } else {
      servers[name] = def as McpServerDef;
    }
  }
  return { servers, excluded, source: path };
}
