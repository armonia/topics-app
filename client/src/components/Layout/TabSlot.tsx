/**
 * THE PARTS OF A TAB THAT CARRY STATE: its one slot, the corner of its lead
 * icon, and the label's tooltip.
 *
 * A tab is three zones (TABSLOT-01): lead icon, label, slot. Before, every
 * signal sat in flow between the label and the edge (project marker, org
 * badge, board counts, the spawned-browser globe, the cloud, console and
 * download cues, the badge, the pin, the elapsed time, the loader, the freeze
 * word), and each one that appeared or changed text squeezed and moved the
 * label. On a busy project tab the label went to zero.
 *
 * Where each of them went:
 *  · the SLOT (`TabSlot`): freeze, working, attention, by `tabSlotSignal`; on
 *    hover or keyboard focus it becomes the one command, by `tabSlotCommand`;
 *  · the CORNER of the lead icon (`ProjectTabLead`, `BrowserTabCornerMark`):
 *    org sharing, a browser's kind or console errors, the project marker,
 *    zero width;
 *  · the TOOLTIP and the accessible name: pin, elapsed time, spawned browser,
 *    cloud, the exact board counts.
 *
 * They live here and not in `PaneTabBar` because each one calls hooks, and the
 * tab bar draws its tabs inside a `panes.map`.
 */
import { useState, type ReactNode } from 'react';
import { FolderTree } from 'lucide-react';
import type { PaneType } from '../../types';
import { tabSlotCommand, tabSlotSignal } from '../../lib/tabSlot';
import { useT } from '../../hooks/useT';
import { usePanePendingStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { SwapFreezeLabel } from '../Shared/SwapFreezeLabel';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useProjectIcon } from '../Shared/projectIconStore';
import { useSharedOrg } from '../../lib/projectSharingStore';
import { SharedOrgBadge } from '../Shared/SharedOrgBadge';
import type { SwapFreezeView } from '../../state/swapFreeze';
import {
  useTopicLoading, useTopicInBackground, useProjectLoading, useProjectBackgroundWork,
  useTerminalLoading, useBrowserLoading, useSessionActivity, useSubjectLastActivity, useProjectWorkStart,
} from '../../state/signals';
import { deriveSubjectTime, formatElapsedCompact } from '../../state/workLongevity';
import { ensurePaneUsageFresh } from '../../lib/paneUsage';
import { STATUS_LABEL } from '../../lib/board';
import { ROW_ACTION_BOX, ROW_ACTION_GLYPH, ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';
import {
  TopicStreamingSpinner, ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner,
  OrbitLoader, LoaderSlot,
} from './StreamingIndicator';
import { useBoardTabCounts } from './BoardTabCounts';

/** The slot's width, in px. Fixed and always reserved (TABSLOT-02). */
const SLOT_PX = 20;

interface TabSlotProps {
  paneId: string;
  type: PaneType;
  /** The tab's name, for the accessible names of its commands. */
  label: string;
  topicId?: string;
  terminalSessionId?: string | null;
  projectPath?: string;
  /** The board this kanban tab counts, when it is a project board. */
  boardProjectPath?: string;
  /** The project tab is the open one: its children's aggregates stay off, the
   *  project window's own bar says them. */
  selected: boolean;
  freeze: SwapFreezeView | null;
  /** Unread / awaiting count the host composed for this tab. */
  attention: number;
  /** Tooltip of the attention number (a project names its children). */
  attentionTitle?: string;
  onFill: boolean;
  closable: boolean;
  onClose: (paneId: string) => void;
  /** The composer's stop for this chat (`useChat.stopSession` via the layout). */
  onStop?: () => void;
}

/**
 * The tab's last zone. Picks the per-type source of "working" (hooks cannot
 * be called by type inside one component) and hands the answer to `SlotView`.
 */
export function TabSlot(props: TabSlotProps) {
  if (props.type === 'chat') return <ChatSlot {...props} />;
  if (props.type === 'project') return <ProjectSlot {...props} />;
  if (props.type === 'terminal') return <TerminalSlot {...props} />;
  if (props.type === 'browser') return <BrowserSlot {...props} />;
  if (props.type === 'board' || props.type === 'kanban') return <BoardSlot {...props} />;
  return <SlotView {...props} working={false} glyph={null} />;
}

function ChatSlot(props: TabSlotProps) {
  const loading = useTopicLoading(props.topicId);
  const background = useTopicInBackground(props.topicId);
  return (
    <SlotView
      {...props}
      working={loading || background}
      canStop={loading && !!props.onStop}
      glyph={<TopicStreamingSpinner topicId={props.topicId} onFill={props.onFill} />}
    />
  );
}

function ProjectSlot(props: TabSlotProps) {
  const path = props.selected ? undefined : props.projectPath;
  const loading = useProjectLoading(path);
  const background = useProjectBackgroundWork(path);
  return (
    <SlotView
      {...props}
      working={loading || background > 0}
      glyph={<ProjectStreamingSpinner projectPath={path} onFill={props.onFill} />}
    />
  );
}

function TerminalSlot(props: TabSlotProps) {
  const working = useTerminalLoading(props.terminalSessionId ?? undefined);
  return <SlotView {...props} working={working} glyph={<TerminalStreamingSpinner sessionId={props.terminalSessionId ?? undefined} />} />;
}

function BrowserSlot(props: TabSlotProps) {
  const working = useBrowserLoading(props.paneId);
  return <SlotView {...props} working={working} glyph={<BrowserStreamingSpinner paneId={props.paneId} />} />;
}

/**
 * A board says what asks for you (cards in review) as the number and what is
 * being worked on (cards in progress) as the ring. Both exact counts are in the
 * tooltip: the slot has room for one number.
 */
function BoardSlot(props: TabSlotProps) {
  const counts = useBoardTabCounts(props.type === 'kanban' ? props.boardProjectPath : undefined);
  const review = counts.find((c) => c.status === 'review')?.n ?? 0;
  const inProgress = counts.find((c) => c.status === 'in_progress')?.n ?? 0;
  const summary = counts.map((c) => `${STATUS_LABEL[c.status]}: ${c.n}`).join(' · ');
  return (
    <SlotView
      {...props}
      attention={review}
      attentionTitle={summary || undefined}
      attentionTestId="tab-board-count-review"
      working={inProgress > 0}
      workingTestId="tab-board-count-in_progress"
      workingCount={inProgress}
      glyph={<LoaderSlot title={summary} />}
    />
  );
}

function SlotView({
  paneId, type, label, freeze, attention, attentionTitle, onFill, closable, onClose, onStop,
  working, canStop = false, glyph, attentionTestId, workingTestId, workingCount,
}: TabSlotProps & {
  working: boolean;
  canStop?: boolean;
  /** The type's own loader, drawn when working and nothing asks for you. */
  glyph: ReactNode;
  attentionTestId?: string;
  workingTestId?: string;
  /** What the ring stands for when it is a count (board cards in progress). */
  workingCount?: number;
}) {
  const tr = useT();
  const pendingStatus = usePanePendingStatus(paneId);
  const signal = tabSlotSignal({ frozen: !!freeze, working, attention });
  const command = tabSlotCommand({ canStop, closable, isProject: type === 'project' });
  const display = signal.kind === 'working' || signal.kind === 'attention'
    ? (signal.count > 99 ? '99+' : String(signal.count))
    : '';

  return (
    // Divs, not spans, for every box around the signal: a text locator on the
    // tab ("the span that reads 3") must find the number and nothing else.
    <div className="tab-slot" data-testid="pane-tab-slot" data-signal={signal.kind} data-command={command ?? undefined}>
      <div className="tab-slot-signal">
        {signal.kind === 'freeze' && freeze && <SwapFreezeLabel freeze={freeze} variant="glyph" />}
        {signal.kind === 'working' && signal.count === 0 && (
          <div className="inline-flex" data-testid={workingTestId} data-count={workingCount}>{glyph}</div>
        )}
        {signal.kind === 'working' && signal.count > 0 && (
          // THE RING AROUND THE NUMBER: working and asking for you at once,
          // in one slot. The same orbit as the loader, at the slot's size.
          <div
            className="relative inline-flex items-center justify-center"
            style={{ width: SLOT_PX, height: SLOT_PX }}
            data-loader-state="working"
            data-testid={workingTestId}
            data-count={workingCount}
            title={attentionTitle}
          >
            {/* The orbit's own box is `relative`, and a class passed to it
                cannot win over that: the wrapper takes it out of flow, or it
                becomes a flex item squeezed beside the number. */}
            <div className="absolute inset-0 flex">
              <OrbitLoader size={SLOT_PX} onFill={onFill} />
            </div>
            <span
              data-notification-count={display}
              data-testid={attentionTestId}
              // "99+" at the micro step is 20.1px, a hair wider than the ring:
              // three figures drop to nano, as they do in the badge.
              className={`relative ${display.length > 2 ? 'text-nano tracking-tight' : 'text-micro'} font-semibold leading-none tabular-nums cap-box ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text'}`}
              aria-label={`${signal.count} unread`}
            >
              {display}
            </span>
          </div>
        )}
        {signal.kind === 'attention' && (
          <NotificationBadge count={signal.count} variant={onFill ? 'onFill' : 'default'} title={attentionTitle} testId={attentionTestId} compact />
        )}
      </div>
      {command && (
        <div className="tab-slot-command" data-pending={pendingStatus ? 'true' : undefined}>
          {command === 'stop' ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onStop?.(); }}
              className={`${ROW_ACTION_BOX} tap-expand-y flex-shrink-0 inline-flex items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer`}
              title={tr('tab.stopTurn')}
              aria-label={tr('tab.stopTurnOn', { name: label })}
              data-testid="pane-tab-stop"
            >
              {/* A filled square: the universal stop, told apart from the
                  close ring by its shape at a glance. */}
              <span className="bg-app-text rounded-[2px]" style={{ width: 8, height: 8 }} />
            </button>
          ) : (
            <PendingActionRing
              status={pendingStatus}
              size={ROW_ACTION_GLYPH}
              boxClassName={ROW_ACTION_BOX}
              className="tap-expand-y"
              testId="pane-tab-close"
              onIdleClick={() => onClose(paneId)}
              idleTitle={tr('tab.close')}
              // The NAME, not the id. The prefix stays first because locators
              // hook onto it and a spoken action comes before its subject.
              idleAriaLabel={tr('tab.closeNamed', { name: label })}
              pendingTitle={tr('tab.cancelClose')}
              pendingAriaLabel={tr('tab.cancelClose')}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A project tab's lead icon, with its corner mark (TABSLOT-03, CHROME-14).
 *
 * A project with a shipped icon shows it, and the "this is a project" marker
 * rides on its corner. Without one, the project-type glyph IS the lead icon,
 * so the marker is always there and the box is always 14px: an icon that was
 * zero wide until the probe answered moved the label when it did. The corner
 * holds one mark at a time, and the org warning wins over the marker, because
 * it is the one that says somebody else reads this session.
 */
export function ProjectTabLead({ path, onFill }: { path: string; onFill: boolean }) {
  const tr = useT();
  const { status } = useProjectIcon(path);
  const org = useSharedOrg(path);
  const ink = onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-secondary';
  const markerGlyph = (size: number) => <FolderTree size={size} />;
  return (
    <span className="relative flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
      {status === 'none' ? (
        <span className={`flex ${ink}`} data-testid="tab-project-marker" title={tr('tab.project')} aria-label={tr('tab.project')} role="img">
          {markerGlyph(14)}
        </span>
      ) : (
        <ProjectFavicon path={path} size={14} />
      )}
      {org ? (
        <span className="tab-corner-mark bg-app-bg text-app-text-secondary ring-1 ring-app-bg">
          <SharedOrgBadge path={path} size={8} />
        </span>
      ) : status !== 'none' && (
        <span className="tab-corner-mark bg-app-bg text-app-text-secondary ring-1 ring-app-bg" data-testid="tab-project-marker" title={tr('tab.project')} aria-label={tr('tab.project')} role="img">
          {markerGlyph(8)}
        </span>
      )}
    </span>
  );
}

/**
 * The label: the only zone that flexes, with a floor of 56px (TABSLOT-01).
 *
 * Its tooltip now also carries what left the tab's face, the elapsed time
 * above all. It is read when the pointer arrives rather than ticking on every
 * tab: a clock nobody looks at is not worth a render every few seconds.
 */
export function TabLabel({
  title, subjectId, projectPath, className, onClick, sheetDoor, children,
}: {
  title: string;
  /** Chat topic or terminal session whose time the tooltip tells. */
  subjectId?: string | null;
  /** A closed project folder: the oldest turn still running inside. */
  projectPath?: string;
  className: string;
  onClick?: (e: React.MouseEvent) => void;
  sheetDoor?: boolean;
  children: ReactNode;
}) {
  const tr = useT();
  const activity = useSessionActivity(subjectId ?? undefined);
  const lastActivityAt = useSubjectLastActivity(subjectId ?? undefined);
  const projectStart = useProjectWorkStart(projectPath);
  const [hoveredAt, setHoveredAt] = useState(0);
  let elapsed = '';
  if (hoveredAt > 0) {
    if (projectStart) {
      const label = formatElapsedCompact(hoveredAt - projectStart);
      if (label) elapsed = tr('activity.runningFor', { label, approx: '' });
    } else {
      const time = deriveSubjectTime(activity, lastActivityAt, hoveredAt);
      const label = time ? formatElapsedCompact(time.ms) : '';
      if (time && label) {
        elapsed = time.kind === 'working'
          ? tr('activity.runningFor', { label, approx: time.approx ? tr('activity.atLeast') : '' })
          : tr('activity.finishedAgo', { label });
      }
    }
  }
  return (
    <span
      // A stable anchor for whoever counts tabs from outside: layout
      // utilities are shared with file-tree and git rows.
      data-testid="pane-tab-label"
      // One of the doors of the browser sheet: pressed while the sheet is
      // open, it closes it instead of opening it again.
      data-sheet-door={sheetDoor ? '' : undefined}
      className={className}
      onClick={onClick}
      onMouseEnter={() => { ensurePaneUsageFresh(); setHoveredAt(Date.now()); }}
      title={elapsed ? `${title}\n${elapsed}` : title}
    >
      {children}
    </span>
  );
}
