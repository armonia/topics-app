/**
 * shared/session-environment.ts - what a session INHERITS, as a screen shows it:
 * the MCP fleet that mounted, plus the hooks, commands and permission rules that
 * came with it.
 *
 * WHY it is not in `shared/types.ts`. That file is the app's shared vocabulary
 * and `check:bloat` caught it 31 lines over its ceiling: these 114 lines are one
 * feature's own contract (`server/lib/session-environment.ts`,
 * `server/providers/native/mcp-fleet.ts`, and the two Settings panels), landed
 * whole in a single task. Kept there they were a feature parked in the hallway.
 */

/**
 * What happened to one globally configured MCP server, as the screen shows it.
 *
 * `excluded` is not a failure: an inheritance rule dropped the server on
 * purpose (see `server/providers/mcp-inheritance.ts`), and `reason` carries the
 * rule that did it. `failed` is a server that was meant to be there and did not
 * answer the handshake, and `reason` is then the connection error.
 *
 * `needs-auth` is not a failure either, and separating it from `failed` is what
 * makes the panel actionable. A remote server protected by OAuth answers the
 * first handshake with `401` and a challenge: nothing is broken, nobody has
 * signed in yet, and the cure is a button rather than a bug report.
 */
export type McpServerState = 'ready' | 'failed' | 'excluded' | 'needs-auth';

export interface McpServerStatus {
  name: string;
  transport: 'http' | 'stdio' | null;
  state: McpServerState;
  /** Prefixed tool names, exactly as the model sees them. */
  tools: string[];
  /** What the server exposes besides tools (MCP prompts), by name. */
  skills: string[];
  /** Why it is not there: the connection error, or the inheritance rule. */
  reason?: string;
}

/**
 * The answer of `GET /api/mcp/fleet`, which is also the whole content of the
 * mounted-tools panel in Settings.
 */
export interface McpFleetStatus {
  /** False when the native MCP client is switched off (TOPICS_NATIVE_MCP=0). */
  enabled: boolean;
  /** True while the first mount is still in flight. */
  mounting: boolean;
  /** The config the fleet was read from. */
  source: string | null;
  servers: McpServerStatus[];
}

/**
 * WHAT THIS SESSION INHERITED, as one payload.
 *
 * A Topics chat spawns the real CLI with `--setting-sources user,project,local`,
 * so the hooks, skills, custom commands, MCP servers and permission rules
 * written under `~/.claude` and under the project are ALREADY in force. They
 * were simply invisible: the only way to know what a session had was to go and
 * read those files by hand, and when something did not work (a server that does
 * not answer, a skill that does not load) there was no screen to look at.
 *
 * Every entry carries the FILE it came from, because "which of the four files
 * wins" is the question people actually have.
 */
export type SessionEnvSource = 'user' | 'project' | 'local' | 'topics';

export interface SessionEnvMcpServer {
  name: string;
  transport: 'http' | 'stdio' | null;
  /** Written into the session config, or dropped by a rule. */
  state: 'mounted' | 'excluded';
  /** The bridge Topics wires itself, against a server of the user's config. */
  origin: 'bridge' | 'inherited';
  /** How it starts: command line or url, with anything secret-looking masked. */
  detail: string | null;
  /** Why it is not there: the inheritance rule, or the session's scoping. */
  reason?: string;
}

export interface SessionEnvHook {
  /** PreToolUse, PostToolUse, Stop, SessionStart... whatever the file says. */
  event: string;
  /** Which tools it fires on, when the entry says so. */
  matcher: string | null;
  command: string;
  source: SessionEnvSource;
  file: string;
}

export interface SessionEnvCommand {
  name: string;
  kind: 'command' | 'skill';
  file: string;
  description: string | null;
}

export interface SessionEnvPermissionRule {
  effect: 'allow' | 'deny' | 'ask';
  rule: string;
  source: SessionEnvSource;
  file: string;
}

export interface SessionEnvSettingsFile {
  path: string;
  source: SessionEnvSource;
  exists: boolean;
}

export interface SessionEnvironment {
  /** The provider the topic runs on, as the topic has it. */
  provider: string | null;
  /**
   * False when this runtime does NOT read the user's setting sources (the
   * native loop). The screen then says so instead of showing a list that is
   * true for a different engine.
   */
  inherits: boolean;
  mcp: {
    /** 'bridge-only' is the dispatched-agent scoping (migration 049). */
    policy: 'inherit' | 'bridge-only';
    /** The session config is the complete set (`--strict-mcp-config`). */
    strict: boolean;
    /** The file the inherited fleet was read from. */
    source: string | null;
    servers: SessionEnvMcpServer[];
  };
  hooks: SessionEnvHook[];
  /** Custom commands and skills together: the list is one, the kind separates. */
  commands: SessionEnvCommand[];
  permissions: {
    mode: string | null;
    rules: SessionEnvPermissionRule[];
  };
  /** The files read to produce this answer, so the screen can point at them. */
  settingsFiles: SessionEnvSettingsFile[];
}
