/**
 * "Context compacted" divider (CHAT-COMPACT-01).
 *
 * Display-only marker that the Claude Code CLI compacted the conversation
 * context here. Rendered inline in the transcript (positioned by the message
 * it follows). Never a message row, never re-sent to the model.
 */

import { Layers } from 'lucide-react';
import type { CompactionMarker } from '../../types';

function tokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function CompactionDivider({ marker }: { marker: CompactionMarker }) {
  const triggerLabel =
    marker.trigger === 'auto' ? 'automatica' : marker.trigger === 'manual' ? 'manuale' : null;
  const parts: string[] = [];
  if (triggerLabel) parts.push(triggerLabel);
  if (typeof marker.preTokens === 'number') {
    parts.push(
      typeof marker.postTokens === 'number'
        ? `${tokens(marker.preTokens)} → ${tokens(marker.postTokens)} token`
        : `~${tokens(marker.preTokens)} token prima`,
    );
  }
  const detail = parts.join(' · ');

  return (
    <div data-testid="compaction-divider" className="my-3 flex items-center gap-2 px-2 text-app-text-muted select-none">
      <div className="h-px flex-1 bg-app-border/60" />
      <div className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-[11px]">
        <Layers size={12} className="flex-shrink-0" />
        <span className="font-medium">Contesto compattato</span>
        {detail && <span className="text-app-text-muted">· {detail}</span>}
      </div>
      <div className="h-px flex-1 bg-app-border/60" />
    </div>
  );
}
