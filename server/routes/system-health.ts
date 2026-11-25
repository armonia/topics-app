/**
 * `GET /api/system/agents-health` → { problems, count, types } (T7, see `../system/health.ts`).
 *
 * The one list behind the number next to "System" in the sidebar and in the
 * Agents overview. It reads every source on each call and stores nothing, so
 * a problem that was fixed is simply absent from the next answer.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readAgents, registryHome } from "../agents/registry";
import { planSoulSplit } from "../agents/soul-sections";
import { claudeProjectsHome, discoverStores, readMemoryStoresConfig } from "../memory/stores";
import { mcpFleetStatus } from "../providers/native/mcp-fleet";
import { channelsDbPath, readChannelTitles, readTurnChannels } from "./agent-channels";
import { registryHealthInput } from "../system/registry-health";
import { LOG_LEVELS, readEngineLog, type LogLevel } from "../system/engine-log";
import { collectHealth, HEALTH_PROBLEM_TYPES, type HealthAgentInput, type HealthInput } from "../system/health";
import type { AppContext, RouteHandler } from "../types";

const BASE_SOUL = join(import.meta.dir, "..", "agents", "base", "SOUL.md");

const expandTilde = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

function personaGaps(workspace: string): string[] {
  const missing: string[] = [];
  if (!existsSync(join(workspace, "IDENTITY.md"))) missing.push("IDENTITY.md");
  if (!existsSync(join(workspace, "SOUL.md")) && !existsSync(join(workspace, "AGENTS.md"))) missing.push("SOUL.md");
  return missing;
}

/** The soul still holds sections the shared base lacks: rules that only this agent reads. */
function soulHoldsRules(workspace: string): boolean {
  const soul = join(workspace, "SOUL.md");
  if (!existsSync(soul) || !existsSync(BASE_SOUL)) return false;
  return planSoulSplit(readFileSync(soul, "utf8"), readFileSync(BASE_SOUL, "utf8"), []).moved.length > 0;
}

function jobsInput(db: AppContext["db"]): HealthInput["jobs"] {
  const rows = db.query("SELECT id, name, action_json FROM scheduled_jobs WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string; action_json: string }>;
  const jobs: HealthInput["jobs"] = [];
  for (const row of rows) {
    let action: Record<string, unknown>;
    try {
      action = JSON.parse(row.action_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (action.kind !== "agent") continue;
    const agent = action.agentId ?? action.agent;
    jobs.push({ id: row.id, name: row.name, agentId: typeof agent === "string" && agent ? agent : null });
  }
  return jobs;
}

export function createSystemHealthRouter(ctx: Pick<AppContext, "json" | "db">): RouteHandler {
  return async function systemHealthRouter(_req, url, pathname, method) {
    if (method !== "GET") return null;
    // The channel engine's log tail, for System > Log.
    if (pathname === "/api/system/engine-log") {
      const level = url.searchParams.get("level");
      const dbPath = channelsDbPath();
      return ctx.json(readEngineLog(registryHome(), {
        titles: readChannelTitles(dbPath),
        turnChannels: readTurnChannels(dbPath),
        agent: url.searchParams.get("agent") || undefined,
        level: LOG_LEVELS.includes(level as LogLevel) ? (level as LogLevel) : undefined,
      }));
    }
    if (pathname !== "/api/system/agents-health") return null;
    const home = registryHome();
    const records = readAgents(home, expandTilde);
    const agents: HealthAgentInput[] = records.map((a) => ({
      id: a.id,
      name: a.name,
      missingPersonaFiles: personaGaps(a.workspace),
      hasOwnRules: soulHoldsRules(a.workspace),
    }));
    const stores = discoverStores(records, { claudeProjectsHome: claudeProjectsHome(), config: readMemoryStoresConfig(home) });
    const registry = registryHealthInput(home, readChannelTitles(channelsDbPath()));
    const tools = mcpFleetStatus().servers.map((s) => ({ name: s.name, ok: s.state === "ready" || s.state === "excluded", reason: s.reason }));
    const problems = collectHealth({
      agents,
      stores,
      jobs: [...jobsInput(ctx.db), ...registry.jobs],
      chats: registry.chats,
      contradictions: registry.contradictions,
      tools,
      sharedRulesPresent: existsSync(join(home, "RULES.md")),
    });
    return ctx.json({ problems, count: problems.length, types: Object.keys(HEALTH_PROBLEM_TYPES) });
  };
}
