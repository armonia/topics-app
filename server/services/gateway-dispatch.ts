import type { AppContext } from "../types";

interface AgentInfo {
  id: string;
  name: string;
  gatewaySessionId: string | null;
}

/**
 * Send a nudge message to an agent via the OpenClaw Gateway.
 */
export async function nudgeAgent(
  ctx: AppContext,
  agent: AgentInfo,
  message: string
): Promise<boolean> {
  if (!agent.gatewaySessionId) return false;
  if (!ctx.GATEWAY_URL) return false;

  try {
    const res = await fetch(
      `${ctx.GATEWAY_URL}/sessions/${agent.gatewaySessionId}/message`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: "user",
          content: `[NUDGE from lead] ${message}`,
        }),
      }
    );
    return res.ok;
  } catch (err) {
    console.warn(`[GatewayDispatch] Failed to nudge agent ${agent.name}:`, err);
    return false;
  }
}

/**
 * Bootstrap an agent session via gateway.
 * Sends initial context (token, project, SOUL template) to start the agent loop.
 */
export async function bootstrapAgentSession(
  ctx: AppContext,
  agent: {
    id: string;
    name: string;
    soulTemplate: string | null;
    identityTemplate: string | null;
  },
  projectId: string,
  agentToken: string
): Promise<{ sessionId: string } | null> {
  if (!ctx.GATEWAY_URL) return null;

  const systemPrompt = [
    agent.identityTemplate || `You are ${agent.name}, an autonomous agent in the Topix system.`,
    "",
    agent.soulTemplate || "",
    "",
    "## API Connection",
    `- API Base: http://localhost:${ctx.PORT}/api/agent`,
    `- Your Token: ${agentToken}`,
    `- Project ID: ${projectId}`,
    "",
    "## Protocol",
    "1. POST /api/agent/heartbeat every 30 seconds",
    "2. GET /api/agent/boards/{projectId}/tasks?unassigned=true to find work",
    "3. POST /api/agent/boards/{projectId}/tasks/{taskId}/claim to take a task",
    "4. Work on the task, comment progress",
    "5. POST /api/agent/boards/{projectId}/tasks/{taskId}/complete when done",
    "6. If blocked, POST /api/agent/boards/{projectId}/escalate",
  ].join("\n");

  try {
    const res = await fetch(`${ctx.GATEWAY_URL}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentName: agent.name,
        systemPrompt,
        initialMessage: "You are now online. Start your agent loop: heartbeat, then poll for tasks.",
      }),
    });

    if (!res.ok) {
      console.warn(`[GatewayDispatch] Bootstrap failed for ${agent.name}: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as any;
    return { sessionId: data.sessionId || data.session_id };
  } catch (err) {
    console.warn(`[GatewayDispatch] Bootstrap error for ${agent.name}:`, err);
    return null;
  }
}
