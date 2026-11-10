import { useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronRight, MessageSquare, MoreHorizontal, Plus } from 'lucide-react';
import clsx from 'clsx';
import {
  ROW_CARD, ROW_GAP, ROW_GLYPH, ROW_GLYPH_SLOT, ROW_H, ROW_PX, ROW_CHEVRON, ROW_CHEVRON_SLOT,
  TAB_LABEL_TYPE, ON_FILL_TEXT_SOFT, sidebarRowCard,
} from '../../lib/selectionStyles';
import type { Attention, NavItemModel, OrgModel, SidebarChatModel } from '../types';
import type { UiCopy } from '../copy/types';
import { NAV_ICON } from '../icons';
import { Count } from '../primitives/Chip';
import { Menu } from '../primitives/Menu';
import { FOCUS_RING, pressable } from './pressable';

/**
 * The rows of the sidebar, drawn with the product's own row grammar
 * (`sidebarRowCard`, ROW_H, ROW_PX from `lib/selectionStyles`): when the
 * product's rows change height or fill, these change with them.
 */

/** A square monogram in the organization's colour, the glyph of its row. */
export function Monogram({ text, color, size = 16 }: { text: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, backgroundColor: color }}
      className="inline-flex shrink-0 items-center justify-center rounded-xs text-mini font-bold leading-none text-white"
    >
      {text}
    </span>
  );
}

/** A round avatar with initials, for a person or a role. */
export function Avatar({ text, color, size = 18 }: { text: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, backgroundColor: color }}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-mini font-bold leading-none text-white"
    >
      {text}
    </span>
  );
}

function RowShell({ focused, attention, nested, depth = 0, className, expanded, onClick, onContextMenu, children }: {
  focused?: boolean;
  attention?: Attention;
  nested?: boolean;
  depth?: number;
  className?: string;
  /** Set on a row that opens and closes a group; omitted on every other row. */
  expanded?: boolean;
  /** Present: the row is pressable (tab stop, Enter/Space, focus ring). */
  onClick?: () => void;
  /** Right click on the row. */
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={focused || undefined}
      aria-expanded={expanded}
      {...pressable(onClick)}
      onContextMenu={onContextMenu}
      style={depth ? { marginLeft: 6 + depth * 16 } : undefined}
      className={clsx(
        `group ${ROW_CARD} flex items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} cursor-pointer ${TAB_LABEL_TYPE} select-none`,
        sidebarRowCard({ focused, attention, nested, open: true }),
        onClick && FOCUS_RING,
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The header row of an organization: grouped like a project, never a switcher.
 * With a handler and nav items it toggles the group (and says so with
 * `aria-expanded`); an organization without nav items has nothing to open.
 * `focused`: the organization's own page is on screen (an organization without sections opens a page).
 *
 * With `org.menu` and `onMenuSelect` the row has a menu: the ⋯ button (seen on
 * hover and on focus, always on a touch screen) opens it under itself, a right
 * click opens it at the pointer. It owns only where the menu is open.
 */
export function OrgRow({ org, copy, focused, onClick, onMenuSelect }: {
  org: OrgModel;
  copy: UiCopy;
  focused?: boolean;
  onClick?: () => void;
  onMenuSelect?: (itemId: string) => void;
}) {
  const onFill = Boolean(org.attention);
  const toggles = Boolean(onClick && org.nav?.length);
  const menu = onMenuSelect && org.menu?.length ? org.menu : undefined;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const label = copy.sarimShell.orgMenu;
  return (
    <RowShell
      attention={org.attention}
      focused={focused}
      onClick={onClick}
      expanded={toggles ? Boolean(org.expanded) : undefined}
      onContextMenu={menu ? (e) => {
        e.preventDefault();
        setAt({ x: e.clientX, y: e.clientY });
      } : undefined}
    >
      <span className={ROW_CHEVRON_SLOT} aria-label={org.expanded ? copy.common.collapse : copy.common.expand}>
        <ChevronRight size={ROW_CHEVRON} className={clsx('transition-transform duration-fast', org.expanded && 'rotate-90')} aria-hidden="true" />
      </span>
      <Monogram text={org.monogram} color={org.color} />
      <span className={clsx('min-w-0 flex-1 truncate', onFill ? 'font-semibold' : 'text-app-text')}>{org.name}</span>
      {menu && (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={at !== null}
          data-tip={label}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ x: r.left, y: r.bottom + 4 });
          }}
          className={clsx(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors coarse:h-7 coarse:w-7',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100',
            onFill ? 'text-inherit hover:bg-white/20' : 'text-app-text-secondary hover:bg-black/[0.08] hover:text-app-text dark:hover:bg-white/[0.12]',
            FOCUS_RING,
            at && 'opacity-100',
          )}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      )}
      {org.age && <span className={clsx('shrink-0 text-mini tabular-nums', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}>{org.age}</span>}
      {org.count !== undefined && <Count value={org.count} onFill={onFill} tone={onFill ? 'neutral' : 'blue'} />}
      {menu && onMenuSelect && at && (
        /* The menu lives inside the row, so a press in it must not reach the row's own handler (it would fold the group). */
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <Menu items={menu} ariaLabel={label} x={at.x} y={at.y} onSelect={onMenuSelect} onClose={() => setAt(null)} />
        </span>
      )}
    </RowShell>
  );
}

/** A surface of an organization (its queue, its flows, its data), nested one step. */
export function NavRow({ item, label, focused, onClick }: { item: NavItemModel; label: string; focused?: boolean; onClick?: () => void }) {
  const Icon = NAV_ICON[item.kind];
  return (
    <RowShell focused={focused} nested depth={1} onClick={onClick}>
      <span className={ROW_GLYPH_SLOT}><Icon size={ROW_GLYPH} aria-hidden="true" /></span>
      <span className={clsx('min-w-0 flex-1 truncate', focused ? 'text-app-text' : 'text-app-text-secondary group-hover:text-app-text')}>{label}</span>
      {item.count !== undefined && (
        <span className={clsx('shrink-0 text-mini tabular-nums', item.urgent ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{item.count}</span>
      )}
    </RowShell>
  );
}

/** The heading of the chats of an organization, with the «+» that starts a new one: a step below the surfaces, as in Topics. */
export function ChatGroupHeading({ label, newLabel, active, onNew }: { label: string; newLabel: string; active?: boolean; onNew?: () => void }) {
  return (
    <div data-sidebar-chats="" style={{ marginLeft: 6 + 16 }} className="mt-2 flex h-6 items-center gap-1 pl-2 pr-2.5">
      <span className="min-w-0 flex-1 truncate text-mini font-semibold text-app-text-tertiary">{label}</span>
      <button
        type="button"
        aria-label={newLabel}
        data-tip={newLabel}
        data-new-chat=""
        onClick={onNew}
        className={clsx(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors coarse:h-7 coarse:w-7',
          active ? 'bg-black/[0.08] text-app-text dark:bg-white/[0.12]' : 'text-app-text-secondary hover:bg-black/[0.08] hover:text-app-text dark:hover:bg-white/[0.12]',
          FOCUS_RING,
        )}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A chat inside an organization, with its age and the sub-agents it started. */
export function ChatRow({ chat, focused, depth = 1, copy, onClick }: { chat: SidebarChatModel; focused?: boolean; depth?: number; copy: UiCopy; onClick?: () => void }) {
  return (
    <>
      <RowShell focused={focused} nested={depth > 0} depth={depth} onClick={onClick}>
        <span className={ROW_GLYPH_SLOT}><MessageSquare size={ROW_GLYPH} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1 truncate text-app-text-secondary group-hover:text-app-text">{chat.title}</span>
        {chat.age && <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{chat.age}</span>}
      </RowShell>
      {chat.subagents ? (
        <div style={{ paddingLeft: 6 + depth * 16 + 30 }} className="flex h-6 items-center gap-1 text-mini text-app-text-tertiary">
          <ChevronRight size={11} aria-hidden="true" />
          {copy.shell.subagents(chat.subagents)}
        </div>
      ) : null}
    </>
  );
}

/** A pinned chat at the top of the sidebar: a resting card, like a pinned tile. */
export function PinnedChatRow({ chat, onClick }: { chat: SidebarChatModel; onClick?: () => void }) {
  return (
    <div {...pressable(onClick)} className={`${onClick ? `${FOCUS_RING} ` : ''}${ROW_CARD} mx-1.5 my-[3px] flex items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} ${TAB_LABEL_TYPE} cursor-pointer select-none rounded-lg bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.10]`}>
      <span className={ROW_GLYPH_SLOT}><MessageSquare size={ROW_GLYPH} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
    </div>
  );
}

/** A filter of the view (Protocollo, Scadute...), a resting card with its count. */
export function FilterRow({ label, count, urgent, focused, onClick }: { label: string; count: number; urgent?: boolean; focused?: boolean; onClick?: () => void }) {
  return (
    <RowShell focused={focused} onClick={onClick}>
      <span className="min-w-0 flex-1 truncate pl-1 text-app-text">{label}</span>
      <span className={clsx('shrink-0 text-mini tabular-nums', urgent ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{count}</span>
    </RowShell>
  );
}
