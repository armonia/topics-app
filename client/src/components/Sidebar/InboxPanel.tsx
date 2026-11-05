/**
 * THE PANEL OF «TO LOOK AT» (ATTN-09, HUBBR-06, HUBBR-07): a chunk of its own,
 * loaded when the button is first approached (`Inbox.tsx`).
 *
 *   - «Now»: the groups of `bellGroups`, in their one order: «Decide» (the
 *     waits of Topics and the hub's items together, deadlines first), «Broken»,
 *     «Quotas and accounts», «To look at», «Finished» (each with «Mark seen»,
 *     and «Mark all seen» on its heading). An empty group is not drawn; a hub
 *     group shows five rows and «N more». A row of chips on top jumps to a
 *     group. Then a quiet line «3 at work» that opens in place.
 *   - «History»: the log, by day, read only, with the hub's diary merged in
 *     (failed runs, agents, workflows, what you said; never the routine runs
 *     that went well) and a filter: everything, Topics, automations and agents.
 * OPENING THE PANEL MARKS NOTHING (choice 4). A row of Topics opens its subject
 * where it waits (the chat, the card's drawer, the terminal) and, for a
 * finished one, marks it seen with the epoch the row showed.
 *
 * Keyboard: ↑/↓ move, Enter opens, E marks seen, ⇧E marks all seen, ←/→
 * change tab, Esc closes and gives the focus back to the button. One tab stop
 * in, one out: the rows are a roving list. Touch: rows of 56px with 44px
 * targets, and a swipe to the left on a finished row marks it seen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  Check, ChevronDown, CircleAlert, CircleCheck, CircleX, ClipboardCheck, Eye, Gauge, GitPullRequest, Hand,
  Inbox as InboxIcon, MessageCircleQuestion, MessageSquare, PauseCircle, Server, Settings, ShieldAlert, SquareCheck, TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import type { WSMessage } from '../../types';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { useNotificationHistory } from '../../hooks/useNotificationHistory';
import { useLoadOnReach } from '../../hooks/useLoadOnReach';
import { useBellDiary, useBellHub } from '../../hooks/useBellHub';
import { useAttentionRows, sendAttentionSeenItems } from '../../state/attention';
import { markAllSeenItems, historyDayKey, type InboxItem, type InboxModel, type InboxQuietItem } from '../../lib/inboxModel';
import { BELL_GROUP_PREVIEW, bellGroups, type BellGroup, type BellGroupKey } from '../../lib/bellGroups';
import type { DiaryEntry } from '../../lib/hubSystem';
import { openDeepLinkInApp } from '../../lib/deepLinkEntry';
import { openUserMenu } from '../../lib/openUserMenu';
import { WARNING_TEXT, DANGER_TEXT } from '../../lib/popoverStyles';
import { useSharedNow } from '../../state/useSharedNow';
import type { NotificationRow } from '../../../../shared/notification-log';
import { BellTime, DiaryRow, HubRow, RowShell, useBellButton } from './BellRows';

const REASON_ICON: Record<string, LucideIcon> = {
  question: MessageCircleQuestion,
  permission: ShieldAlert,
  plan: ClipboardCheck,
  review: GitPullRequest,
  parked: PauseCircle,
};

const KIND_ICON: Record<string, LucideIcon> = { chat: MessageSquare, terminal: TerminalSquare, card: SquareCheck };

type Tab = 'now' | 'history';

/** How each group is headed: its icon, its colour, its words. */
const GROUP_HEAD: Record<BellGroupKey, { icon: LucideIcon; tone: string; label: string }> = {
  decide: { icon: Hand, tone: WARNING_TEXT, label: 'inbox.section.waiting' },
  broken: { icon: CircleX, tone: DANGER_TEXT, label: 'bell.group.broken' },
  quota: { icon: Gauge, tone: 'text-app-text-muted', label: 'bell.group.quota' },
  look: { icon: Eye, tone: 'text-app-text-muted', label: 'bell.group.look' },
  finished: { icon: CircleCheck, tone: 'text-app-text-muted', label: 'inbox.section.finished' },
};

/** The chip of a group, in the row on top: its short name. */
const GROUP_CHIP: Record<BellGroupKey, string> = {
  decide: 'inbox.section.waiting',
  broken: 'bell.group.broken',
  quota: 'bell.chip.quota',
  look: 'bell.group.look',
  finished: 'inbox.section.finished',
};

/** The chips of the two groups that ask something carry their colour; the others are neutral. */
const CHIP_TONE: Partial<Record<BellGroupKey, string>> = {
  decide: `bg-amber-500/15 hover:bg-amber-500/25 ${WARNING_TEXT}`,
  broken: `bg-red-500/15 hover:bg-red-500/25 ${DANGER_TEXT}`,
};

/** The testids the inbox's specs already read: the two groups of before keep theirs. */
const GROUP_TEST_ID: Partial<Record<BellGroupKey, string>> = { decide: 'inbox-waiting', finished: 'inbox-finished' };

/** Opens a subject where it waits: the chat, the card's drawer, the terminal's pane. */
function openSubject(item: Pick<InboxItem, 'kind' | 'id' | 'title' | 'url'>): void {
  if (item.url) { openDeepLinkInApp(item.url); return; }
  if (item.kind === 'terminal') {
    window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: item.id, name: item.title } }));
  }
}

export default function InboxPanel({ model, onWSMessage, onClose }: {
  model: InboxModel;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [tab, setTab] = useState<Tab>('now');
  const listRef = useRef<HTMLDivElement>(null);
  const history = useNotificationHistory(onWSMessage);
  const reloadHistory = history.reload;
  useEffect(() => { if (tab === 'history') reloadHistory(); }, [tab, reloadHistory]);
  const { hub, present, answering } = useBellHub();
  const diary = useBellDiary(tab === 'history');
  const groups = useMemo(() => bellGroups(model, hub), [model, hub]);
  const nowCount = groups.reduce((n, g) => n + g.entries.length, 0);

  // The focus goes to the first row on open, so ↓/Enter work at once.
  //
  // NOT IN ONE CALL. The `Menu` places its panel in a layout effect and shows
  // it on the commit after (`visibility: hidden` until measured), and this
  // effect runs before that commit: a hidden element refuses `focus()` in
  // silence, so the focus stayed on the bell and ↓/Enter did nothing (seen by
  // tests/e2e/attention-inbox.spec.ts). It tries again on the next frames
  // until the focus takes.
  // Not with a finger: the sheet opens under it, and a row painted as focused
  // there reads as pressed.
  useEffect(() => {
    if (isTouch) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const target = listRef.current?.querySelector<HTMLElement>('[data-inbox-row]') ?? listRef.current;
      target?.focus({ preventScroll: true });
      if (target && document.activeElement !== target && tries++ < 10) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [tab, isTouch]);

  const openItem = useCallback((item: InboxItem) => {
    if (item.tier !== 'needs-you') sendAttentionSeenItems([item.seen]);
    openSubject(item);
    onClose();
  }, [onClose]);
  const markSeen = useCallback((item: InboxItem) => sendAttentionSeenItems([item.seen]), []);
  const markAll = useCallback(() => sendAttentionSeenItems(markAllSeenItems(model)), [model]);
  const jumpTo = useCallback((key: BellGroupKey) => {
    listRef.current?.querySelector<HTMLElement>(`[data-bell-group="${key}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-inbox-row]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
      rows[at === -1 ? 0 : next].focus();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setTab((t) => (t === 'now' ? 'history' : 'now'));
      return;
    }
    if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey && tab === 'now') {
      e.preventDefault();
      if (e.shiftKey) { markAll(); return; }
      const subject = rows[at]?.dataset.subject;
      const item = model.finished.find((f) => f.subject === subject);
      if (!item) return;
      markSeen(item);
      // The focus stays in the list: on the row that takes the place of this one.
      requestAnimationFrame(() => {
        const after = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-inbox-row]') ?? [])];
        (after[Math.min(at, after.length - 1)] ?? listRef.current)?.focus();
      });
    }
  };

  return (
    <div className="flex flex-col min-h-0" style={{ maxHeight: 'min(880px, calc(100dvh - 52px))' }} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 flex-shrink-0">
        <span className={`${isTouch ? 'text-body-lg' : 'text-compact'} font-semibold text-app-text`}>{tr('inbox.title')}</span>
        <div role="tablist" aria-label={tr('inbox.title')} className="ml-auto flex items-center gap-0.5 rounded-md bg-black/[0.05] dark:bg-white/[0.06] p-0.5">
          {(['now', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              data-testid={`inbox-tab-${t}`}
              className={`flex items-center gap-1.5 px-2.5 ${isTouch ? 'h-11 min-w-11' : 'h-6'} rounded text-mini font-medium transition-colors ${
                tab === t ? 'bg-app-bg text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text'
              }`}
            >
              {tr(t === 'now' ? 'inbox.tab.now' : 'inbox.tab.history')}
              {t === 'now' && nowCount > 0 && <span className="text-app-text-muted tabular-nums" data-testid="inbox-now-count">{nowCount}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => { onClose(); openUserMenu('notifications'); }}
          className={`${isTouch ? 'w-11 h-11' : 'w-6 h-6'} flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors cursor-pointer`}
          title={tr('notifications.settings')}
          aria-label={tr('notifications.settings')}
          data-testid="notification-settings-button"
        >
          <Settings size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="h-px bg-app-border flex-shrink-0" />
      {tab === 'now' && groups.length > 1 && <GroupChips groups={groups} onPick={jumpTo} />}

      <div ref={listRef} tabIndex={-1} role="tabpanel" className="overflow-y-auto overscroll-contain min-h-0 outline-none" data-testid={`inbox-panel-${tab}`}>
        {tab === 'now' ? (
          <>
            {groups.length === 0 && (
              <div className="px-4 py-7 text-center" data-testid="inbox-empty">
                <InboxIcon size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
                <div className="text-compact text-app-text-secondary">{tr('inbox.empty')}</div>
              </div>
            )}
            {groups.map((g, gi) => (
              <GroupSection
                key={g.key}
                group={g}
                action={g.key === 'finished' ? (
                  <button
                    type="button"
                    onClick={markAll}
                    className={`ml-auto flex items-center gap-1 ${isTouch ? 'h-11 px-2 text-prose' : 'h-5 pr-0.5 text-compact'} normal-case tracking-normal font-medium text-app-text-secondary hover:text-app-text transition-colors`}
                    data-testid="inbox-mark-all"
                    title={tr('inbox.markAll.hint')}
                  >
                    {tr('inbox.markAll')}
                  </button>
                ) : null}
              >
                {(entry, i) => {
                  const first = gi === 0 && i === 0;
                  if (entry.source === 'topics') {
                    return g.key === 'finished'
                      ? <FinishedRow key={entry.key} item={entry.item} first={first} onOpen={openItem} onMarkSeen={markSeen} />
                      : <DecideRow key={entry.key} item={entry.item} first={first} onOpen={openItem} />;
                  }
                  return <HubRow key={entry.key} entry={entry} first={first} />;
                }}
              </GroupSection>
            ))}
          </>
        ) : (
          <History
            rows={history.rows}
            diary={diary}
            hubPresent={present}
            loading={history.loading}
            hasMore={history.hasMore}
            loadingMore={history.loadingMore}
            loadMore={history.loadMore}
            onClose={onClose}
          />
        )}
      </div>
      <QuietLine working={model.working} hub={present ? (answering ? 'live' : 'down') : null} />
    </div>
  );
}

/** The row of chips on top of «Now»: one per group, with its count, a click scrolls to it. */
function GroupChips({ groups, onPick }: { groups: BellGroup[]; onPick: (key: BellGroupKey) => void }) {
  const tr = useT();
  const { isTouch } = useMobile();
  return (
    <div className={`flex gap-1 overflow-x-auto flex-shrink-0 border-b border-app-border/60 ${isTouch ? 'px-2 py-1.5' : 'px-3 py-1.5'}`} style={{ scrollbarWidth: 'none' }} data-testid="bell-chips">
      {groups.map((g) => (
        <button
          key={g.key}
          type="button"
          tabIndex={-1}
          onClick={() => onPick(g.key)}
          className={`flex items-center gap-[5px] whitespace-nowrap flex-shrink-0 ${isTouch ? 'h-8 px-1.5' : 'h-6 px-2'} rounded-xs text-compact font-medium transition-colors ${CHIP_TONE[g.key] ?? 'bg-black/[0.05] dark:bg-white/[0.06] text-app-text-secondary hover:text-app-text'}`}
          data-testid="bell-chip"
          data-group={g.key}
          data-count={g.entries.length}
        >
          <span className={`tabular-nums font-semibold ${CHIP_TONE[g.key] ? '' : 'text-app-text'}`}>{g.entries.length}</span>
          {tr(GROUP_CHIP[g.key])}
        </button>
      ))}
    </div>
  );
}

/** One group: heading with icon and count, the first rows and «N more» for a hub group. */
function GroupSection({ group, action, children }: {
  group: BellGroup;
  action: ReactNode;
  children: (entry: BellGroup['entries'][number], index: number) => ReactNode;
}) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [all, setAll] = useState(false);
  const head = GROUP_HEAD[group.key];
  const Icon = head.icon;
  const capped = group.key !== 'finished' && !all && group.entries.length > BELL_GROUP_PREVIEW;
  const shown = capped ? group.entries.slice(0, BELL_GROUP_PREVIEW) : group.entries;
  return (
    <section className="pt-px pb-[3px]" data-testid={GROUP_TEST_ID[group.key] ?? `bell-group-${group.key}`} data-bell-group={group.key} data-count={group.entries.length}>
      <h3 className={`flex items-center gap-1.5 ${isTouch ? 'h-[34px] px-3.5 pt-1 text-compact' : 'h-[26px] px-3 pt-0.5 text-mini'} font-semibold uppercase tracking-[.04em] ${head.tone}`}>
        <Icon size={13} aria-hidden="true" />
        {tr(head.label)}
        <span className="tabular-nums font-medium tracking-normal">{group.entries.length}</span>
        {action}
      </h3>
      <ul>{shown.map((entry, i) => children(entry, i))}</ul>
      {capped && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setAll(true)}
          className={`w-full flex items-center gap-1.5 pl-10 ${isTouch ? 'h-11' : 'h-7'} text-mini font-medium text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors`}
          data-testid="bell-more"
        >
          <ChevronDown size={12} aria-hidden="true" />
          {tr('bell.more', { n: group.entries.length - BELL_GROUP_PREVIEW })}
        </button>
      )}
    </section>
  );
}

/** The left edge of a row past which a swipe marks it seen. */
const SWIPE_COMMIT_PX = 72;

/** The words of a row of Topics that waits: what it asks on top, where it is under it. */
function decideText(item: InboxItem, tr: ReturnType<typeof useT>): { title: string; detail: string | null } {
  switch (item.reason) {
    case 'question':
      return item.detail ? { title: item.detail, detail: item.title } : { title: item.title, detail: null };
    case 'permission':
      return item.detail ? { title: tr('bell.topics.permission', { tool: item.detail }), detail: item.title } : { title: item.title, detail: null };
    case 'review':
      return { title: tr('bell.topics.review', { title: item.title }), detail: item.detail };
    case 'plan':
      return { title: tr('bell.topics.plan', { title: item.title }), detail: item.detail };
    default:
      return { title: item.title, detail: item.detail };
  }
}

/** The button of a row of Topics that waits: the verb of what it asks; every one opens it where it waits. */
const DECIDE_ACTION: Partial<Record<string, string>> = {
  question: 'bell.action.answer',
  plan: 'bell.action.openPlan',
  review: 'bell.action.openCard',
};

/** A row of «Decidi tu» from Topics: the same row as the hub's, with the verb of the answer. */
function DecideRow({ item, first, onOpen }: { item: InboxItem; first: boolean; onOpen: (i: InboxItem) => void }) {
  const tr = useT();
  const button = useBellButton();
  const { title, detail } = decideText(item, tr);
  const extra = [detail, item.unread > 1 ? tr('inbox.messages', { n: item.unread }) : null].filter(Boolean).join(' · ');
  return (
    <RowShell
      attrs={{ 'data-testid': 'inbox-row', 'data-subject': item.subject, 'data-tier': item.tier }}
      icon={REASON_ICON[item.reason ?? ''] ?? KIND_ICON[item.kind]}
      tint={WARNING_TEXT}
      first={first}
      onOpen={() => onOpen(item)}
      title={title}
      at={item.since}
      second={(
        <>
          {item.project && <span className="flex-shrink-0 font-medium text-app-text-body">{item.project}</span>}
          {item.project && extra && <span className="flex-shrink-0">·</span>}
          <span className="truncate">{extra || (item.project ? '' : tr(`inbox.reason.${item.reason ?? item.tier}`))}</span>
        </>
      )}
      actions={(
        <button type="button" tabIndex={-1} onClick={() => onOpen(item)} className={button.primary} data-testid="bell-answer">
          {tr(DECIDE_ACTION[item.reason ?? ''] ?? 'bell.open')}
        </button>
      )}
    />
  );
}

/**
 * A row of «Finite»: one line (title, where and what, the time on the right)
 * and the blue dot of the unseen, which becomes «Mark seen» under the pointer.
 * With a finger a swipe to the left marks it seen too.
 */
function FinishedRow({ item, first, onOpen, onMarkSeen }: { item: InboxItem; first: boolean; onOpen: (i: InboxItem) => void; onMarkSeen: (i: InboxItem) => void }) {
  const tr = useT();
  const { isMobile, isTouch } = useMobile();
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const Icon = item.tier === 'error' ? CircleAlert : item.kind === 'card' ? SquareCheck : item.kind === 'terminal' ? TerminalSquare : CircleCheck;
  const tint = item.tier === 'error' ? DANGER_TEXT : 'text-app-text-tertiary';
  const second = [
    item.project,
    item.detail,
    item.unread > 1 ? tr('inbox.messages', { n: item.unread }) : null,
  ].filter(Boolean).join(' · ') || tr(`inbox.reason.${item.reason ?? item.tier}`);

  const swipe = {
    onPointerDown: (e: ReactPointerEvent) => { if (e.pointerType !== 'mouse') start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; },
    onPointerMove: (e: ReactPointerEvent) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const x = e.clientX - s.x;
      if (Math.abs(e.clientY - s.y) > Math.abs(x)) { start.current = null; setDx(0); return; }
      setDx(Math.min(0, x));
    },
    onPointerUp: () => {
      if (start.current && dx <= -SWIPE_COMMIT_PX) onMarkSeen(item);
      start.current = null;
      setDx(0);
    },
    onPointerCancel: () => { start.current = null; setDx(0); },
  };

  return (
    <li className="group/inbox relative" data-testid="inbox-row" data-subject={item.subject} data-tier={item.tier}>
      {dx < 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center pr-4 text-white bg-primary" style={{ width: Math.min(-dx, 160) }} aria-hidden="true">
          <Check size={14} className="ml-auto" />
        </div>
      )}
      <div className="relative flex items-center touch-pan-y hover:bg-app-hover focus-within:bg-app-hover transition-colors" style={dx ? { transform: `translateX(${dx}px)` } : undefined} {...swipe}>
        <button
          type="button"
          data-inbox-row=""
          data-subject={item.subject}
          tabIndex={first ? 0 : -1}
          onClick={() => { if (dx === 0) onOpen(item); }}
          className={`flex-1 min-w-0 flex items-center gap-2.5 text-left outline-none ${isMobile ? 'min-h-11 pl-3.5 pr-1' : 'min-h-[30px] pl-3 pr-1'}`}
        >
          <Icon size={isMobile ? 16 : 15} className={`flex-shrink-0 ${tint}`} aria-hidden="true" />
          <span className={`min-w-0 flex-1 ${isMobile ? 'block' : 'flex items-baseline gap-1.5'}`}>
            <span className={`font-medium text-app-text truncate ${isMobile ? 'block text-body-lg leading-[19px]' : 'flex-shrink-0 max-w-[60%] text-compact'}`}>{item.title}</span>
            <span className={`text-app-text-secondary truncate ${isMobile ? 'block text-prose' : 'flex-[1_1_auto] text-compact'}`}>{second}</span>
          </span>
          <BellTime at={item.since} className={`ml-auto text-app-text-muted ${isMobile ? 'text-prose' : 'text-compact'}`} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onMarkSeen(item)}
          className={`flex-shrink-0 ${isTouch ? 'w-11 h-11 mr-1' : 'w-6 h-6 mr-1.5'} flex items-center justify-center rounded text-app-text-tertiary hover:text-app-text hover:bg-app-hover opacity-100`}
          title={tr('inbox.markSeen')}
          aria-label={tr('inbox.markSeenOf', { name: item.title })}
          data-testid="inbox-mark-seen"
        >
          <span className={`w-1.5 h-1.5 rounded-full bg-primary ${isTouch ? '' : 'group-hover/inbox:hidden group-focus-within/inbox:hidden'}`} aria-hidden="true" />
          {!isTouch && <Check size={14} className="hidden group-hover/inbox:block group-focus-within/inbox:block" aria-hidden="true" />}
        </button>
      </div>
    </li>
  );
}

/** The task kinds the catalogue names; an unknown kind shows its label alone. */
const KNOWN_TASK_KINDS = new Set(['bash', 'agent', 'workflow', 'monitor', 'cron', 'command', 'wake']);

/**
 * THE FOOT OF THE PANEL: «3 at work», grey, no number on the button, opens in
 * place; on its right whether the hub answers («hub live», «hub stopped»).
 * A chat waiting on the job it launched is at work like one that answers: one
 * count, and its row names the job. Outside the list, so it stays in view
 * while the groups scroll. Without anybody at work and without the hub there
 * is no foot at all.
 */
function QuietLine({ working, hub }: { working: InboxQuietItem[]; hub: 'live' | 'down' | null }) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [open, setOpen] = useState(false);
  if (working.length === 0 && hub === null) return null;
  const busy = working.length > 0;
  return (
    // The number as an attribute too: what the line says is copy, and a test
    // that reads copy freezes it (tests/e2e/CONVENTIONS.md).
    <div className="border-t border-app-border flex-shrink-0" data-testid={busy ? 'inbox-quiet' : 'bell-footer'} data-working={working.length} data-hub={hub ?? undefined}>
      {open && busy && (
        <ul className="py-1 border-b border-app-border/60 max-h-48 overflow-y-auto">
          {working.map((q) => {
            const Icon = KIND_ICON[q.kind];
            return (
              <li key={q.subject}>
                <button
                  type="button"
                  data-inbox-row=""
                  tabIndex={-1}
                  onClick={() => openSubject(q)}
                  className={`w-full flex items-center gap-2 pl-5 pr-3 ${isTouch ? 'min-h-11' : 'min-h-8'} text-left hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors`}
                  data-testid="inbox-quiet-row"
                >
                  <Icon size={13} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  <span className="text-compact text-app-text truncate">{q.title}</span>
                  <span className="text-compact text-app-text-muted truncate ml-auto flex-shrink min-w-0">
                    {q.firstTask
                      ? KNOWN_TASK_KINDS.has(q.firstTask.kind) ? `${tr(`inbox.task.${q.firstTask.kind}`)}: ${q.firstTask.label}` : q.firstTask.label
                      : tr('inbox.quiet.atWork')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        data-inbox-row=""
        tabIndex={-1}
        disabled={!busy}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={busy ? open : undefined}
        className={`w-full flex items-center gap-2 ${isTouch ? 'min-h-11 px-3.5 text-prose' : 'min-h-[34px] px-3 text-compact'} text-left text-app-text-secondary enabled:hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors disabled:cursor-default`}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${busy ? 'bg-green-500' : 'bg-app-text-muted'}`} aria-hidden="true" />
        <span className="flex-1 truncate tabular-nums">{busy ? tr('inbox.quiet.working', { n: working.length }) : tr('bell.footer.idle')}</span>
        {hub && <span className="flex-shrink-0 text-app-text-muted">{tr(hub === 'live' ? 'bell.footer.hubLive' : 'bell.footer.hubDown')}</span>}
        {busy && <ChevronDown size={13} className={`flex-shrink-0 text-app-text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />}
      </button>
    </div>
  );
}

type HistoryFilter = 'all' | 'topics' | 'hub';

const HISTORY_FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'bell.history.all' },
  { key: 'topics', label: 'bell.history.topics' },
  { key: 'hub', label: 'bell.history.hub' },
];

type HistoryLine = { at: number; key: string; row: NotificationRow } | { at: number; key: string; diary: DiaryEntry };

/**
 * The log, by day, read only, with the hub's diary merged in by time. A row
 * whose subject is still lit keeps its dot. While older rows of Topics are
 * still to come, the diary shows only what is newer than the last one loaded,
 * so an old run does not sit above a page that has not arrived yet.
 */
function History({ rows, diary, hubPresent, loading, hasMore, loadingMore, loadMore, onClose }: {
  rows: NotificationRow[];
  diary: DiaryEntry[];
  hubPresent: boolean;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  // Infinite scroll, within the hundred rows the panel keeps: the next page comes as its tail comes into view.
  const moreRef = useLoadOnReach(loadMore, { more: hasMore && rows.length < 100, loading: loadingMore, count: rows.length });
  const now = useSharedNow();
  const attention = useAttentionRows();
  const topicsRows = filter === 'hub' ? [] : rows.slice(0, 100);
  const oldestTopics = hasMore && topicsRows.length > 0 ? Date.parse(topicsRows[topicsRows.length - 1]!.createdAt) : Number.NEGATIVE_INFINITY;
  const diaryRows = filter === 'topics' ? [] : diary.filter((d) => filter === 'hub' || d.at >= oldestTopics);
  const lines: HistoryLine[] = [
    ...topicsRows.map((row) => ({ at: Date.parse(row.createdAt), key: `n:${row.id}`, row })),
    ...diaryRows.map((d) => ({ at: d.at, key: d.id, diary: d })),
  ].sort((a, b) => b.at - a.at);

  const chips = hubPresent && (
    <div className="flex gap-1 px-3 py-1.5 border-b border-app-border/60 overflow-x-auto" style={{ scrollbarWidth: 'none' }} role="group" aria-label={tr('bell.history.filter')} data-testid="bell-history-filter">
      {HISTORY_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          tabIndex={-1}
          aria-pressed={filter === f.key}
          onClick={() => setFilter(f.key)}
          className={`flex items-center gap-[5px] whitespace-nowrap px-2 ${isTouch ? 'h-9 text-prose' : 'h-6 text-compact'} rounded-xs border transition-colors ${filter === f.key ? 'border-primary/40 bg-primary/10 text-primary font-medium' : 'border-black/15 dark:border-white/20 text-app-text-secondary hover:bg-app-hover'}`}
          data-testid={`bell-history-${f.key}`}
        >
          {tr(f.label)}
        </button>
      ))}
    </div>
  );

  if (lines.length === 0) {
    return (
      <>
        {chips}
        <div className="px-4 py-7 text-center" data-testid="inbox-history-empty">
          <InboxIcon size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
          <div className="text-compact text-app-text-secondary">{loading ? tr('common.loading') : tr('notifications.empty')}</div>
        </div>
      </>
    );
  }
  const days: { key: string; lines: HistoryLine[] }[] = [];
  for (const l of lines) {
    const key = historyDayKey(new Date(l.at).toISOString(), now);
    if (days.at(-1)?.key !== key) days.push({ key, lines: [] });
    days.at(-1)!.lines.push(l);
  }
  return (
    <div data-testid="inbox-history">
      {chips}
      {days.map((d) => (
        <section key={d.key} className="pb-1">
          <h3 className="px-3 pt-2 pb-0.5 text-mini font-semibold uppercase tracking-[.04em] text-app-text-muted">
            {d.key === 'today' ? tr('inbox.day.today') : d.key === 'yesterday' ? tr('inbox.day.yesterday') : new Date(`${d.key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
          </h3>
          <ul>
            {d.lines.map((l) => ('diary' in l ? <DiaryRow key={l.key} entry={l.diary} /> : <HistoryRow key={l.key} row={l.row} lit={!!l.row.groupKey && !!attention.get(l.row.groupKey)?.lit} onClose={onClose} />))}
          </ul>
        </section>
      ))}
      {filter !== 'hub' && hasMore && rows.length < 100 && (
        <button ref={moreRef} type="button" onClick={loadMore} disabled={loadingMore} className="w-full px-3 py-2 text-mini text-app-text-secondary hover:bg-app-hover transition-colors" data-testid="inbox-history-more">
          {loadingMore ? tr('notifications.loadingMore') : tr('notifications.loadMore')}
        </button>
      )}
    </div>
  );
}

function HistoryRow({ row, lit, onClose }: { row: NotificationRow; lit: boolean; onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const system = row.kind === 'system';
  const Icon = system ? Server : row.groupKey?.startsWith('terminal:') ? TerminalSquare : row.targetKind === 'task' ? SquareCheck : MessageSquare;
  const at = Date.parse(row.createdAt);
  return (
    <li>
      <button
        type="button"
        data-inbox-row=""
        tabIndex={-1}
        disabled={!row.targetUrl}
        onClick={() => { if (row.targetUrl && openDeepLinkInApp(row.targetUrl)) onClose(); }}
        className={`w-full flex items-center gap-2.5 text-left enabled:hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors disabled:cursor-default ${isMobile ? 'min-h-11 pl-3.5 pr-3 py-2' : 'min-h-10 pl-3 pr-2.5 py-1'}`}
        data-testid="inbox-history-row"
        data-lit={lit ? 'true' : undefined}
      >
        <Icon size={15} className="self-start mt-[3px] flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`block font-medium text-app-text truncate ${isMobile ? 'text-body-lg' : 'text-compact leading-4'}`}>{system ? tr('inbox.system') : row.title}</span>
          <span className={`flex items-center gap-[5px] text-app-text-secondary min-w-0 whitespace-nowrap ${isMobile ? 'text-prose' : 'text-compact leading-4'}`}>
            <span className="truncate">{system ? row.title : row.body}</span>
            {Number.isFinite(at) && <span className="flex-shrink-0 text-app-text-muted">·</span>}
            {Number.isFinite(at) && <BellTime at={at} className="text-app-text-muted" />}
          </span>
        </span>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${lit ? 'bg-primary' : 'bg-transparent'}`} aria-hidden="true" />
      </button>
    </li>
  );
}
