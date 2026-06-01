/**
 * ClaudePhaseDot — tiny indicator rendered on a pane tab to surface the
 * current Claude Code session phase. Designed to live next to (or in place
 * of) the regular tab icon; suppressed for "boring" phases so most tabs
 * stay quiet.
 *
 * Phase mapping:
 *   - tool-running       → blue pulsing dot
 *   - running            → indigo pulsing dot (small)
 *   - awaiting-approval  → orange solid dot (the high-priority signal)
 *   - awaiting-user      → muted dot
 *   - error              → red dot
 *   - everything else    → nothing
 */

import type { ClaudeSessionPhase } from '../../types';
import { useClaudeSessionForTopic, useClaudeProjectPhase } from '../../contexts/ClaudeSessionContext';

interface Props {
  phase: ClaudeSessionPhase | undefined;
  /** Optional tool name shown as tooltip when phase === 'tool-running'. */
  toolName?: string;
}

const COLORS: Partial<Record<ClaudeSessionPhase, { bg: string; pulse: boolean; title: string }>> = {
  running:            { bg: 'bg-indigo-500', pulse: true,  title: 'Claude is generating…' },
  'tool-running':     { bg: 'bg-blue-500',   pulse: true,  title: 'Claude is running a tool' },
  'awaiting-approval':{ bg: 'bg-orange-500', pulse: false, title: 'Awaiting your approval' },
  // paused = an approval request that timed out but is still unanswered. Show
  // it (amber) rather than letting the question silently disappear.
  paused:             { bg: 'bg-amber-500',  pulse: false, title: 'Approval timed out — still waiting on you' },
  'awaiting-user':    { bg: 'bg-gray-400',   pulse: false, title: 'Claude replied — waiting for you' },
  error:              { bg: 'bg-red-500',    pulse: false, title: 'Session error' },
};

export function ClaudePhaseDot({ phase, toolName }: Props) {
  if (!phase) return null;
  const cfg = COLORS[phase];
  if (!cfg) return null;
  const title = phase === 'tool-running' && toolName ? `Tool: ${toolName}` : cfg.title;
  return (
    <span
      title={title}
      className={`inline-block flex-shrink-0 w-2 h-2 rounded-full ${cfg.bg} ${cfg.pulse ? 'animate-pulse' : ''}`}
      aria-label={title}
    />
  );
}

/**
 * Canonical Claude phase indicator for a single topic. Subscribes to the
 * ClaudeSessionContext, so re-renders only when *this* topic's phase
 * transitions — surrounding rows stay still.
 *
 * Used wherever a row corresponds to one chat: chat-pane tab (PaneTabBar),
 * sidebar topic row (TopicItem). Don't roll your own — if a new surface
 * needs a per-topic dot, drop this in.
 */
export function TopicClaudePhaseIndicator({
  topicId,
  className = '',
}: {
  topicId: string | undefined;
  /** Optional wrapper classes (margins, alignment). The dot itself is fixed. */
  className?: string;
}) {
  const state = useClaudeSessionForTopic(topicId);
  if (!state) return null;
  return (
    <span className={`flex-shrink-0 flex items-center ${className}`}>
      <ClaudePhaseDot phase={state.phase} toolName={state.lastTool?.name} />
    </span>
  );
}

/**
 * Canonical aggregated Claude phase indicator for a project. Shows the
 * highest-priority phase among every chat associated with `projectPath`
 * (see ClaudeSessionContext.getAggregatedPhaseByProjectPath).
 *
 * Used wherever a row corresponds to a project surface: project-pane tab
 * (PaneTabBar), sidebar project row (TopicTree).
 */
export function ProjectClaudePhaseIndicator({
  projectPath,
  className = '',
}: {
  projectPath: string | undefined;
  className?: string;
}) {
  const phase = useClaudeProjectPhase(projectPath);
  if (!phase) return null;
  return (
    <span className={`flex-shrink-0 flex items-center ${className}`}>
      <ClaudePhaseDot phase={phase} />
    </span>
  );
}
