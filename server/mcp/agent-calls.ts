import { httpJson } from "./topics-http";
import { subagentWakeText } from "../services/subagent-wake";
import type { SubAgentResult } from "../lib/subagent-result";
import type { ParsedArgs } from "./topics-http";
import { send } from "./jsonrpc";
import { SPAWN_WORKTREE_TIMEOUT_MS } from "./goal-calls";

// --- Sub-agent orchestration bridge ---------------------------------------
interface SpawnAgentResp {
  agentId?: string; name?: string; cwd?: string; branch?: string | null;
  model?: string | null; modelSource?: string; modelNote?: string; agentType?: string | null; effort?: string | null;
  notify?: "chat" | "read_agent";
  runtime?: "topics" | "claude-code"; runtimeNote?: string;
}
interface AgentRow { agentId?: string; name?: string; cwd?: string; branch?: string | null; busy?: boolean; state?: string; phase?: string | null }
interface ListAgentsResp { agents?: AgentRow[] }
interface ReadAgentEvent { type?: string; text?: string; name?: string; input?: unknown }
interface ReadAgentResp { events?: ReadAgentEvent[]; nextOffset?: number; source?: string; buffer?: string }
interface WaitAgentResp { status?: "done" | "running" | "released"; result?: SubAgentResult }

/** How long a foreground `spawn_agent` waits for its child's result (SUBAGENT-13). */
const SPAWN_FOREGROUND_MS = 10 * 60_000;
/**
 * One leg of that wait. Each leg that comes back empty is a progress beat, so
 * neither the client nor a stall watchdog reads the wait as a hung call: the
 * rule is that our own wait is not a stall (c82359c1).
 */
const SPAWN_WAIT_LEG_MS = 25_000;

export async function callSpawnAgent(
  args: ParsedArgs,
  toolArgs: { prompt?: unknown; name?: unknown; cwd?: unknown; isolation?: unknown; model?: unknown; agent_type?: unknown; effort?: unknown; run_in_background?: unknown; runtime?: unknown },
  fetchImpl: typeof fetch = fetch,
  opts: { onProgress?: (leg: number) => void; legMs?: number; foregroundMs?: number; now?: () => number } = {},
): Promise<string> {
  if (typeof toolArgs?.prompt !== "string" || !toolArgs.prompt) {
    throw new Error("spawn_agent: 'prompt' (string) is required");
  }
  const payload: Record<string, unknown> = { prompt: toolArgs.prompt };
  for (const key of ["name", "cwd", "model", "agent_type", "effort", "runtime"] as const) {
    if (typeof toolArgs[key] === "string" && toolArgs[key]) payload[key] = toolArgs[key];
  }
  const foreground = toolArgs.run_in_background === false;
  if (foreground) payload.run_in_background = false;
  // Only when asked: the body of a plain spawn stays exactly `{prompt}` /
  // `{prompt,name,cwd}`, which is what the route has always received.
  const isolated = toolArgs.isolation === "worktree";
  if (typeof toolArgs.isolation === "string" && toolArgs.isolation) payload.isolation = toolArgs.isolation;
  const base = `/api/sessions/${encodeURIComponent(args.sessionKey)}/agents`;
  // A worktree is born through a dependency install, which is minutes on a big
  // repository: the default 45s ceiling would cut the call in half and leave a
  // checkout alive with no child in it. The budget below stays under the
  // tool-call ceiling of the CLI that is calling us.
  const signal = isolated ? AbortSignal.timeout(SPAWN_WORKTREE_TIMEOUT_MS) : undefined;
  const body = await httpJson<SpawnAgentResp>(args, "POST", `${base}/spawn`, payload, fetchImpl, signal);
  if (typeof body?.agentId !== "string") throw new Error("spawn_agent: server did not return an agentId");
  const branch = body.branch ? ` · branch=${body.branch}` : "";
  const model = body.model ? ` · model=${body.model}` : body.modelNote ? ` · model=${body.modelNote}` : "";
  const profile = body.agentType ? ` · agent_type=${body.agentType}` : "";
  const effort = body.effort ? ` · effort=${body.effort}` : "";
  // The runtime only when the server names it: an older server answers without it.
  const runtime = body.runtimeNote ? ` · runtime=${body.runtimeNote}` : body.runtime ? ` · runtime=${body.runtime}` : "";
  const head = `spawned sub-agent "${body.name ?? body.agentId}" · agentId=${body.agentId} · cwd=${body.cwd ?? "?"}${branch}${runtime}${model}${profile}${effort}`;
  const later = body.notify === "chat"
    ? "its result will wake this chat when its turn ends, no need to poll"
    : `read its output with read_agent(agent_id="${body.agentId}")`;
  if (!foreground) return `${head} — ${later}`;

  const now = opts.now ?? Date.now;
  const legMs = opts.legMs ?? SPAWN_WAIT_LEG_MS;
  const deadline = now() + (opts.foregroundMs ?? SPAWN_FOREGROUND_MS);
  const waitPath = `${base}/${encodeURIComponent(body.agentId)}/wait`;
  for (let leg = 1; now() < deadline && !args.turnSignal?.aborted; leg++) {
    const ms = Math.max(100, Math.min(legMs, deadline - now()));
    // A stopped turn of the native runtime closes the leg too: left open, the
    // loop sat in the tool until its deadline, the next turn waited behind it,
    // and the leg the server still held took the child's result with it.
    const legDeadline = AbortSignal.timeout(ms + 15_000);
    const signal = args.turnSignal ? AbortSignal.any([legDeadline, args.turnSignal]) : legDeadline; // allow-any: the method that joins two signals, not the type
    let r: WaitAgentResp | undefined;
    try {
      r = await httpJson<WaitAgentResp>(args, "GET", `${waitPath}?legMs=${ms}`, undefined, fetchImpl, signal);
    } catch {
      // The server is away, or the turn was stopped: the child goes on, and
      // its result follows the ordinary road once the server holds it no longer.
      break;
    }
    if (r?.status === "done" && r.result) return `${head}\n\n${subagentWakeText([r.result])}`;
    if (r?.status === "released") break;
    opts.onProgress?.(leg);
  }
  // Hand the result over to the notification, then say so. Not under the
  // turn's signal: a stopped turn is exactly when the hold has to go.
  await httpJson(args, "GET", `${waitPath}?release=1`, undefined, fetchImpl).catch(() => {});
  if (args.turnSignal?.aborted) throw new Error(`spawn_agent: the turn was stopped while waiting; ${head.slice("spawned ".length)} goes on — ${later}`);
  return `${head} — still working after ${Math.round((opts.foregroundMs ?? SPAWN_FOREGROUND_MS) / 60_000)} minutes: status=running; ${later}`;
}

export async function callSendToAgent(
  args: ParsedArgs,
  toolArgs: { agent_id?: unknown; input?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.agent_id !== "string" || !toolArgs.agent_id) {
    throw new Error("send_to_agent: 'agent_id' (string) is required");
  }
  if (typeof toolArgs?.input !== "string" || !toolArgs.input) {
    throw new Error("send_to_agent: 'input' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/agents/${encodeURIComponent(toolArgs.agent_id)}/send`;
  const res = await httpJson<{ ok?: boolean; dropped?: boolean; resumed?: boolean }>(args, "POST", path, { input: toolArgs.input }, fetchImpl);
  if (res?.ok === false && res.dropped === true) {
    return `not sent to ${toolArgs.agent_id}: the input contained only Ctrl+Z, so nothing was sent and no reply is expected`;
  }
  const resumed = res?.resumed ? " (it had ended: resumed from where it was)" : "";
  return `sent to ${toolArgs.agent_id}${resumed} — its reply arrives like its first result (a chat is woken; otherwise read_agent(agent_id="${toolArgs.agent_id}"))`;
}

export async function callReadAgent(
  args: ParsedArgs,
  toolArgs: { agent_id?: unknown; since?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.agent_id !== "string" || !toolArgs.agent_id) {
    throw new Error("read_agent: 'agent_id' (string) is required");
  }
  const since = typeof toolArgs.since === "number" ? toolArgs.since : 0;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/agents/${encodeURIComponent(toolArgs.agent_id)}/read?since=${since}`;
  const body = await httpJson<ReadAgentResp>(args, "GET", path, undefined, fetchImpl);
  const events = Array.isArray(body?.events) ? body.events : [];
  const nextOffset = typeof body?.nextOffset === "number" ? body.nextOffset : since;
  const footer = `\n[since=${nextOffset} source=${body?.source ?? "?"}] — pass since=${nextOffset} next time to page only new output`;
  if (body?.source === "buffer") {
    const buf = typeof body.buffer === "string" ? body.buffer.slice(-4000) : "";
    return (buf ? `(transcript not ready yet — raw terminal tail)\n${buf}` : "(no output yet)") + footer;
  }
  if (!events.length) return `(no new output)${footer}`;
  const rendered = events.map((e) =>
    e.type === "tool_use"
      ? `[tool_use] ${e.name ?? "?"} ${e.input !== undefined ? JSON.stringify(e.input) : ""}`.trim()
      : `[assistant] ${e.text ?? ""}`,
  ).join("\n\n");
  return `${rendered}${footer}`;
}

export async function callListAgents(
  args: ParsedArgs,
  _toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/agents`;
  const body = await httpJson<ListAgentsResp>(args, "GET", path, undefined, fetchImpl);
  const agents = Array.isArray(body?.agents) ? body.agents : [];
  if (!agents.length) return "No sub-agents spawned.";
  return agents.map((a) => {
    const branch = a.branch ? ` branch=${a.branch}` : "";
    const state = a.state && a.state !== "running" ? a.state : (a.phase ?? (a.busy ? "busy" : "idle"));
    return `[${state}] ${a.name ?? a.agentId} id=${a.agentId} cwd=${a.cwd ?? "?"}${branch}`;
  }).join("\n");
}

export async function callStopAgent(
  args: ParsedArgs,
  toolArgs: { agent_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.agent_id !== "string" || !toolArgs.agent_id) {
    throw new Error("stop_agent: 'agent_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/agents/${encodeURIComponent(toolArgs.agent_id)}/stop`;
  const body = await httpJson<{ ok?: boolean; branch?: string | null }>(args, "POST", path, {}, fetchImpl);
  // The branch outlives the child: its directory is judged later by the sweep,
  // its commits are not. Naming it here is the only handover there is.
  if (body?.branch) return `stopped sub-agent ${toolArgs.agent_id} · branch=${body.branch} (read it with \`git log main..${body.branch}\`)`;
  return `stopped sub-agent ${toolArgs.agent_id}`;
}

// --- Topic / project control bridge ----------------------------------------
export async function callSwitchTopic(
  args: ParsedArgs,
  toolArgs: { topic_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.topic_id !== "string" || !toolArgs.topic_id) {
    throw new Error("switch_topic: 'topic_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/switch-topic`;
  const body = await httpJson<{ toTopicId?: string }>(args, "POST", path, { topicId: toolArgs.topic_id }, fetchImpl);
  return `switched to topic ${body?.toTopicId ?? toolArgs.topic_id}`;
}

export async function callNewTopic(
  args: ParsedArgs,
  toolArgs: { title?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.title !== "string" || !toolArgs.title) {
    throw new Error("new_topic: 'title' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/new-topic`;
  const body = await httpJson<{ topicId?: string }>(args, "POST", path, { title: toolArgs.title }, fetchImpl);
  return `created + switched to new topic "${toolArgs.title}" (id=${body?.topicId ?? "?"})`;
}

export async function callCreateProject(
  args: ParsedArgs,
  toolArgs: { name?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.name !== "string" || !toolArgs.name) {
    throw new Error("create_project: 'name' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/create-project`;
  const body = await httpJson<{ projectPath?: string }>(args, "POST", path, { name: toolArgs.name }, fetchImpl);
  return `created + opened project at ${body?.projectPath ?? toolArgs.name}`;
}

export async function callOpenProject(
  args: ParsedArgs,
  toolArgs: { ref?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.ref !== "string" || !toolArgs.ref) {
    throw new Error("open_project: 'ref' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/open-project`;
  const body = await httpJson<{ projectPath?: string }>(args, "POST", path, { ref: toolArgs.ref }, fetchImpl);
  return `opened project at ${body?.projectPath ?? toolArgs.ref}`;
}
