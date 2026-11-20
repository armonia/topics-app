/**
 * THE BOARD'S ORIGIN FILTERS, one row above the cards: whose work it is and
 * where it came from. It replaces three controls that answered the same
 * question three ways (the «all / mine / others» toggle, the quick filters
 * where «Agents» also counted Jarvis's cards, and the «who closes» grouping).
 *
 *   [My work | All]  You 3 · Agents 54 · Jarvis 24 · Visione 1 · Chats 22 · Scheduled 17  [Channel ▾]  [Needs you 12]  [Hide in progress]
 *
 * Every count says how many cards that choice would show with the other
 * filters as they are, so a chip never reads 0 because of itself.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, EyeOff, Hash, Sparkles } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { BoardTask } from '../../lib/board';
import { CHANNEL_MARKS } from '../../lib/brandIcons';
import { Menu } from '../Shared/Menu';
import { MY_WORK_PRESET, TOOLBAR_CONTROL_H, type BoardFilters } from './constants';
import { NO_CHANNEL, channelPath, channelTree, countOwners, type ChannelNode } from './cardOrigin';
import { BOARD_PRESET_STORAGE_KEY, isPreset, presetFilters, taskMatchesFilters, type BoardPreset } from './taskFilter';
import { taskWaitsOnPerson } from './boardLanes';
import { OwnerGlyph } from './OriginChipView';
import { ownerLabel } from './ownerChip';

const KIND_NAME: Record<string, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };

const chipBase = `flex ${TOOLBAR_CONTROL_H} shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-compact leading-4 coarse:min-h-11 coarse:min-w-11`;
const chipOn = 'border-primary bg-primary/15 text-app-text';
const chipOff = 'border-app-border text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5';

export function OriginFilterBar({ tasks, filters, onChange, personName }: {
  /** The board's cards before any filter. */
  tasks: readonly BoardTask[];
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  personName: string | null;
}) {
  const tr = useT();
  const owners = filters.owners ?? [];
  const channels = filters.channels ?? [];

  const { ownerCounts, tree, noChannel, needsMeCount } = useMemo(() => {
    const ctx = { personName };
    const forOwners = tasks.filter((t) => taskMatchesFilters(t, filters, ctx, { owners: true }));
    const forChannels = tasks.filter((t) => taskMatchesFilters(t, filters, ctx, { channels: true }));
    const forNeeds = tasks.filter((t) => taskMatchesFilters(t, filters, ctx, { needsMe: true }));
    return {
      ownerCounts: countOwners(forOwners, personName),
      tree: channelTree(forChannels),
      noChannel: forChannels.filter((t) => !channelPath(t)).length,
      needsMeCount: forNeeds.filter(taskWaitsOnPerson).length,
    };
  }, [tasks, filters, personName]);

  // A selected owner stays on the row even when no card has it any more, so it can be taken off.
  const shownOwners = [...ownerCounts];
  for (const key of owners) if (!shownOwners.some((o) => o.key === key)) shownOwners.push({ key, count: 0 });

  const myWork = isPreset(filters, MY_WORK_PRESET);
  const everything = !owners.length && !channels.length && !filters.hideInProgress && !filters.needsMe;
  const set = (patch: Partial<BoardFilters>) => onChange({ ...filters, ...patch });
  // The preset picked here is also where the next board seen for the first time opens.
  const pick = (preset: BoardPreset) => {
    try { localStorage.setItem(BOARD_PRESET_STORAGE_KEY, preset); } catch { /* private mode */ }
    set(presetFilters(preset));
  };
  const toggleOwner = (key: string) => set({ owners: owners.includes(key) ? owners.filter((k) => k !== key) : [...owners, key] });

  return (
    <div role="group" aria-label={tr('board.filters.label')} data-testid="board-origin-filters" className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1 scrollbar-none">
      <div role="radiogroup" aria-label={tr('board.filters.preset')} className="mr-1 flex shrink-0 items-center gap-px rounded-full bg-black/5 p-0.5 coarse:p-0 dark:bg-white/5">
        {/* Toolbar-height buttons (24px, never less: WCAG 2.5.8) in a 2px inset, so the
            toggle is 28px and `BoardSkeleton` draws this row 28px tall too. Under a
            finger the buttons are the 44px target themselves and the inset goes. */}
        <button type="button" role="radio" aria-checked={myWork} data-testid="board-preset-mine" title={tr('board.filters.myWorkTitle')}
          onClick={() => pick('mine')}
          className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded-full px-2.5 text-compact leading-4 ${myWork ? 'bg-surface text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text'}`}
        ><Sparkles className="h-3 w-3" aria-hidden="true" />{tr('board.filters.myWork')}</button>
        <button type="button" role="radio" aria-checked={everything} data-testid="board-preset-all" title={tr('board.filters.allTitle')}
          onClick={() => pick('all')}
          className={`flex ${TOOLBAR_CONTROL_H} items-center rounded-full px-2.5 text-compact leading-4 ${everything ? 'bg-surface text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text'}`}
        >{tr('board.filters.all')}</button>
      </div>

      {shownOwners.map(({ key, count }) => {
        const on = owners.includes(key);
        const label = ownerLabel(key, tr);
        return (
          <button key={key} type="button" aria-pressed={on} data-testid={`board-owner-${key.replace(':', '-')}`}
            title={tr('board.filters.ownerTitle', { name: label, count })}
            onClick={() => toggleOwner(key)} className={`${chipBase} ${on ? chipOn : chipOff}`}
          ><OwnerGlyph ownerKey={key} />{label}<span className="tabular-nums text-app-text-muted">{count}</span></button>
        );
      })}

      <span className="mx-1 h-4 w-px shrink-0 bg-app-border" aria-hidden="true" />
      <ChannelPicker tree={tree} noChannel={noChannel} selected={channels} onChange={(next) => set({ channels: next })} />
      <button type="button" aria-pressed={!!filters.needsMe} data-testid="board-needs-me" title={tr('board.filters.needsMeTitle')}
        onClick={() => set({ needsMe: !filters.needsMe })} className={`${chipBase} ${filters.needsMe ? chipOn : chipOff}`}
      >{tr('board.filters.needsMe')}<span className="tabular-nums text-app-text-muted">{needsMeCount}</span></button>
      <button type="button" aria-pressed={!!filters.hideInProgress} data-testid="board-hide-in-progress" title={tr('board.filters.hideInProgressTitle')}
        onClick={() => set({ hideInProgress: !filters.hideInProgress })} className={`${chipBase} ${filters.hideInProgress ? chipOn : chipOff}`}
      ><EyeOff className="h-3 w-3" aria-hidden="true" />{tr('board.filters.hideInProgress')}</button>
    </div>
  );
}

/** The channel a card came from, as a tree: kind, then server, channel, thread. Any level can be picked. */
function ChannelPicker({ tree, noChannel, selected, onChange }: {
  tree: ChannelNode[]; noChannel: number; selected: readonly string[]; onChange: (next: string[]) => void;
}) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const labelOf = (value: string) => {
    if (value === NO_CHANNEL) return tr('board.filters.channelNone');
    const parts = value.split('\u001f');
    return parts.length === 1 ? KIND_NAME[parts[0]!] ?? parts[0]! : parts[parts.length - 1]!;
  };
  const summary = !selected.length ? tr('board.filters.channel') : selected.length === 1 ? labelOf(selected[0]!) : tr('board.filters.channelCount', { count: selected.length });
  const firstKind = selected.length === 1 ? selected[0]!.split('\u001f')[0]! : null;
  const Mark = firstKind ? CHANNEL_MARKS[KIND_NAME[firstKind] ?? ''] : undefined;
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const rows: ChannelNode[] = [];
  const walk = (nodes: ChannelNode[]) => { for (const n of nodes) { rows.push(n); walk(n.children); } };
  walk(tree);

  return (
    <>
      <button ref={btnRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="board-channel-filter"
        onClick={() => setOpen((v) => !v)} title={tr('board.filters.channelTitle')}
        className={`${chipBase} ${selected.length ? chipOn : chipOff}`}
      >{Mark ? <Mark className="h-3 w-3" aria-hidden /> : <Hash className="h-3 w-3" aria-hidden="true" />}<span className="max-w-[10rem] truncate">{summary}</span><ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" /></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={280} className="max-h-[60vh] overflow-y-auto py-1" testId="board-channel-menu" ariaLabel={tr('board.filters.channel')}>
        <MenuRow on={!selected.length} label={tr('board.filters.channelAny')} onClick={() => onChange([])} depth={0} />
        {rows.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('board.filters.channelEmpty')}</p>}
        {rows.map((n) => {
          const KindMark = n.depth === 0 ? CHANNEL_MARKS[KIND_NAME[n.label] ?? ''] : undefined;
          return <MenuRow key={n.value} on={selected.includes(n.value)} depth={n.depth} count={n.count}
            label={n.depth === 0 ? KIND_NAME[n.label] ?? n.label : n.label} icon={KindMark ? <KindMark className="h-3.5 w-3.5" aria-hidden /> : null}
            onClick={() => toggle(n.value)} testId={`board-channel-row-${n.depth}`} />;
        })}
        {noChannel > 0 && <MenuRow on={selected.includes(NO_CHANNEL)} depth={0} count={noChannel} label={tr('board.filters.channelNone')} onClick={() => toggle(NO_CHANNEL)} />}
      </Menu>
    </>
  );
}

function MenuRow({ on, label, onClick, depth, count, icon, testId }: { on: boolean; label: string; onClick: () => void; depth: number; count?: number; icon?: ReactNode; testId?: string }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick} data-testid={testId}
      style={{ paddingLeft: `${0.75 + depth * 0.875}rem` }}
      className="flex w-full items-center gap-2 py-1.5 pr-3 text-left text-compact leading-4 text-app-text hover:bg-black/5 dark:hover:bg-white/5 coarse:min-h-11"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{on && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}</span>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tabular-nums text-app-text-muted">{count}</span>}
    </button>
  );
}
