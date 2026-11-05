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
import { Bell, Workflow } from 'lucide-react';
import { OPEN_INBOX_EVENT } from '@/lib/inboxEvents';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { useHubEverRead, useHubLive } from '@/state/hubLive';
import { useT } from '@/hooks/useT';
import { toFixCount } from '@/lib/automations';
import { sidebarRowCard, ROW_ACTION_BOX, ROW_PX, ROW_H, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT, TAB_LABEL_TYPE } from '@/lib/selectionStyles';
import { SEGNALE_ATTESA } from './chromeSignals';
import { useInboxBadge } from './Inbox';

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

/**
 * The phone's header for the Automations view: the pane's glyph before its
 * name, and the bell on the right. On the phone the bell lives on the list,
 * which is behind the pane; this one opens the same sheet (the inbox event)
 * and carries the same number and name as that bell (`useInboxBadge`), so the
 * badge always counts what the sheet lists.
 */
export function AutomationsPhoneGlyph() {
  return <Workflow size={16} className="mr-2 flex-shrink-0 text-app-text-secondary" aria-hidden="true" />;
}

export function AutomationsPhoneBell() {
  const tr = useT();
  const { badge, label, variant } = useInboxBadge();
  return (
    <button
      type="button"
      data-testid="automations-phone-bell"
      aria-label={label}
      title={tr('inbox.title')}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_INBOX_EVENT))}
      className={`relative ml-auto mr-[6px] ${ROW_ACTION_BOX} tap-expand-y flex-shrink-0 flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover transition-colors app-no-drag`}
    >
      <Bell size={16} aria-hidden="true" />
      <NotificationBadge count={badge.count} variant={variant} ariaLabel={label} className="absolute -top-1 -right-1" testId="automations-phone-bell-count" />
    </button>
  );
}
