/**
 * What the harness reading (`readRegistry`) found, as the inputs `collectHealth`
 * takes. The registry's own logic is not repeated here: its issues carry a
 * `type`, and this only sorts them into the health inputs.
 */
import { existsSync } from "fs";
import { join } from "path";
import { defaultPaths, readRegistry } from "../routes/agent-config";
import type { HealthInput } from "./health";

/** The agent the channels engine gives a scheduled job that names none (`cron.rs`, `unwrap_or_else(|| "main")`). */
const ENGINE_JOB_AGENT = "main";

export function registryHealthInput(home: string, titles: Record<string, string>): Pick<HealthInput, "contradictions" | "jobs" | "chats"> {
  if (!existsSync(join(home, "config.json"))) return { contradictions: [], jobs: [], chats: [] };
  const { agents, issues } = readRegistry({ ...defaultPaths(), home });
  const contradictions: HealthInput["contradictions"] = [];
  const jobs: HealthInput["jobs"] = [];
  for (const issue of issues) {
    if (issue.type === "source-contradiction" && issue.sources) {
      contradictions.push({ id: issue.ref ?? issue.text, sources: issue.sources, about: issue.text });
    } else if (issue.type === "job-without-agent") {
      // A job with no agent written runs as ENGINE_JOB_AGENT: only an installation without that
      // agent leaves it with nobody to run it, and collectHealth reports exactly that case.
      for (const j of issue.jobs ?? []) jobs.push({ id: `engine:${j.id}`, name: j.name, agentId: ENGINE_JOB_AGENT });
    }
  }
  // Only the chats the agents answer in: a Topics topic without a name is not a problem. With no titles at all the
  // bridge database is absent (a fresh install) and every chat would look unnamed.
  const chats: HealthInput["chats"] = [];
  if (Object.keys(titles).length > 0) {
    const seen = new Set<string>();
    for (const agent of agents) {
      for (const chat of agent.chats) {
        if (chat.chat === "*" || seen.has(chat.chat)) continue;
        seen.add(chat.chat);
        chats.push({ id: chat.chat, name: titles[chat.chat] ?? null, agentId: agent.id });
      }
    }
  }
  return { contradictions, jobs, chats };
}
