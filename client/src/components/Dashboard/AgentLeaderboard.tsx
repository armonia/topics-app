import type { AgentStat } from '../../lib/api';
import { formatTokens as sharedFormatTokens } from '../../lib/formatTokens';

interface AgentLeaderboardProps {
  agents: AgentStat[];
}

const formatTokens = (n: number) => sharedFormatTokens(n, { decimals: 1, suffix: 'K' });

export function AgentLeaderboard({ agents }: AgentLeaderboardProps) {
  if (agents.length === 0) {
    return (
      <div data-testid="agent-leaderboard" className="flex items-center justify-center py-6 text-app-text-muted text-[12px]">
        No agent data available
      </div>
    );
  }

  return (
    <div data-testid="agent-leaderboard" className="overflow-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-app-border text-app-text-muted text-left">
            <th className="px-2 py-1.5 font-medium w-8">#</th>
            <th className="px-2 py-1.5 font-medium">Agent</th>
            <th className="px-2 py-1.5 font-medium text-right">Tasks Done</th>
            <th className="px-2 py-1.5 font-medium text-right">Tokens</th>
            <th className="px-2 py-1.5 font-medium text-right">Avg Cycle</th>
            <th className="px-2 py-1.5 font-medium text-right">Error Rate</th>
            <th className="px-2 py-1.5 font-medium text-right">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent, idx) => (
            <tr
              key={agent.agentId}
              className="border-b border-app-border/50 hover:bg-app-hover/50 transition-colors"
            >
              <td className="px-2 py-1.5 text-app-text-muted">{idx + 1}</td>
              <td className="px-2 py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[13px]">{agent.avatarEmoji || '🤖'}</span>
                  <span className="text-app-text font-medium truncate max-w-[140px]">{agent.agentName}</span>
                </span>
              </td>
              <td className="px-2 py-1.5 text-right text-app-text tabular-nums">{agent.tasksCompleted}</td>
              <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums">{formatTokens(agent.totalTokens)}</td>
              <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums">{agent.avgCycleTimeHours}h</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <span className={agent.errorRate > 0.1 ? 'text-red-500' : 'text-app-text-muted'}>
                  {(agent.errorRate * 100).toFixed(1)}%
                </span>
              </td>
              <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums">{agent.sessionsCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
