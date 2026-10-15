export interface TaskSessionPeek {
  state: string;
  since: string | null;
  lines: string[];
  tool: string | null;
  tokens: number | null;
  costCents: number | null;
}

export function selectTaskSessionPeek(
  task: { assignedTopicId: string | null; dispatchState: string | null; inProgressAt?: string | null; agentTokens?: number | null; agentCostCents?: number | null },
  messages: readonly { content: string; timestamp: string | null }[],
  tool?: string | null,
  stream?: { content: string; startedAt: string } | null,
): TaskSessionPeek | null {
  if (!task.assignedTopicId) return null;
  const latest = messages.at(-1) ?? null;
  const content = stream?.content ?? latest?.content ?? '';
  return {
    state: task.dispatchState ?? 'unknown',
    since: stream?.startedAt ?? task.inProgressAt ?? latest?.timestamp ?? null,
    lines: lastMessageLines(content),
    tool: tool ?? null,
    tokens: task.agentTokens || null,
    costCents: task.agentCostCents || null,
  };
}

export function lastMessageLines(content: string, limit = 3): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-Math.max(0, limit))
    .map((line) => line.slice(0, 240));
}
