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

interface Props {
  phase: ClaudeSessionPhase | undefined;
  /** Optional tool name shown as tooltip when phase === 'tool-running'. */
  toolName?: string;
}

const COLORS: Partial<Record<ClaudeSessionPhase, { bg: string; pulse: boolean; title: string }>> = {
  running:            { bg: 'bg-indigo-500', pulse: true,  title: 'Claude is generating…' },
  'tool-running':     { bg: 'bg-blue-500',   pulse: true,  title: 'Claude is running a tool' },
  'awaiting-approval':{ bg: 'bg-orange-500', pulse: false, title: 'Awaiting your approval' },
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
