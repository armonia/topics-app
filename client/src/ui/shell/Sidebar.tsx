import type { CSSProperties } from 'react';
import { Bell, ChevronsUpDown, Inbox, Kanban, Plus, Search, Workflow, Mail } from 'lucide-react';
import clsx from 'clsx';
import { ROW_GAP, ROW_GLYPH, ROW_GLYPH_SLOT, ROW_H, ROW_PX, TAB_LABEL_TYPE, TAB_SELECTED_SURFACE, ROW_CARD, sidebarRowCard } from '../../lib/selectionStyles';
import type { Action, PinnedTileModel, SidebarModel } from '../types';
import type { UiCopy } from '../copy/types';
import { IconButton } from '../primitives/Button';
import { SectionLabel } from '../primitives/Panel';
import { Avatar, ChatGroupHeading, ChatRow, FilterRow, NavRow, OrgRow, PinnedChatRow } from './SidebarRows';
import { FOCUS_RING, pressable } from './pressable';

/** Width of the product's sidebar, measured on the live app (256px). */
export const SIDEBAR_WIDTH = 256;

const TILE_CLASS = 'flex h-[34px] min-w-0 cursor-pointer items-center justify-center rounded-lg bg-black/[0.05] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.10]';

/** The colour of a tile is drawn for the light theme; on the dark one it is lightened toward white so the letters keep a readable contrast (4.5:1 or more on the tile's fill). */
const TILE_COLOR = 'text-[color:var(--pin)] dark:text-[color:color-mix(in_srgb,var(--pin)_45%,white)]';

/** A tile that carries the program's name rather than a monogram. */
const isNamed = (tile: PinnedTileModel) => (tile.monogram?.length ?? 0) > 2;

/** A pinned tile; with a handler it is a real button, otherwise a picture of one. A tile that carries a name is set in the body size, not the monogram's. */
function PinnedTile({ tile, onClick }: { tile: PinnedTileModel; onClick?: () => void }) {
  const content = tile.kind === 'mail' ? <Mail size={15} className="text-app-text-secondary" aria-hidden="true" /> : tile.monogram;
  const style = tile.color ? ({ '--pin': tile.color } as CSSProperties) : undefined;
  const look = clsx(TILE_CLASS, tile.color && TILE_COLOR, isNamed(tile) ? 'truncate px-2 text-prose font-semibold' : 'text-prose font-bold');
  if (onClick) {
    return (
      <button type="button" data-tip={tile.label} aria-label={tile.label} onClick={onClick} className={clsx(look, 'w-full', FOCUS_RING)} style={style}>
        {content}
      </button>
    );
  }
  return (
    <div data-tip={tile.label} aria-label={tile.label} className={look} style={style}>
      {content}
    </div>
  );
}

/**
 * The product's sidebar: title and chrome buttons, the Board, pinned tiles and
 * chats, then one group per organization (organizations add up like projects,
 * there is no switcher), then the system strip and the identity row.
 *
 * It owns no state. The container passes `onSelect` (called with the id of any
 * row pressed, `'board'` for the Board, an org id for an org without nav
 * items), `onToggleOrg` (the row of an org with nav items; the container flips
 * `expanded`), `onOrgMenu` (an item of an organization's menu) and the three chrome actions. Without handlers it is a picture.
 */
export function Sidebar({ model, copy, onSelect, onToggleOrg, onOrgMenu, onNotifications, onSearch, onNew, onIdentity, identityOpen, className }: {
  model: SidebarModel;
  copy: UiCopy;
  onSelect?: (id: string) => void;
  onToggleOrg?: (orgId: string) => void;
  /** An item of an organization's menu was picked (`OrgModel.menu`); without it the menu is not drawn. */
  onOrgMenu?: (orgId: string, itemId: string) => void;
  onNotifications?: Action;
  onSearch?: Action;
  onNew?: Action;
  /** The identity row becomes a button (who is using Topics). */
  onIdentity?: () => void;
  identityOpen?: boolean;
  className?: string;
}) {
  const s = copy.shell;
  const select = (id: string) => (onSelect ? () => onSelect(id) : undefined);
  const systemLine = model.system ? [model.system.detail, ...model.system.numbers.map(([k, v]) => `${v} ${k}`)].filter(Boolean).join(' · ') : '';
  return (
    <nav aria-label={s.appName} style={{ width: SIDEBAR_WIDTH }} className={clsx('flex h-full shrink-0 flex-col bg-app-chrome', className)}>
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-1.5">
        <span className="px-2 text-title font-semibold leading-7 text-app-text">{s.appName}</span>
        <IconButton icon={Bell} label={s.notifications} onClick={onNotifications}>
          {model.inboxCount ? (
            <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-mini font-semibold leading-none text-black">
              {model.inboxCount}
            </span>
          ) : null}
        </IconButton>
        <span className="flex-1" />
        <IconButton icon={Search} label={s.search} onClick={onSearch} />
        <IconButton icon={Plus} label={s.newItem} onClick={onNew} />
      </div>

      <div role="tree" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {model.board && (
          /* The Board is a grey card even at rest, so the product's selected fill
           * (0.06 on 0.05) would not show: open, it takes the fill of a selected tab. */
          <div
            role={onSelect ? 'treeitem' : undefined}
            {...pressable(select('board'))}
            className={clsx(`${ROW_CARD} flex items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} ${TAB_LABEL_TYPE} cursor-pointer select-none`, sidebarRowCard({ open: true }), model.activeId === 'board' ? `edge-lit ${TAB_SELECTED_SURFACE}` : 'bg-black/[0.05] dark:bg-white/[0.06]', onSelect && FOCUS_RING)}
          >
            <span className={ROW_GLYPH_SLOT}><Kanban size={ROW_GLYPH} className="text-app-text-secondary" aria-hidden="true" /></span>
            <span className="flex-1 text-app-text">{s.board}</span>
            <span className="flex items-center gap-1 text-mini tabular-nums text-app-text-secondary" data-tip={s.boardFlows}>
              <Workflow size={12} aria-hidden="true" />{model.board.flows}
            </span>
            <span className="flex items-center gap-1 text-mini tabular-nums text-app-text-secondary" data-tip={s.boardInbox}>
              <Inbox size={12} aria-hidden="true" />{model.board.inbox}
            </span>
          </div>
        )}

        {model.pinned?.length ? (
          /* Monograms sit four to a row; names, which are longer, two to a row. */
          <div data-sidebar-pins="" className={clsx('my-[3px] grid gap-1.5 px-1.5', model.pinned.some(isNamed) ? 'grid-cols-2' : 'grid-cols-4')} aria-label={s.pinned}>
            {model.pinned.map((t) => <PinnedTile key={t.id} tile={t} onClick={select(t.id)} />)}
          </div>
        ) : null}
        {model.pinnedChats?.map((c) => <PinnedChatRow key={c.id} chat={c} onClick={select(c.id)} />)}
        {(model.board || model.pinned?.length || model.pinnedChats?.length) ? <div className="mx-1.5 my-1.5 h-px bg-app-border-light" /> : null}

        {model.orgs.map((org) => (
          <div key={org.id} role="group">
            <OrgRow
              org={org}
              copy={copy}
              focused={model.activeId === org.id}
              onClick={org.nav?.length ? (onToggleOrg ? () => onToggleOrg(org.id) : undefined) : select(org.id)}
              onMenuSelect={onOrgMenu ? (itemId) => onOrgMenu(org.id, itemId) : undefined}
            />
            {org.expanded && (
              <>
                {org.nav?.map((item) => (
                  <NavRow key={item.id} item={item} label={item.label ?? s.nav[item.kind]} focused={model.activeId === item.id} onClick={select(item.id)} />
                ))}
                {org.chats?.length ? (
                  <ChatGroupHeading label={copy.chat.title} newLabel={copy.chat.newChat} active={org.newChatActive} onNew={select('chat:new')} />
                ) : null}
                {org.chats?.map((chat) => <ChatRow key={chat.id} chat={chat} focused={model.activeId === chat.id} copy={copy} onClick={select(chat.id)} />)}
              </>
            )}
          </div>
        ))}

        {model.filters?.length ? (
          <div className="mt-3">
            <SectionLabel className="mb-1 px-3.5">{s.filters}</SectionLabel>
            {model.filters.map((f) => <FilterRow key={f.id} label={f.label} count={f.count} urgent={f.urgent} focused={model.activeId === f.id} onClick={select(f.id)} />)}
          </div>
        ) : null}
      </div>

      {model.note && <p className="shrink-0 px-3.5 pb-2 text-mini leading-4 text-app-text-tertiary">{model.note}</p>}

      {model.system && (
        <div className="shrink-0 px-3 py-[7px]" data-sidebar-system="">
          <div className="flex items-center gap-1.5 text-prose leading-5">
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', model.system.tone === 'ok' ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden="true" />
            <span className="min-w-0 truncate whitespace-nowrap font-semibold text-app-text">{model.system.headline}</span>
          </div>
          {/* The same type as the line above, never a smaller monospace: one number, one unit, one line. */}
          <p data-tip={systemLine} className="mt-0.5 truncate pl-3.5 text-mini leading-4 text-app-text-tertiary">{systemLine}</p>
        </div>
      )}

      <div className="shrink-0 px-1.5 pb-1.5">
        {onIdentity ? (
          <button
            type="button"
            onClick={onIdentity}
            aria-haspopup="menu"
            aria-expanded={identityOpen ?? false}
            data-sidebar-identity="true"
            data-tip={model.identity.tip ?? model.identity.name}
            className={clsx('flex min-h-[34px] w-full items-center gap-2 rounded-lg bg-black/[0.05] px-2 py-1 text-left text-mini hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.10]', FOCUS_RING)}
          >
            <Avatar text={model.identity.monogram} color={model.identity.color} />
            <span className="min-w-0 flex-1">
              <span className="block truncate leading-4 text-app-text">{model.identity.name}</span>
              {model.identity.detail && <span className="block truncate leading-4 text-app-text-tertiary">{model.identity.detail}</span>}
            </span>
            <ChevronsUpDown size={12} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
          </button>
        ) : (
          <div className="flex min-h-[34px] items-center gap-2 rounded-lg bg-black/[0.05] px-2 py-1 text-mini dark:bg-white/[0.06]">
            <Avatar text={model.identity.monogram} color={model.identity.color} />
            <span className="min-w-0 flex-1">
              <span className="block truncate leading-4 text-app-text">{model.identity.name}</span>
              {model.identity.detail && <span className="block truncate leading-4 text-app-text-tertiary">{model.identity.detail}</span>}
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}
