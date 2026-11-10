/**
 * Agents registry: one card per always-on agent (Jarvis, Visione) built from
 * the files jarvis-channels runs on, and the few edits Attilio makes there.
 *
 *   GET  /api/agent-config              → { agents, health, issues }
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { runBounded } from "../lib/bounded-spawn";
import type { AppContext, RouteHandler } from "../types";

export type AgentId = "main" | "gtm";
const AGENTS: Record<AgentId, { name: string; workspace: string; account: string }> = {
  main: { name: "Jarvis", workspace: "~/.claude/jarvis/home", account: "default" },
  gtm: { name: "Visione", workspace: "~/.claude/jarvis/home/workspace-gtm", account: "visione" },
};
export const PERSONA_FILES = ["IDENTITY.md", "SOUL.md"] as const;

export interface Paths { home: string; expand: (p: string) => string }
export function defaultPaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.JARVIS_CHANNELS_HOME?.trim() || join(homedir(), "Library", "Application Support", "jarvis-channels");
  return { home, expand: (p) => p.replace(/^~(?=\/|$)/, homedir()) };
}

type Json = Record<string, any>;
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

/** Backup then atomic write; returns the backup path. */
export function safeWrite(file: string, data: string, home: string, now = new Date()): string | null {
  const dir = join(home, "backups");
  mkdirSync(dir, { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = join(dir, `${basename(file)}.${now.toISOString().replace(/[:.]/g, "-")}`);
    copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
  return backup;
}

const agentOfAccount = (acc: string | undefined): AgentId => (acc === "visione" ? "gtm" : "main");

/** The registry: everything an agent is, read from config.json, engine.json, jobs.json and its workspace. */
export function readRegistry(paths: Paths) {
  const cfg: Json = readJson(join(paths.home, "config.json"));
  const engine: Json = existsSync(join(paths.home, "engine.json")) ? readJson(join(paths.home, "engine.json")) : {};
  const jobs: Json[] = existsSync(join(paths.home, "jobs.json")) ? readJson(join(paths.home, "jobs.json")) : [];
  const rules: Json = cfg.rules ?? {};
  const groups: Json[] = rules.groups ?? [];
  const routes: Json[] = rules.agents ?? [];
  const issues: { agent: AgentId | null; text: string }[] = [];

  const agents = (Object.keys(AGENTS) as AgentId[]).map((id) => {
    const a = AGENTS[id];
    const ws = paths.expand(engine.agents?.[id]?.workspace ?? a.workspace);
    const persona = Object.fromEntries(PERSONA_FILES.map((f) => {
      const p = join(ws, f);
      return [f, existsSync(p) ? readFileSync(p, "utf8") : ""];
    }));
    const accounts = Object.entries(cfg.channels ?? {}).flatMap(([ch, v]: [string, any]) => {
      if (ch === "discord") return Object.keys(v ?? {}).filter((k) => agentOfAccount(k) === id).map((k) => ({ channel: ch, account: k, token: String(v[k]?.token ?? "").replace(/^keychain:/, "Portachiavi: ") }));
      return id === "main" ? [{ channel: ch, account: "default", token: String(v?.token ?? v?.store ?? "").replace(/^keychain:/, "Portachiavi: ") }] : [];
    });
    const routedToSales = new Set(routes.filter((r) => r.agent === "gtm" && r.chat).map((r) => `${r.channel}:${r.chat}`));
    const routedChats = new Set(routes.filter((r) => r.agent === id && r.chat).map((r) => `${r.channel}:${r.chat}`));
    const chats = groups
      .filter((g) => agentOfAccount(g.account) === id)
      .map((g) => ({
        channel: g.channel as string, chat: g.chat as string, account: (g.account ?? "default") as string,
        active: !!g.active, mention: !!g.mention, senders: (g.senders ?? []) as string[], denied: (g.denied ?? []) as string[],
        hasSystem: !!g.system, system: (g.system ?? "") as string, routed: routedChats.has(`${g.channel}:${g.chat}`),
        twoAgents: groups.filter((x) => x.channel === g.channel && x.chat === g.chat).length > 1 && routedToSales.has(`${g.channel}:${g.chat}`),
      }));
    const agentJobs = jobs
      .filter((j) => (j.run?.kind === "agent" ? (j.run.agent ?? "main") : "main") === id)
      .map((j) => ({
        id: j.id as string, name: j.name as string, paused: !!j.paused, kind: j.run?.kind as string,
        schedule: j.schedule?.kind === "cron" ? j.schedule.expr : j.schedule?.kind === "every" ? `ogni ${j.schedule.minutes} min` : j.schedule?.at ?? "",
        rawSchedule: (j.schedule ?? null) as Json | null,
        model: (j.run?.model as string) ?? null, deliver: j.deliver ? `${j.deliver.channel}:${j.deliver.chat}` : null,
      }));
    const models = id === "main" ? rules.models ?? {} : {};
    return { id, name: a.name, workspace: ws, persona, accounts, chats, jobs: agentJobs, model: { engine: engine.model ?? null, perChannel: models } };
  });

  // Incoherences: one chat with different rules for Jarvis and Visione, models written in several forms.
  const byChat = new Map<string, Json[]>();
  for (const g of groups) byChat.set(`${g.channel}:${g.chat}`, [...(byChat.get(`${g.channel}:${g.chat}`) ?? []), g]);
  for (const [k, list] of byChat) {
    // `*` is a per-account default (Visione's is off on purpose), not a duplicate.
    if (list.length < 2 || k.endsWith(":*")) continue;
    if (routes.some((r) => r.agent === "gtm" && `${r.channel}:${r.chat}` === k)) continue;
    const diff = list.some((g) => g.mention !== list[0].mention || g.active !== list[0].active);
    issues.push({ agent: null, text: `${k}: regola scritta ${list.length} volte (Jarvis e Visione)${diff ? ", con menzione/attiva diverse" : ""}` });
  }
  for (const [ch, m] of Object.entries(rules.models ?? {}) as [string, Json][]) {
    // engine.json's model is only the fallback for turns no rule names (engine.rs), so a channel
    // rule that differs from it is not a conflict.
    const forms = Object.keys(m).filter((k) => k !== "*").map((k) => k.replace(/^\+|@.*$/g, ""));
    if (new Set(forms).size < forms.length) issues.push({ agent: "main", text: `modelli ${ch}: lo stesso numero scritto in più forme` });
  }
  const implicit = jobs.filter((j) => j.run?.kind === "agent" && !j.run.agent).length;
  if (implicit) issues.push({ agent: "main", text: `${implicit} lavori a orario senza agente scritto (vanno a Jarvis per difetto)` });
  return { agents, issues };
}

export type Edit =
  | { kind: "chat"; channel: string; chat: string; account?: string; active?: boolean; mention?: boolean; system?: string; senders?: string[] }
  | { kind: "job"; id: string; paused?: boolean; schedule?: Json }
  | { kind: "persona"; agent: AgentId; file: string; text: string };

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
    if (!(e.agent in AGENTS)) throw new Error("unknown agent");
    if (!(PERSONA_FILES as readonly string[]).includes(e.file)) throw new Error("file not editable from here");
    if (typeof e.text !== "string" || e.text.trim().length < 20) throw new Error("text empty or too short");
    const engine: Json = existsSync(join(paths.home, "engine.json")) ? readJson(join(paths.home, "engine.json")) : {};
    const ws = paths.expand(engine.agents?.[e.agent]?.workspace ?? AGENTS[e.agent].workspace);
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
  throw new Error("unknown edit");
}

async function run(cmd: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  const r = await runBounded(cmd, { timeoutMs });
  return { code: r.spawnFailed || r.exitCode === null ? 127 : r.exitCode, out: (r.stdout + r.stderr).trim() };
}

/** Restart only when no turn is in flight: a restart would cut a live reply. */
async function reload(paths: Paths): Promise<string> {
  let inflight: Json = {};
  try { inflight = readJson(join(paths.home, "inflight.json")); } catch {}
  if (Object.keys(inflight).length) return "pending";
  if (process.env.AGENT_CONFIG_NO_RESTART) return "skipped";
  const userId = process.getuid?.() ?? 501;
  const r = await run(["launchctl", "kickstart", "-k", `gui/${userId}/com.jarvis.channels`]);
  return r.code === 0 ? "restarted" : "pending";
}

export function createAgentConfigRouter(ctx: Pick<AppContext, "json">, paths: () => Paths = () => defaultPaths()): RouteHandler {
  let health: { at: number; text: string; ok: boolean } | null = null;
  return async function agentConfigRouter(req, _url, pathname, method) {
    if (!pathname.startsWith("/api/agent-config")) return null;
    const p = paths();
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
    if (!["chat", "job", "persona"].includes(kind)) return null;
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
