/**
 * "Context compacted" divider (CHAT-COMPACT-01).
 *
 * Display-only marker that the Claude Code CLI compacted the conversation
 * context here. Rendered inline in the transcript (positioned by the message
 * it follows). Never a message row, never re-sent to the model.
 *
 * It is also the SINGLE signal for the boundary: when the message underneath
 * carries the CLI's recap, that recap is hoisted in here as an expander rather
 * than drawing its own second pill (see `CompactionHoistContext`).
 */

import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { ChevronRight, Layers } from 'lucide-react';
import type { CompactionMarker } from '../../types';
import { ChatMarkdown } from '../ChatMarkdown';

function tokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

const NO_COMPONENTS = {};

export function CompactionDivider({ marker, summary }: { marker: CompactionMarker; summary?: string }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
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

  const chip = (
    <>
      <Layers size={12} className="flex-shrink-0" />
      <span className="font-medium">Contesto compattato</span>
      {detail && <span className="text-app-text-muted">· {detail}</span>}
    </>
  );

  return (
    <div data-testid="compaction-divider" className="my-3 px-2 text-app-text-muted select-none">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-app-border/60" />
        {summary ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            data-testid="compaction-divider-toggle"
            title={open ? tr('compaction.hide') : tr('compaction.show')}
            className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-[11px] hover:bg-app-hover transition-colors"
          >
            {chip}
            <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <div className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-[11px]">
            {chip}
          </div>
        )}
        <div className="h-px flex-1 bg-app-border/60" />
      </div>
      {open && summary && (
        <div
          data-testid="compaction-divider-summary"
          className="mt-1.5 prose prose-sm max-w-none opacity-70 prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5"
        >
          <ChatMarkdown components={NO_COMPONENTS}>{summary}</ChatMarkdown>
        </div>
      )}
    </div>
  );
}
