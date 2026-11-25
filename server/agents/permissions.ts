/**
 * What the channel engine actually applies for one agent (AGENTS-NAV-01),
 * read-only: the `policy` module path `engine.json` names (and its text when
 * readable), the global `owners`/`trusted` lists from `config.json`, and the
 * per-chat `senders`/`denied`/mention rules already resolved to their owning
 * agent by `readRegistry` (same source `server/routes/agent-config.ts` uses
 * to show and edit them — this module only shows, never edits).
 *
 * No configuration = empty lists, never a throw: the same contract as
 * `readAgents` in `./registry`.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readJson } from "./config-files";
import { readRegistry, type Paths } from "../routes/agent-config";

export interface ChatPermission {
  channel: string;
  chat: string;
  account: string;
  mention: boolean;
  senders: string[];
  denied: string[];
}

export interface AgentPermissions {
  policy: { path: string; rules: string | null };
  owners: string[];
  trusted: string[];
  chats: ChatPermission[];
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The module path `engine.json`'s `policy` names, and its text when the file is readable. */
function readPolicy(home: string, expand: (p: string) => string): { path: string; rules: string | null } {
  const engineFile = join(home, "engine.json");
  if (!existsSync(engineFile)) return { path: "", rules: null };
  let engine: Record<string, unknown>;
  try {
    engine = readJson(engineFile) as Record<string, unknown>;
  } catch {
    return { path: "", rules: null };
  }
  const path = typeof engine.policy === "string" ? engine.policy : "";
  if (!path) return { path: "", rules: null };
  const expanded = expand(path);
  try {
    return { path, rules: existsSync(expanded) ? readFileSync(expanded, "utf8") : null };
  } catch {
    return { path, rules: null };
  }
}

/** Every permission the engine applies for `agentId` — an unknown agent gets no chats, but still the global owners/trusted. */
export function readAgentPermissions(paths: Paths, agentId: string): AgentPermissions {
  const policy = readPolicy(paths.home, paths.expand);
  const cfgFile = join(paths.home, "config.json");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgFile)) {
    try {
      cfg = readJson(cfgFile) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  const owners = stringList(cfg.owners);
  const trusted = stringList(cfg.trusted);
  let chats: ChatPermission[] = [];
  if (existsSync(cfgFile) && existsSync(join(paths.home, "engine.json"))) {
    try {
      const { agents } = readRegistry(paths);
      const agent = agents.find((a) => a.id === agentId);
      chats = (agent?.chats ?? [])
        .filter((c) => c.chat !== "*")
        .map((c) => ({ channel: c.channel, chat: c.chat, account: c.account, mention: c.mention, senders: c.senders, denied: c.denied }));
    } catch {
      chats = [];
    }
  }
  return { policy, owners, trusted, chats };
}
