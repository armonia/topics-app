/**
 * THE AUTOMATIONS ROW (hub-smistamento, HUBBR-14), above the Board.
 *
 * The automations are the hub section almost every link points to, so they
 * get a row of their own at the top of the column, the same card as the
 * Board's. It exists only where the usage hub is part of the installation.
 * Its tail says how many need fixing, the broken ones plus the ones waiting
 * on you (the hub's `needsYou + broken`), in amber, and nothing when all is in
 * order: the «ok» ones are never counted. When the hub stops answering after
 * it was read, the row stays and says so.
 */
import { Workflow } from 'lucide-react';
import { useHubEverRead, useHubLive } from '@/state/hubLive';
import { useT } from '@/hooks/useT';
import { toFixCount } from '@/lib/automations';
import { sidebarRowCard, ROW_PX, ROW_H, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT, TAB_LABEL_TYPE } from '@/lib/selectionStyles';
import { SEGNALE_ATTESA } from './chromeSignals';

export function AutomationsRow({ open }: { open: boolean }) {
  const tr = useT();
  const present = useHubEverRead();
  const entry = useHubLive().automations;
  if (!present) return null;
  const n = entry?.data !== undefined ? toFixCount(entry.data) : null;
  const down = entry?.error !== undefined;
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={open}
      data-testid="sidebar-automations"
      onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'automations' } }))}
      className={`flex items-center gap-2 leading-none ${ROW_PX} ${ROW_H} select-none ${sidebarRowCard({ focused: open })}`}
      style={{ width: `calc(100% - ${ROW_INSET * 2}px)` }}
    >
      <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="glyph">
        <Workflow size={ROW_GLYPH} className="text-app-text-secondary" aria-hidden="true" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-left ${TAB_LABEL_TYPE}`}>{tr('automations.open')}</span>
      <span data-testid="sidebar-automations-tail" className="flex-shrink-0 text-mini tabular-nums">
        {down ? (
          <span className="text-app-text-muted">{tr('automations.hubDown')}</span>
        ) : n !== null && n > 0 ? (
          <span className={SEGNALE_ATTESA}>{tr('automations.toFix', { n })}</span>
        ) : null}
      </span>
    </button>
  );
}
