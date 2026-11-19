/** Topic goal tools: get_goal, close_goal, set_goal, update_goal_steps. */
import { GOAL_STEP_STATUSES } from "../../shared/types";
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";



interface GoalRow {
  id: string;
  content: string;
  status: string;
  steps?: Array<{ content: string; status: string }>;
}
interface GoalResp { goal: GoalRow | null; history?: GoalRow[] }

/**
 * The goal as the agent should read it: the sentence, then the steps with the
 * same marks the context block uses (`x` done, `~` in progress, ` ` pending).
 * With no active goal the answer still says whether there ever was one: a
 * topic that closed three goals is not a topic without direction.
 */
export async function callGetGoal(
  args: ParsedArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/goal`;
  const res = await httpJson<GoalResp>(args, "GET", path, undefined, fetchImpl);
  const g = res?.goal;
  if (!g) {
    const past = (res?.history ?? []).length;
    return past
      ? `No active goal on this topic (${past} past goal${past === 1 ? "" : "s"}, all closed).`
      : "No goal declared on this topic.";
  }
  const steps = Array.isArray(g.steps) && g.steps.length
    ? "\nSteps:\n" + g.steps.map((st) => {
        const mark = st.status === "completed" ? "x" : st.status === "in_progress" ? "~" : " ";
        return `  [${mark}] ${st.content}`;
      }).join("\n")
    : "";
  return `Active goal (id=${g.id}): ${g.content}${steps}`;
}

export async function callCloseGoal(
  args: ParsedArgs,
  toolArgs: { status?: unknown; summary?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const status = toolArgs?.status;
  if (status !== "achieved" && status !== "abandoned") {
    throw new Error("close_goal: 'status' must be 'achieved' or 'abandoned'");
  }
  const summary = typeof toolArgs?.summary === "string" ? toolArgs.summary.trim() : "";
  if (!summary) throw new Error("close_goal: 'summary' (string) is required: say what was achieved, or why it was dropped");
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/goal`;
  const res = await httpJson<{ goal: GoalRow }>(args, "DELETE", path, { status }, fetchImpl);
  const g = res?.goal;
  return g
    ? `Goal «${g.content}» closed as ${g.status}. Summary: ${summary}`
    : `Goal closed as ${status}. Summary: ${summary}`;
}

/**
 * The agent declares the objective. The refusal on a goal the person declared
 * arrives from the route as a 409, and it is passed through as it is: it names
 * the goal in force and what to do instead, which is what stops the model from
 * retrying the same call.
 */
export async function callSetGoal(
  args: ParsedArgs,
  toolArgs: { content?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const content = typeof toolArgs?.content === "string" ? toolArgs.content.trim() : "";
  if (!content) throw new Error("set_goal: 'content' (string) is required: the objective in one sentence");
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/goal`;
  const res = await httpJson<{ goal: GoalRow }>(args, "PUT", path, { content }, fetchImpl);
  const g = res?.goal;
  return g
    ? `Goal set (id=${g.id}): ${g.content}. It is shown above the chat and re-injected in your context every turn. Keep the plan visible with update_goal_steps.`
    : `Goal set: ${content}`;
}

/**
 * The plan, whole, every time. The answer says back the counted progress: the
 * model reads what the person is looking at, not "ok".
 */
export async function callUpdateGoalSteps(
  args: ParsedArgs,
  toolArgs: { steps?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const raw = Array.isArray(toolArgs?.steps) ? toolArgs.steps : null;
  if (!raw || !raw.length) {
    throw new Error("update_goal_steps: 'steps' (non-empty array) is required: send the WHOLE list, with the status of each step");
  }
  const steps = raw.map((s) => {
    const o = (typeof s === "string" ? { content: s } : s) as { content?: unknown; status?: unknown };
    const content = String(o?.content ?? "").trim();
    const status = typeof o?.status === "string" ? o.status : "pending";
    if (!GOAL_STEP_STATUSES.includes(status as (typeof GOAL_STEP_STATUSES)[number])) {
      throw new Error(`update_goal_steps: unknown status '${status}': use pending, in_progress or completed`);
    }
    return { content, status };
  }).filter((s) => s.content.length > 0);
  if (!steps.length) throw new Error("update_goal_steps: every step was empty");

  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/goal/steps`;
  const res = await httpJson<{ goal: GoalRow }>(args, "PUT", path, { steps }, fetchImpl);
  const saved = res?.goal?.steps ?? steps;
  const done = saved.filter((s) => s.status === "completed").length;
  const doing = saved.find((s) => s.status === "in_progress");
  return `Plan updated: ${done}/${saved.length} done${doing ? `, now: ${doing.content}` : ""}.`;
}
