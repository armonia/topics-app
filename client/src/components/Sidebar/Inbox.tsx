/**
 * «TO LOOK AT»: THE INBOX of the things that are lit (notifications-redesign,
 * design section 9, ATTN-09). It replaces the history button.
 *
 * The button carries THE number (the lit subjects, the Dock's), amber when
 * one of them waits for you, nothing at zero. The panel has two tabs:
 *   - «Now»: «Waiting for you» (the oldest first, no way to switch one off
 *     but answering it), then «Finished» (the most recent first, each with
 *     «Mark seen», and «Mark all seen» at the end of the section), then a
 *     quiet line «2 in background · 1 at work» that opens in place;
 *   - «History»: the log, by day, read only, with no number on its tab.
 * OPENING THE PANEL MARKS NOTHING (choice 4). A row opens its subject where it
 * waits (the chat, the card's drawer, the terminal) and, for a finished one,
 * marks it seen with the epoch the row showed.
 *
 * Keyboard: ⇧⌘I opens it, ↑/↓ move, Enter opens, E marks seen, ⇧E marks all
 * seen, ←/→ change tab, Esc closes and gives the focus back to the button. One
 * tab stop in, one out: the rows are a roving list. Touch: rows of 56px with
 * 44px targets, a bottom sheet under 768px (the `Menu` primitive), and a swipe
 * to the left on a finished row marks it seen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Bell, Check, CheckCheck, ChevronDown, ClipboardCheck, CircleAlert, CircleCheck, GitPullRequest, Inbox as InboxIcon,
  MessageCircleQuestion, MessageSquare, PauseCircle, Settings, ShieldAlert, SquareCheck, TerminalSquare, Server, type LucideIcon,
} from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { RelativeTime } from '../Shared/RelativeTime';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useNotificationHistory } from '../../hooks/useNotificationHistory';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useAttentionRows, sendAttentionSeenItems } from '../../state/attention';
import { useBoardTasks } from '../../lib/boardTasksStore';
import { inboxModel, markAllSeenItems, historyDayKey, type InboxItem, type InboxQuietItem } from '../../lib/inboxModel';
import { OPEN_INBOX_EVENT } from '../../lib/inboxEvents';
import { openDeepLinkInApp } from '../../lib/deepLinkEntry';
import { openUserMenu } from '../../lib/openUserMenu';
import { RAISED_CONTROL } from '../../lib/selectionStyles';
import { WARNING_TEXT, DANGER_TEXT } from '../../lib/popoverStyles';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { useSharedNow } from '../../state/useSharedNow';
import type { NotificationRow } from '../../../../shared/notification-log';

const PANEL_W = 380;

const REASON_ICON: Record<string, LucideIcon> = {
  question: MessageCircleQuestion,
  permission: ShieldAlert,
  plan: ClipboardCheck,
  review: GitPullRequest,
  parked: PauseCircle,
};

const KIND_ICON: Record<string, LucideIcon> = { chat: MessageSquare, terminal: TerminalSquare, card: SquareCheck };

type Tab = 'now' | 'history';

/** Opens a subject where it waits: the chat, the card's drawer, the terminal's pane. */
function openSubject(item: Pick<InboxItem, 'kind' | 'id' | 'title' | 'url'>): void {
  if (item.url) { openDeepLinkInApp(item.url); return; }
  if (item.kind === 'terminal') {
    window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: item.id, name: item.title } }));
  }
}

export function Inbox({
  onWSMessage,
  isMobile = false,
  className = '',
}: {
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  isMobile?: boolean;
  className?: string;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { attentionTotal } = useTabNotifications();
  const attention = useAttentionRows();
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const cards = useBoardTasks();
  const model = useMemo(() => inboxModel(attention, topics, terminalSessions, cards), [attention, topics, terminalSessions, cards]);
  const waitingCount = model.waiting.length;

  // ⇧⌘I: the chord announces, the button answers.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_INBOX_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_INBOX_EVENT, onOpen);
  }, []);

  const label = attentionTotal > 0
    ? tr('inbox.button.count', { n: attentionTotal, m: waitingCount })
    : tr('inbox.title');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        // The same box as its neighbours on the row (Search and «+»): 44 with
        // a finger, 28 with a mouse.
        className={`edge-lit relative ${isMobile ? 'h-11 w-11' : 'h-7 w-7'} flex items-center justify-center rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag ${className}`}
        // The attribute, not only the class: under Tauri it is what gives up
        // dragging the window (tests/e2e/drag-regions.spec.ts).
        {...NO_DRAG_REGION}
        style={{ pointerEvents: 'auto' }}
        title={tr('inbox.title')}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="inbox-button"
        data-waiting={waitingCount > 0 ? 'true' : undefined}
      >
        <Bell size={isMobile ? 18 : 14} aria-hidden="true" />
        <NotificationBadge
          count={attentionTotal}
          variant={waitingCount > 0 ? 'needsYou' : 'default'}
          className="absolute -top-1 -right-1"
          ariaLabel={label}
          testId="inbox-count"
        />
      </button>
      <Menu
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        role="dialog"
        ariaLabel={tr('inbox.title')}
        minWidth={PANEL_W}
        maxWidth={PANEL_W}
        unmanagedFocus
        testId="inbox-panel"
        className="flex flex-col overflow-hidden"
      >
        <InboxPanel model={model} onWSMessage={onWSMessage} onClose={() => setOpen(false)} />
      </Menu>
    </>
  );
}

function InboxPanel({ model, onWSMessage, onClose }: {
  model: ReturnType<typeof inboxModel>;
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

  const empty = model.waiting.length === 0 && model.finished.length === 0;

  return (
    <div className="flex flex-col min-h-0" style={{ maxHeight: 'min(560px, calc(100dvh - 6rem))' }} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 flex-shrink-0">
        <span className="text-compact font-semibold text-app-text">{tr('inbox.title')}</span>
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
              className={`px-2.5 ${isTouch ? 'h-9' : 'h-6'} rounded text-mini font-medium transition-colors ${
                tab === t ? 'bg-app-bg text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text'
              }`}
            >
              {tr(t === 'now' ? 'inbox.tab.now' : 'inbox.tab.history')}
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

      <div ref={listRef} tabIndex={-1} role="tabpanel" className="overflow-y-auto overscroll-contain min-h-0 outline-none" data-testid={`inbox-panel-${tab}`}>
        {tab === 'now' ? (
          <>
            {empty && (
              <div className="px-4 py-7 text-center" data-testid="inbox-empty">
                <InboxIcon size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
                <div className="text-compact text-app-text-secondary">{tr('inbox.empty')}</div>
              </div>
            )}
            {model.waiting.length > 0 && (
              <Section title={tr('inbox.section.waiting')} tone="needs-you" testId="inbox-waiting">
                {model.waiting.map((item, i) => (
                  <Row key={item.subject} item={item} first={i === 0} onOpen={openItem} />
                ))}
              </Section>
            )}
            {model.finished.length > 0 && (
              <Section title={tr('inbox.section.finished')} tone="done" testId="inbox-finished">
                {model.finished.map((item, i) => (
                  <Row key={item.subject} item={item} first={i === 0 && model.waiting.length === 0} onOpen={openItem} onMarkSeen={markSeen} />
                ))}
                <button
                  type="button"
                  onClick={markAll}
                  className={`w-full flex items-center justify-center gap-1.5 ${isTouch ? 'h-11' : 'h-8'} text-mini font-medium text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors`}
                  data-testid="inbox-mark-all"
                  title={tr('inbox.markAll.hint')}
                >
                  <CheckCheck size={13} aria-hidden="true" />
                  {tr('inbox.markAll')}
                </button>
              </Section>
            )}
            <QuietLine background={model.background} working={model.working} />
          </>
        ) : (
          <History rows={history.rows} loading={history.loading} hasMore={history.hasMore} loadingMore={history.loadingMore} loadMore={history.loadMore} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function Section({ title, tone, testId, children }: { title: string; tone: 'needs-you' | 'done'; testId: string; children: React.ReactNode }) {
  return (
    <section className="py-1" data-testid={testId}>
      <h3 className={`px-3 pt-1.5 pb-1 text-micro font-semibold uppercase tracking-wide ${tone === 'needs-you' ? WARNING_TEXT : 'text-app-text-muted'}`}>
        {title}
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

/** The left edge of a row past which a swipe marks it seen. */
const SWIPE_COMMIT_PX = 72;

function Row({ item, first, onOpen, onMarkSeen }: { item: InboxItem; first: boolean; onOpen: (i: InboxItem) => void; onMarkSeen?: (i: InboxItem) => void }) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const Icon = item.tier === 'needs-you' ? (REASON_ICON[item.reason ?? ''] ?? KIND_ICON[item.kind]) : item.tier === 'error' ? CircleAlert : CircleCheck;
  const tint = item.tier === 'needs-you' ? WARNING_TEXT : item.tier === 'error' ? DANGER_TEXT : 'text-[#0a84ff]';
  const second = [
    item.detail,
    item.unread > 1 ? tr('inbox.messages', { n: item.unread }) : null,
  ].filter(Boolean).join(' · ') || tr(`inbox.reason.${item.reason ?? item.tier}`);

  // The swipe to the left, on a finished row only: nothing destructive on «Waiting for you».
  const swipe = onMarkSeen ? {
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
  } : {};

  return (
    <li className="group/inbox relative" data-testid="inbox-row" data-subject={item.subject} data-tier={item.tier}>
      {onMarkSeen && dx < 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center pr-4 text-mini font-medium text-white bg-[#0a84ff]" style={{ width: Math.min(-dx, 160) }} aria-hidden="true">
          <Check size={14} className="ml-auto" />
        </div>
      )}
      <div className={`relative flex items-center bg-transparent${swipe ? ' touch-pan-y' : ''}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined} {...swipe}>
        <button
          type="button"
          data-inbox-row=""
          data-subject={item.subject}
          tabIndex={first ? 0 : -1}
          onClick={() => { if (dx === 0) onOpen(item); }}
          className="flex-1 min-w-0 min-h-14 flex items-center gap-2.5 pl-3 pr-2 py-2 text-left hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors"
        >
          <Icon size={15} className={`flex-shrink-0 ${tint}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-compact font-medium text-app-text truncate min-w-0">{item.title}</span>
              {/* The project gives way to the title only past 40%: a short
                  name stays whole instead of shrinking to one letter. */}
              {item.project && <span className="text-micro text-app-text-muted truncate flex-shrink-0 max-w-[40%]">{item.project}</span>}
              <RelativeTime at={item.since} className="text-micro text-app-text-muted tabular-nums flex-shrink-0 ml-auto" />
            </span>
            <span className="block text-mini text-app-text-secondary truncate">{second}</span>
          </span>
          {/* A row with no «Mark seen» keeps the room of that button INSIDE
              itself (its box, 28 or 44, plus the 6 of margin, minus the gap),
              so the times of «Waiting for you» and «Finished» stand in one
              column and the highlight still spans the row. */}
          {!onMarkSeen && <span aria-hidden="true" className={`flex-shrink-0 ${isTouch ? 'w-10' : 'w-6'}`} />}
        </button>
        {onMarkSeen && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onMarkSeen(item)}
            className={`flex-shrink-0 mr-1.5 ${isTouch ? 'w-11 h-11 opacity-100' : 'w-7 h-7 opacity-0 group-hover/inbox:opacity-100 group-focus-within/inbox:opacity-100'} flex items-center justify-center rounded text-app-text-tertiary hover:text-app-text hover:bg-app-hover transition-opacity`}
            title={tr('inbox.markSeen')}
            aria-label={tr('inbox.markSeenOf', { name: item.title })}
            data-testid="inbox-mark-seen"
          >
            <Check size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

/** The task kinds the catalogue names; an unknown kind shows its label alone. */
const KNOWN_TASK_KINDS = new Set(['bash', 'agent', 'workflow', 'monitor', 'cron', 'command', 'wake']);

/** «2 in background · 1 at work»: grey, no number on the button, opens in place. */
function QuietLine({ background, working }: { background: InboxQuietItem[]; working: InboxQuietItem[] }) {
  const tr = useT();
  const { isTouch } = useMobile();
  const [open, setOpen] = useState(false);
  if (background.length === 0 && working.length === 0) return null;
  const parts = [
    background.length > 0 ? tr('inbox.quiet.background', { n: background.length }) : null,
    working.length > 0 ? tr('inbox.quiet.working', { n: working.length }) : null,
  ].filter(Boolean).join(' · ');
  const all = [...background.map((q) => ({ q, background: true })), ...working.map((q) => ({ q, background: false }))];
  return (
    // The two numbers as attributes too: what the line says is copy, and a
    // test that reads copy freezes it (tests/e2e/CONVENTIONS.md).
    <div className="border-t border-app-border" data-testid="inbox-quiet" data-background={background.length} data-working={working.length}>
      <button
        type="button"
        data-inbox-row=""
        tabIndex={-1}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full flex items-center gap-2 px-3 ${isTouch ? 'min-h-11' : 'min-h-9'} text-left text-mini text-app-text-secondary hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors`}
      >
        <span className="flex-1 truncate">{parts}</span>
        <ChevronDown size={13} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <ul className="pb-1.5">
          {all.map(({ q, background: bg }) => {
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
                  <span className="text-mini text-app-text truncate">{q.title}</span>
                  <span className="text-micro text-app-text-muted truncate ml-auto flex-shrink min-w-0">
                    {bg && q.firstTask
                      ? KNOWN_TASK_KINDS.has(q.firstTask.kind) ? `${tr(`inbox.task.${q.firstTask.kind}`)}: ${q.firstTask.label}` : q.firstTask.label
                      : tr(bg ? 'inbox.quiet.inBackground' : 'inbox.quiet.atWork')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The log, by day, read only. A row whose subject is still lit keeps its dot. */
function History({ rows, loading, hasMore, loadingMore, loadMore, onClose }: {
  rows: NotificationRow[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const now = useSharedNow();
  const attention = useAttentionRows();
  const shown = rows.slice(0, 100);
  if (shown.length === 0) {
    return (
      <div className="px-4 py-7 text-center" data-testid="inbox-history-empty">
        <InboxIcon size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
        <div className="text-compact text-app-text-secondary">{loading ? tr('common.loading') : tr('notifications.empty')}</div>
      </div>
    );
  }
  const days: { key: string; rows: NotificationRow[] }[] = [];
  for (const r of shown) {
    const key = historyDayKey(r.createdAt, now);
    if (days.at(-1)?.key !== key) days.push({ key, rows: [] });
    days.at(-1)!.rows.push(r);
  }
  return (
    <div data-testid="inbox-history">
      {days.map((d) => (
        <section key={d.key} className="py-1">
          <h3 className="px-3 pt-1.5 pb-1 text-micro font-semibold uppercase tracking-wide text-app-text-muted">
            {d.key === 'today' ? tr('inbox.day.today') : d.key === 'yesterday' ? tr('inbox.day.yesterday') : new Date(`${d.key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
          </h3>
          <ul>
            {d.rows.map((row) => {
              const system = row.kind === 'system';
              const Icon = system ? Server : row.groupKey?.startsWith('terminal:') ? TerminalSquare : row.targetKind === 'task' ? SquareCheck : MessageSquare;
              const lit = !!row.groupKey && !!attention.get(row.groupKey)?.lit;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    data-inbox-row=""
                    tabIndex={-1}
                    disabled={!row.targetUrl}
                    onClick={() => { if (row.targetUrl && openDeepLinkInApp(row.targetUrl)) onClose(); }}
                    className="w-full flex items-start gap-2.5 px-3 py-2 min-h-11 text-left enabled:hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors disabled:cursor-default"
                    data-testid="inbox-history-row"
                    data-lit={lit ? 'true' : undefined}
                  >
                    <Icon size={13} className="mt-0.5 flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-compact font-medium text-app-text truncate">{system ? tr('inbox.system') : row.title}</span>
                        <RelativeTime at={row.createdAt} className="text-micro text-app-text-muted tabular-nums flex-shrink-0 ml-auto" />
                      </span>
                      <span className="block text-mini text-app-text-secondary truncate">{system ? row.title : row.body}</span>
                    </span>
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${lit ? 'bg-primary' : 'bg-transparent'}`} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {hasMore && rows.length < 100 && (
        <button type="button" onClick={loadMore} disabled={loadingMore} className="w-full px-3 py-2 text-mini text-app-text-secondary hover:bg-app-hover transition-colors" data-testid="inbox-history-more">
          {loadingMore ? tr('notifications.loadingMore') : tr('notifications.loadMore')}
        </button>
      )}
    </div>
  );
}
