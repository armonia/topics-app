/**
 * Agents registry: one card per always-on agent, built from the files
 * jarvis-channels runs on, and the few edits made there. The agents
 * themselves (id, name, workspace) are not listed here: they are read from
 * `engine.json`'s `agents.<id>.workspace`, see `server/agents/registry.ts`.
 *
 *   GET  /api/agent-config              → { agents, health, issues }
 *   GET  /api/agent-config/persona?agent=<id> → the assembled persona (base
 *                                               → user → identity → agent),
 *                                               with the token weight of
 *                                               each layer — see
 *                                               `server/agents/persona.ts`
 *   POST /api/agent-config/chat         { channel, chat, account?, active?, mention? }
 *   POST /api/agent-config/job          { id, paused }
 *   POST /api/agent-config/persona      { agent, file: "IDENTITY.md"|"SOUL.md", text }
 *
 * Every write: validate, copy the file to backups/<name>.<stamp> first, write
 * atomically (tmp + rename). jobs.json is watched by the service (mtime); the
 * personality is read at each turn; config.json is read only at start, so a
 * chat edit restarts the service, but only when no turn is in flight
 * (inflight.json empty), otherwise it says it applies at the next restart.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runBounded } from "../lib/bounded-spawn";
import { readIdentity, registryHome } from "../agents/registry";
import { readJson as readJsonFile, safeWrite } from "../agents/config-files";
import { assemblePersona } from "../agents/persona";
import type { RegistryIssue } from "../../shared/agents-health";
import type { AppContext, RouteHandler } from "../types";

export type AgentId = string;
export const PERSONA_FILES = ["IDENTITY.md", "SOUL.md"] as const;


export interface Paths { home: string; expand: (p: string) => string }
/** Same home as `/api/agents` (`registryHome`): the two routes must always
 *  agree on where the agents live. */
export function defaultPaths(env: Record<string, string | undefined> = process.env): Paths {
  return { home: registryHome(env), expand: (p) => p.replace(/^~(?=\/|$)/, homedir()) };
}

type Json = Record<string, any>;
const readJson = (p: string): any => readJsonFile(p);

const ruleSource = (g: Json): string => `config.json rules.groups (account ${g.account ?? "default"}, mention ${!!g.mention}, active ${!!g.active})`;

/** The registry: everything an agent is, read from config.json, engine.json, jobs.json and its workspace. */
export function readRegistry(paths: Paths) {
  const cfg: Json = readJson(join(paths.home, "config.json"));
  const engine: Json = existsSync(join(paths.home, "engine.json")) ? readJson(join(paths.home, "engine.json")) : {};
  const jobs: Json[] = existsSync(join(paths.home, "jobs.json")) ? readJson(join(paths.home, "jobs.json")) : [];
  const rules: Json = cfg.rules ?? {};
  const groups: Json[] = rules.groups ?? [];
  const routes: Json[] = rules.agents ?? [];
  const issues: RegistryIssue[] = [];

  const ids = (Object.keys(engine.agents ?? {}) as AgentId[]).filter((id) => !!engine.agents[id]?.workspace);
  // Which account belongs to which agent, and who takes everything no agent
  // claims (`engine.agents.<id>.account`, optional). The first agent with
  // none declared is the default.
  const accountOwners = new Map<string, AgentId>();
  let defaultAgent: AgentId | null = null;
  for (const id of ids) {
    const owned = engine.agents[id]?.account;
    if (owned) accountOwners.set(owned, id);
    else if (!defaultAgent) defaultAgent = id;
  }
  defaultAgent ??= ids[0] ?? "";
  const agentOfAccount = (acc: string | undefined): AgentId =>
    acc && accountOwners.has(acc) ? accountOwners.get(acc)! : defaultAgent;

  // With more than one agent, an account nobody declares is ambiguous: it
  // still falls to the default agent so chats keep working, but silently
  // handing it over hides exactly the case that breaks a second agent (its
  // own account loses its chats the moment it forgets to declare it). One
  // agent alone has no such ambiguity: every account is obviously its own.
  if (ids.length > 1) {
    for (const key of Object.keys(cfg.channels?.discord ?? {})) {
      if (key === "default" || accountOwners.has(key)) continue;
      issues.push({
        agent: null, text: `account Discord "${key}": nessun agente lo dichiara, oggi va a ${defaultAgent}`,
        type: "source-contradiction", ref: `account:${key}`, sources: [`config.json channels.discord.${key}`, "engine.json agents"],
      });
    }
  }

  // Which agents follow a chat — its own group row, read across every agent, not only the one
  // asking. The channel tree (AGENTS-04 feedback: "mappatura chat → agente") shows this per node
  // instead of making the person open `rules.agents` by hand.
  const chatAgents = new Map<string, AgentId[]>();
  for (const g of groups) {
    if (g.chat === "*") continue;
    const key = `${g.channel}:${g.chat}`;
    const agentId = agentOfAccount(g.account);
    const list = chatAgents.get(key) ?? [];
    if (!list.includes(agentId)) list.push(agentId);
    chatAgents.set(key, list);
  }

  const agents = ids.map((id) => {
    const ws = paths.expand(engine.agents[id].workspace);
    const identity = readIdentity(ws);
    const name = identity.name || id;
    const persona = Object.fromEntries(PERSONA_FILES.map((f) => {
      const p = join(ws, f);
      return [f, existsSync(p) ? readFileSync(p, "utf8") : ""];
    }));
    const accounts = Object.entries(cfg.channels ?? {}).flatMap(([ch, v]: [string, any]) => {
      if (ch === "discord") return Object.keys(v ?? {}).filter((k) => agentOfAccount(k) === id).map((k) => ({ channel: ch, account: k, token: String(v[k]?.token ?? "").replace(/^keychain:/, "Portachiavi: ") }));
      return id === defaultAgent ? [{ channel: ch, account: "default", token: String(v?.token ?? v?.store ?? "").replace(/^keychain:/, "Portachiavi: ") }] : [];
    });
    const routedToOthers = new Set(routes.filter((r) => r.agent && r.agent !== defaultAgent && r.chat).map((r) => `${r.channel}:${r.chat}`));
    const routedChats = new Set(routes.filter((r) => r.agent === id && r.chat).map((r) => `${r.channel}:${r.chat}`));
    const chats = groups
      .filter((g) => agentOfAccount(g.account) === id)
      .map((g) => ({
        channel: g.channel as string, chat: g.chat as string, account: (g.account ?? "default") as string,
        active: !!g.active, mention: !!g.mention, senders: (g.senders ?? []) as string[], denied: (g.denied ?? []) as string[],
        hasSystem: !!g.system, system: (g.system ?? "") as string, routed: routedChats.has(`${g.channel}:${g.chat}`),
        twoAgents: groups.filter((x) => x.channel === g.channel && x.chat === g.chat).length > 1 && routedToOthers.has(`${g.channel}:${g.chat}`),
        // Optional tree-grouping hints: `category` has no writer today (no source populates it
        // yet, kept for when the bridge's cache gains Discord channel categories), so in
        // production it stays undefined and the tree simply has one level less.
        category: (g.category ?? undefined) as string | undefined,
        followedBy: chatAgents.get(`${g.channel}:${g.chat}`) ?? [id],
      }));
    const agentJobs = jobs
      .filter((j) => (j.run?.kind === "agent" ? (j.run.agent ?? defaultAgent) : defaultAgent) === id)
      .map((j) => ({
        id: j.id as string, name: j.name as string, paused: !!j.paused, kind: j.run?.kind as string,
        schedule: j.schedule?.kind === "cron" ? j.schedule.expr : j.schedule?.kind === "every" ? `ogni ${j.schedule.minutes} min` : j.schedule?.at ?? "",
        rawSchedule: (j.schedule ?? null) as Json | null,
        model: (j.run?.model as string) ?? null, deliver: j.deliver ? `${j.deliver.channel}:${j.deliver.chat}` : null,
      }));
    const models = id === defaultAgent ? rules.models ?? {} : {};
    return { id, name, job: identity.job, workspace: ws, persona, accounts, chats, jobs: agentJobs, model: { engine: engine.model ?? null, perChannel: models } };
  });

  // Incoherences: one chat with different rules for different agents, models written in several forms.
  const byChat = new Map<string, Json[]>();
  for (const g of groups) byChat.set(`${g.channel}:${g.chat}`, [...(byChat.get(`${g.channel}:${g.chat}`) ?? []), g]);
  for (const [k, list] of byChat) {
    // `*` is a per-account default (an agent's own may be off on purpose), not a duplicate.
    if (list.length < 2 || k.endsWith(":*")) continue;
    if (routes.some((r) => r.agent && r.agent !== defaultAgent && `${r.channel}:${r.chat}` === k)) continue;
    const diff = list.some((g) => g.mention !== list[0].mention || g.active !== list[0].active);
    issues.push({
      agent: null, text: `${k}: regola scritta ${list.length} volte (${ids.length} agenti)${diff ? ", con menzione/attiva diverse" : ""}`,
      // Only a repeat with different values is a contradiction; an identical copy is redundant, not wrong.
      ...(diff ? { type: "source-contradiction" as const, ref: k, sources: [ruleSource(list[0]), ruleSource(list.find((g) => g.mention !== list[0].mention || g.active !== list[0].active)!)] as [string, string] } : {}),
    });
  }
  for (const [ch, m] of Object.entries(rules.models ?? {}) as [string, Json][]) {
    // engine.json's model is only the fallback for turns no rule names (engine.rs), so a channel
    // rule that differs from it is not a conflict.
    const forms = Object.keys(m).filter((k) => k !== "*").map((k) => k.replace(/^\+|@.*$/g, ""));
    if (new Set(forms).size < forms.length) {
      issues.push({
        agent: defaultAgent, text: `modelli ${ch}: lo stesso numero scritto in più forme`,
        type: "source-contradiction", ref: `models:${ch}`, sources: [`config.json rules.models.${ch}`, "config.json rules.models (same number, another form)"],
      });
    }
  }
  const implicit = jobs.filter((j) => j.run?.kind === "agent" && !j.run.agent);
  if (implicit.length) {
    issues.push({
      agent: defaultAgent, text: `${implicit.length} lavori a orario senza agente scritto (vanno all'agente predefinito)`,
      type: "job-without-agent", jobs: implicit.map((j) => ({ id: String(j.id), name: String(j.name ?? j.id) })),
    });
  }
  // The raw chat → agent overrides (`rules.agents`), passed through as-is so the channel tree can
  // show and change them without the person opening `config.json` by hand.
  const routesOut = routes.filter((r) => r.channel && r.chat).map((r) => ({ channel: r.channel as string, chat: r.chat as string, agent: r.agent as string }));
  return { agents, issues, routes: routesOut };
}

export type Edit =
  | { kind: "chat"; channel: string; chat: string; account?: string; active?: boolean; mention?: boolean; system?: string; senders?: string[] }
  | { kind: "job"; id: string; paused?: boolean; schedule?: Json }
  | { kind: "persona"; agent: AgentId; file: string; text: string }
  /** `agent: null` removes the override — the chat goes back to its default (unrouted) agent. */
  | { kind: "route"; channel: string; chat: string; agent: AgentId | null };

const CRON_FIELD = /^[\d*,/-]+$/;
/** A schedule jarvis-channels can run: a 5-field cron, every N minutes, or one ISO time. */
export function validateSchedule(s: Json): void {
  if (!s || typeof s !== "object") throw new Error("schedule missing");
  if (s.kind === "cron") {
    const f = String(s.expr ?? "").trim().split(/\s+/);
    if (f.length !== 5 || !f.every((x) => CRON_FIELD.test(x))) throw new Error("cron must have 5 fields");
    return;
  }
  if (s.kind === "every") {
    if (!Number.isInteger(s.minutes) || s.minutes < 1) throw new Error("minutes must be a whole number above 0");
    return;
  }
  if (s.kind === "at") {
    if (Number.isNaN(Date.parse(String(s.at)))) throw new Error("at must be a date and time");
    return;
  }
  throw new Error("unknown schedule kind");
}

/** Applies one edit; returns what changed and whether the service must be restarted. */
export function applyEdit(paths: Paths, e: Edit): { file: string; backup: string | null; restart: boolean } {
  if (e.kind === "job") {
    if (e.paused === undefined && e.schedule === undefined) throw new Error("nothing to change");
    if (e.paused !== undefined && typeof e.paused !== "boolean") throw new Error("paused must be true or false");
    if (e.schedule !== undefined) validateSchedule(e.schedule);
    const file = join(paths.home, "jobs.json");
    const jobs: Json[] = readJson(file);
    const j = jobs.find((x) => x.id === e.id);
    if (!j) throw new Error(`job ${e.id} not found`);
    if (e.paused !== undefined) j.paused = e.paused;
    if (e.schedule !== undefined) j.schedule = e.schedule;
    return { file, backup: safeWrite(file, JSON.stringify(jobs, null, 2) + "\n", paths.home), restart: false };
  }
  if (e.kind === "persona") {
    const engine: Json = existsSync(join(paths.home, "engine.json")) ? readJson(join(paths.home, "engine.json")) : {};
    if (!engine.agents?.[e.agent]?.workspace) throw new Error("unknown agent");
    if (!(PERSONA_FILES as readonly string[]).includes(e.file)) throw new Error("file not editable from here");
    if (typeof e.text !== "string" || e.text.trim().length < 20) throw new Error("text empty or too short");
    const ws = paths.expand(engine.agents[e.agent].workspace);
    const file = join(ws, e.file);
    return { file, backup: safeWrite(file, e.text.endsWith("\n") ? e.text : e.text + "\n", paths.home), restart: false };
  }
  if (e.kind === "chat") {
    const file = join(paths.home, "config.json");
    const cfg: Json = readJson(file);
    const account = (e.account ?? "default");
    const g = (cfg.rules?.groups ?? []).find((x: Json) => x.channel === e.channel && x.chat === e.chat && (x.account ?? "default") === account);
    if (!g) throw new Error(`chat ${e.channel}:${e.chat} not found for ${account}`);
    for (const k of ["active", "mention"] as const) {
      if (e[k] === undefined) continue;
      if (typeof e[k] !== "boolean") throw new Error(`${k} must be true or false`);
      g[k] = e[k];
    }
    if (e.system !== undefined) {
      if (typeof e.system !== "string") throw new Error("system must be text");
      if (e.system.trim()) g.system = e.system; else delete g.system;
    }
    if (e.senders !== undefined) {
      if (!Array.isArray(e.senders) || e.senders.some((x) => typeof x !== "string" || !/^[+\w@.:-]+$/.test(x.trim()))) throw new Error("senders must be a list of ids");
      const list = [...new Set(e.senders.map((x) => x.trim()).filter(Boolean))];
      if (list.length) g.senders = list; else delete g.senders;
    }
    const text = JSON.stringify(cfg, null, 2) + "\n";
    JSON.parse(text);
    return { file, backup: safeWrite(file, text, paths.home), restart: true };
  }
  if (e.kind === "route") {
    if (e.agent !== null && typeof e.agent !== "string") throw new Error("agent must be an id or null");
    for (const k of ["channel", "chat"] as const) {
      if (typeof e[k] !== "string" || !e[k].trim()) throw new Error(`${k} must be a non-empty string`);
    }
    if (e.agent !== null) {
      const engine: Json = existsSync(join(paths.home, "engine.json")) ? readJson(join(paths.home, "engine.json")) : {};
      if (!engine.agents?.[e.agent]) throw new Error("unknown agent");
    }
    const file = join(paths.home, "config.json");
    const cfg: Json = readJson(file);
    cfg.rules ??= {};
    const list: Json[] = (cfg.rules.agents ??= []);
    const i = list.findIndex((r) => r.channel === e.channel && r.chat === e.chat);
    if (e.agent === null) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i].agent = e.agent;
    } else {
      list.push({ channel: e.channel, chat: e.chat, agent: e.agent });
    }
    const text = JSON.stringify(cfg, null, 2) + "\n";
    JSON.parse(text);
    return { file, backup: safeWrite(file, text, paths.home), restart: true };
  }
  throw new Error("unknown edit");
}

async function run(cmd: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  const r = await runBounded(cmd, { timeoutMs });
  return { code: r.spawnFailed || r.exitCode === null ? 127 : r.exitCode, out: (r.stdout + r.stderr).trim() };
}

/** Restart only when no turn is in flight: a restart would cut a live reply. */
async function reload(paths: Paths): Promise<string> {
  const inflightPath = join(paths.home, "inflight.json");
  let inflight: Json = {};
  if (existsSync(inflightPath)) {
    try {
      inflight = readJson(inflightPath);
    } catch (err) {
      // inflight.json exists but is unreadable or malformed (e.g. a partial
      // write mid-flush) — unlike a missing file, this is NOT "no turn in
      // flight": defer the restart instead of risking a kickstart that
      // SIGKILLs a live reply.
      console.warn("[agent-config] could not read inflight.json, deferring restart:", err);
      return "pending";
    }
  }
  if (Object.keys(inflight).length) return "pending";
  if (process.env.AGENT_CONFIG_NO_RESTART) return "skipped";
  const userId = process.getuid?.() ?? 501;
  const r = await run(["launchctl", "kickstart", "-k", `gui/${userId}/com.jarvis.channels`]);
  return r.code === 0 ? "restarted" : "pending";
}

/** The workspace `engine.json` declares for an agent, expanded. `null` when the agent is unknown. */
function workspaceOf(p: Paths, agentId: string): string | null {
  const engineFile = join(p.home, "engine.json");
  if (!existsSync(engineFile)) return null;
  const engine: Json = readJson(engineFile);
  const ws = engine.agents?.[agentId]?.workspace;
  return typeof ws === "string" ? p.expand(ws) : null;
}

export function createAgentConfigRouter(ctx: Pick<AppContext, "json">, paths: () => Paths = () => defaultPaths()): RouteHandler {
  let health: { at: number; text: string; ok: boolean } | null = null;
  return async function agentConfigRouter(req, url, pathname, method) {
    if (!pathname.startsWith("/api/agent-config")) return null;
    const p = paths();
    // GET /api/agent-config/persona?agent=<id>[&walled=1] — the assembled
    // persona (base → rules → profile → identity → agent; walled guests get
    // identity and profile only), with the token weight of each layer. Used
    // by the channel engine instead of reading the four files itself, and by
    // the context inspector (T4).
    if (method === "GET" && pathname === "/api/agent-config/persona") {
      const agentId = url.searchParams.get("agent") ?? "";
      const ws = agentId ? workspaceOf(p, agentId) : null;
      if (!ws) return ctx.json({ error: "unknown agent" }, 404);
      return ctx.json(assemblePersona(agentId, ws, p, { walled: url.searchParams.get("walled") === "1" }));
    }
    if (method === "GET" && pathname === "/api/agent-config") {
      if (!existsSync(join(p.home, "config.json"))) return ctx.json({ agents: [], issues: [], health: null });
      if (!health || Date.now() - health.at > 60_000) {
        const r = await run(["jarvis-channels", "health"]);
        health = { at: Date.now(), text: r.out || "ok", ok: r.code === 0 && !r.out.startsWith("⚠") };
      }
      try {
        return ctx.json({ ...readRegistry(p), health: { ok: health.ok, text: health.text } });
      } catch (err) {
        return ctx.json({ error: `config not readable: ${String(err)}` }, 500);
      }
    }
    if (method !== "POST") return null;
    const kind = pathname.slice("/api/agent-config/".length);
    if (!["chat", "job", "persona", "route"].includes(kind)) return null;
    let body: Json;
    try { body = await req.json(); } catch { return ctx.json({ error: "invalid JSON body" }, 400); }
    try {
      const res = applyEdit(p, { ...body, kind } as Edit);
      const service = res.restart ? await reload(p) : "live";
      return ctx.json({ ok: true, file: res.file, backup: res.backup, service });
    } catch (err) {
      return ctx.json({ error: (err as Error).message }, 400);
    }
  };
}
