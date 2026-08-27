/**
 * WHAT A SESSION INHERITED, collected in one read.
 *
 * THE SILENCE THIS REPLACES. Topics does not reimplement hooks, skills, custom
 * commands or permission rules: it spawns the real CLI with
 * `--setting-sources user,project,local`, so everything written under
 * `~/.claude` and under the project is already in force. The consequence
 * nobody had a screen for is that a chat inherits a whole environment and
 * shows none of it. When a server does not answer, or a hook fires and nobody
 * knows which file declared it, the only way to find out was to open four
 * files by hand and work out which one wins.
 *
 * READ-ONLY, ON PURPOSE. This module never writes a settings file. Changing
 * the user's global configuration from the app is a separate decision with a
 * separate blast radius: showing what is there is already the answer to
 * "why is this tool missing".
 *
 * SECRETS DO NOT COME OUT. An MCP definition carries `env` blocks and tokens in
 * argv or in a url query. None of that reaches the payload: `detail` is the
 * command line with anything secret-looking masked, and `env` is never copied.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  SessionEnvCommand,
  SessionEnvHook,
  SessionEnvMcpServer,
  SessionEnvPermissionRule,
  SessionEnvSettingsFile,
  SessionEnvSource,
  SessionEnvironment,
} from "../../shared/types";
import { resolveInheritedMcp, type McpServerDef } from "../providers/mcp-inheritance";
import { listSlashCommandFiles } from "./slash-command-source";

export interface SessionEnvironmentOptions {
  home?: string;
  cwd?: string;
  /** `topics.mcp_policy` (migration 049): 'bridge-only' scopes the fleet away. */
  mcpPolicy?: string | null;
  provider?: string | null;
  /**
   * Topics installs its OWN PreToolUse guard on dispatched sessions
   * (`blockImageReads` in providers/claude/args.ts). It is a hook that fires in
   * this session, so it belongs in the list, marked as ours: a hook the app
   * added and did not declare is exactly the kind of thing people go looking
   * for in their own files.
   */
  topicsGuard?: boolean;
}

/** The providers that spawn the CLI, hence the ones that inherit the files. */
const INHERITING_PROVIDERS = new Set(["claude-code", "claude-code-team"]);

export function providerInherits(provider: string | null | undefined): boolean {
  return provider == null || INHERITING_PROVIDERS.has(provider);
}

/** Read at most this much of a settings or command file. */
const MAX_FILE_BYTES = 512 * 1024;
/** How many command/skill files to open for their description. */
const MAX_DESCRIBED_COMMANDS = 200;
/** One line on a screen: longer than this is noise, not information. */
const MAX_DETAIL_CHARS = 200;

type Json = Record<string, unknown>;

function readJson(file: string): Json | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    // Absent, unreadable or invalid JSON: the file still shows up in
    // `settingsFiles`, so the screen can say "there is nothing here" instead of
    // pretending the file was never considered.
    return null;
  }
}

/** The settings files the CLI reads, in the order that decides who wins. */
export function settingsFilesFor(home: string, cwd: string): SessionEnvSettingsFile[] {
  const files: Array<{ path: string; source: SessionEnvSource }> = [
    { path: join(home, ".claude", "settings.json"), source: "user" },
    { path: join(cwd, ".claude", "settings.json"), source: "project" },
    { path: join(cwd, ".claude", "settings.local.json"), source: "local" },
  ];
  return files.map((f) => ({ ...f, exists: existsSync(f.path) }));
}

const SECRET_KEY_RE = /(token|key|secret|password|passwd|auth|credential)/i;

/**
 * One argv entry, safe to print. A `--gateway-token=abc` in the config of a
 * server is a real credential, and this payload goes to a browser.
 */
function maskArg(arg: string): string {
  const eq = arg.indexOf("=");
  if (eq > 0 && SECRET_KEY_RE.test(arg.slice(0, eq))) return `${arg.slice(0, eq)}=***`;
  return arg;
}

/**
 * A url without its query. Tokens travel in query strings often enough that
 * keeping the query would defeat the masking above.
 */
function maskUrl(raw: string): string {
  const cut = raw.indexOf("?");
  return cut >= 0 ? `${raw.slice(0, cut)}?***` : raw;
}

function truncate(s: string): string {
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS - 1)}\u2026` : s;
}

function transportOf(def: McpServerDef): "http" | "stdio" | null {
  const type = typeof def.type === "string" ? def.type : null;
  if (type === "http" || type === "sse") return "http";
  if (type === "stdio") return "stdio";
  if (typeof def.url === "string") return "http";
  if (typeof def.command === "string") return "stdio";
  return null;
}

/** How the server starts, in one printable line, with the secrets masked. */
function detailOf(def: McpServerDef): string | null {
  if (typeof def.url === "string") return truncate(maskUrl(def.url));
  if (typeof def.command === "string") {
    const args = Array.isArray(def.args) ? def.args.map((a) => maskArg(String(a))) : [];
    return truncate([def.command, ...args].join(" "));
  }
  return null;
}

function collectHooks(settings: Json, source: SessionEnvSource, file: string): SessionEnvHook[] {
  const out: SessionEnvHook[] = [];
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, entries] of Object.entries(hooks as Json)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof e.matcher === "string" && e.matcher.length > 0 ? e.matcher : null;
      const list = Array.isArray(e.hooks) ? e.hooks : [];
      for (const h of list) {
        if (!h || typeof h !== "object") continue;
        const command = (h as { command?: unknown }).command;
        if (typeof command !== "string") continue;
        out.push({ event, matcher, command: truncate(command), source, file });
      }
    }
  }
  return out;
}

const EFFECTS: Array<{ key: string; effect: SessionEnvPermissionRule["effect"] }> = [
  { key: "allow", effect: "allow" },
  { key: "deny", effect: "deny" },
  { key: "ask", effect: "ask" },
];

function collectPermissions(
  settings: Json,
  source: SessionEnvSource,
  file: string,
): { rules: SessionEnvPermissionRule[]; mode: string | null } {
  const perms = settings.permissions;
  if (!perms || typeof perms !== "object") return { rules: [], mode: null };
  const p = perms as Json;
  const rules: SessionEnvPermissionRule[] = [];
  for (const { key, effect } of EFFECTS) {
    const list = p[key];
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (typeof rule === "string" && rule.length > 0) rules.push({ effect, rule: truncate(rule), source, file });
    }
  }
  const mode = typeof p.defaultMode === "string" ? p.defaultMode : null;
  return { rules, mode };
}

/** The `description:` of a command or skill, from its front matter. */
function describeCommandFile(file: string): string | null {
  try {
    const head = readFileSync(file, "utf-8").slice(0, 4096);
    const m = head.match(/^description:\s*(.+)$/m);
    if (!m) return null;
    return truncate(m[1].trim().replace(/^["']|["']$/g, ""));
  } catch {
    return null;
  }
}

/**
 * The MCP servers this session gets, and the ones it does not, with the reason.
 * Mirrors `writeMcpConfigForSession`: the topics bridge is always there, and a
 * 'bridge-only' policy leaves nothing else.
 */
function collectMcp(
  mcpPolicy: string | null | undefined,
): SessionEnvironment["mcp"] {
  const bridgeOnly = mcpPolicy === "bridge-only";
  const { servers, excluded, source } = resolveInheritedMcp();
  const bridge: SessionEnvMcpServer = {
    name: "topics",
    transport: "stdio",
    state: "mounted",
    origin: "bridge",
    detail: bridgeOnly ? "topics bridge (dispatch tool profile)" : "topics bridge",
  };
  const out: SessionEnvMcpServer[] = [bridge];
  if (bridgeOnly) {
    // The dispatched-agent scoping: every inherited server is out, and the
    // reason is the policy, not a failure of that server.
    for (const name of Object.keys(servers ?? {})) {
      out.push({
        name,
        transport: null,
        state: "excluded",
        origin: "inherited",
        detail: null,
        reason: "this session is scoped to the topics bridge (mcp_policy=bridge-only)",
      });
    }
  } else {
    for (const [name, def] of Object.entries(servers ?? {})) {
      out.push({
        name,
        transport: transportOf(def),
        state: "mounted",
        origin: "inherited",
        detail: detailOf(def),
      });
    }
  }
  for (const e of excluded) {
    out.push({
      name: e.name,
      transport: null,
      state: "excluded",
      origin: "inherited",
      detail: null,
      reason: e.detail,
    });
  }
  return {
    policy: bridgeOnly ? "bridge-only" : "inherit",
    // `--strict-mcp-config` goes on when we managed to scope, which is exactly
    // when the resolver returned a set. `servers === null` means "do not scope"
    // and the CLI then stays additive.
    strict: bridgeOnly || servers !== null,
    source,
    servers: out,
  };
}

/**
 * The guard Topics itself installs on dispatched sessions, as a hook row. It is
 * declared here rather than imported as the command string because the payload
 * wants one readable line, not the shell one-liner that implements it.
 */
const TOPICS_GUARD_HOOK: SessionEnvHook = {
  event: "PreToolUse",
  matcher: "Read",
  command: "topics: refuse reading images and video into the context",
  source: "topics",
  file: "server/providers/claude/args.ts",
};

export function resolveSessionEnvironment(opts: SessionEnvironmentOptions = {}): SessionEnvironment {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const provider = opts.provider ?? null;
  const inherits = providerInherits(provider);

  const settingsFiles = settingsFilesFor(home, cwd);
  const hooks: SessionEnvHook[] = [];
  const rules: SessionEnvPermissionRule[] = [];
  let mode: string | null = null;
  if (inherits) {
    if (opts.topicsGuard) hooks.push(TOPICS_GUARD_HOOK);
    for (const f of settingsFiles) {
      if (!f.exists) continue;
      const settings = readJson(f.path);
      if (!settings) continue;
      hooks.push(...collectHooks(settings, f.source, f.path));
      const perms = collectPermissions(settings, f.source, f.path);
      rules.push(...perms.rules);
      // Last file wins, which is the CLI's own precedence: local over project
      // over user.
      if (perms.mode) mode = perms.mode;
    }
  }

  const commands: SessionEnvCommand[] = inherits
    ? listSlashCommandFiles({ home, cwd })
        .slice(0, MAX_DESCRIBED_COMMANDS)
        .map((c) => ({ name: c.name, kind: c.kind, file: c.file, description: describeCommandFile(c.file) }))
    : [];

  return {
    provider,
    inherits,
    mcp: inherits
      ? collectMcp(opts.mcpPolicy)
      : { policy: "inherit", strict: false, source: null, servers: [] },
    hooks,
    commands,
    permissions: { mode, rules },
    settingsFiles,
  };
}
