import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, PanelLeft, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import {
  CARD_H, ROW_CARD, ROW_GAP, ROW_PX, TAB_GAP_CLASS, TAB_LABEL, TAB_RESTING_SURFACE, TAB_SELECTED_SURFACE,
} from '../../lib/selectionStyles';
import type { Action, TabModel } from '../types';
import type { UiCopy } from '../copy/types';
import { TAB_ICON } from '../icons';
import { IconButton } from '../primitives/Button';
import { MenuButton } from '../primitives/Menu';
import { useMeasuredRef } from '../primitives/scrollEdges';
import { FOCUS_RING, pressable } from './pressable';

/** A tab is 150px wide in the product (`TAB_W` in PaneTabBar) and grows with its name up to 240px. */
const TAB_WIDTH = 150;
const TAB_MAX_WIDTH = 240;
/** Width spent on the glyph, the padding and the close button; the rest is name, at about 6.6px a letter. */
const TAB_CHROME = 60;
const LETTER_PX = 6.6;
/** The longest name a tab shows whole, so that it fits in `TAB_MAX_WIDTH`. */
const TAB_MAX_LETTERS = Math.floor((TAB_MAX_WIDTH - TAB_CHROME) / LETTER_PX);

/** A long name loses its tail at the end of a word, never in the middle of one (the tip says it whole). */
function shortName(label: string): string {
  if (label.length <= TAB_MAX_LETTERS) return label;
  const cut = label.lastIndexOf(' ', TAB_MAX_LETTERS - 1);
  /* One long word with no space to cut at: the strip truncates it. */
  return cut > 0 ? `${label.slice(0, cut)}…` : label;
}

const tabWidth = (label: string) => Math.min(TAB_MAX_WIDTH, Math.max(TAB_WIDTH, Math.ceil(shortName(label).length * LETTER_PX + TAB_CHROME)));
/**
 * Many tabs shrink, as in the product, but not below a width that still reads
 * the name of the place (the glyph, about ten letters, the close button). Past
 * that the strip scrolls and the menu at its end lists every tab.
 */
const TAB_MIN_WIDTH = 132;

/*
 * The tab is a div, not a button: it holds the close button, and a button
 * cannot nest inside another. It is pressable (and a tab stop) only when the
 * container passes `onSelect`.
 */
/** How far the pointer goes before a press on a tab becomes a drag (px). */
const DRAG_THRESHOLD = 4;

function Tab({ tab, closeLabel, previewTip, onSelect, onClose, onPin, onMove }: {
  tab: TabModel;
  closeLabel: string;
  /** What the tooltip of the preview tab says about keeping it. */
  previewTip?: string;
  onSelect?: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  /** A double click on the title keeps the tab. */
  onPin?: (tabId: string) => void;
  /** The tab was dragged: where it lands among the others (its index once it is out of the list). */
  onMove?: (tabId: string, toIndex: number) => void;
}) {
  const Icon = TAB_ICON[tab.kind];
  /* Pointer events, not HTML5 drag: the press is tracked on the tab itself with pointer capture, so no listener is left on the window. */
  const press = useRef<{ x0: number; dragging: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [shift, setShift] = useState<number | null>(null);
  const endPress = () => {
    press.current = null;
    setShift(null);
  };
  const previewing = tab.preview === true && previewTip !== undefined;
  return (
    <div
      role="tab"
      aria-selected={tab.active || undefined}
      data-tab-key={tab.id}
      data-tab-preview={tab.preview === true ? '' : undefined}
      data-tab-pinned={tab.preview === false ? '' : undefined}
      data-tab-dragging={shift !== null ? '' : undefined}
      {...pressable(onSelect && (() => onSelect(tab.id)))}
      /* The click that ends a drag is not a selection. */
      onClickCapture={onMove ? (e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
      } : undefined}
      onDoubleClick={onPin ? (e) => {
        if (e.target instanceof Element && e.target.closest('button')) return;
        onPin(tab.id);
      } : undefined}
      onPointerDown={onMove ? (e) => {
        swallowClick.current = false;
        if (e.button !== 0 || e.pointerType === 'touch' || (e.target instanceof Element && e.target.closest('button'))) return;
        press.current = { x0: e.clientX, dragging: false };
      } : undefined}
      onPointerMove={onMove ? (e) => {
        const p = press.current;
        if (!p) return;
        if (!p.dragging) {
          if (Math.abs(e.clientX - p.x0) < DRAG_THRESHOLD) return;
          p.dragging = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        setShift(e.clientX - p.x0);
      } : undefined}
      onPointerUp={onMove ? (e) => {
        const p = press.current;
        endPress();
        if (!p?.dragging) return;
        swallowClick.current = true;
        const at = e.clientX;
        const others = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=tab]') ?? []).filter((el) => el !== e.currentTarget);
        const to = others.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2 < at;
        }).length;
        onMove(tab.id, to);
      } : undefined}
      onPointerCancel={onMove ? endPress : undefined}
      onLostPointerCapture={onMove ? endPress : undefined}
      onAuxClick={onClose ? (e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      } : undefined}
      /* A definite width, not a flex basis: WebKit sizes the strip on a basis
       * tab's content, so few short tabs came out truncated with room to spare. */
      style={{ width: tabWidth(tab.label), flexShrink: 1, minWidth: TAB_MIN_WIDTH, ...(shift !== null ? { transform: `translateX(${shift}px)`, zIndex: 10, opacity: 0.85 } : null) }}
      data-tip={previewing ? `${tab.label}. ${previewTip}` : tab.label}
      data-tip-clipped={previewing ? undefined : ''}
      className={clsx(
        `group ${ROW_CARD} edge-lit flex items-center ${ROW_GAP} ${ROW_PX} ${CARD_H} ${TAB_LABEL} relative select-none overflow-hidden rounded-lg`,
        onSelect && `cursor-pointer ${FOCUS_RING}`,
        tab.active ? TAB_SELECTED_SURFACE : TAB_RESTING_SURFACE,
      )}
    >
      <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
      <span className={clsx('min-w-0 flex-1 truncate', tab.preview === true && 'italic')}>{shortName(tab.label)}</span>
      {tab.count !== undefined && (
        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[#0a84ff] px-1 text-mini font-semibold leading-none text-white tabular-nums">
          {tab.count}
        </span>
      )}
      {onClose && (
        <button
          type="button"
          aria-label={closeLabel}
          data-tip={closeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className={clsx(
            'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-secondary hover:bg-black/[0.08] dark:hover:bg-white/[0.12]',
            FOCUS_RING,
            tab.active ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The tab strip over the panes: the sidebar toggle, the tabs, the add button,
 * and a free slot on the right for what belongs to the whole window.
 *
 * It owns no state: the container passes `onSelect`/`onClose` (tabs become
 * pressable, each gets a close button, middle click closes), `onAdd`,
 * `onToggleSidebar` and whether the sidebar is open. Without them it is a picture.
 * A tab with `preview` is drawn in italics (`data-tab-preview`); the others
 * carry `data-tab-pinned`. `onPin` (double click) and `onMove` (drag) keep one.
 */
export function TabBar({ tabs, copy, end, moreLabel, previewTip, onSelect, onClose, onPin, onMove, onAdd, onToggleSidebar, sidebarOpen }: {
  tabs: TabModel[];
  copy: UiCopy;
  end?: ReactNode;
  /** Name of the menu that lists every tab; it shows only while the tabs do not all fit. */
  moreLabel?: string;
  /** What the tooltip of the preview tab says about keeping it. */
  previewTip?: string;
  onSelect?: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  /** Double click on a title: the tab is kept. */
  onPin?: (tabId: string) => void;
  /** A tab was dragged to `toIndex` (its place once it is out of the list). */
  onMove?: (tabId: string, toIndex: number) => void;
  onAdd?: Action;
  onToggleSidebar?: Action;
  sidebarOpen?: boolean;
}) {
  const [overflowing, setOverflowing] = useState(false);
  const activeId = tabs.find((t) => t.active)?.id;
  const overflowSeen = useRef(false);
  const revealed = useRef<string | undefined>(undefined);
  /* Measured after every render and when the strip is resized: the tabs do not all fit, so the menu appears; and when the tab on show changes, it is brought into view. */
  const strip = useMeasuredRef<HTMLDivElement>((el) => {
    const over = el.scrollWidth > el.clientWidth + 1;
    if (overflowSeen.current !== over) {
      overflowSeen.current = over;
      setOverflowing(over);
    }
    if (revealed.current === activeId) return;
    revealed.current = activeId;
    el.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 px-1.5">
      <IconButton icon={PanelLeft} label={copy.shell.toggleSidebar} onClick={onToggleSidebar} pressed={sidebarOpen} className="text-app-text-secondary" />
      {/* Many tabs scroll sideways instead of running under the + and the notice; the menu after them reaches the ones out of view. */}
      <div ref={strip} role="tablist" className={`scrollbar-none flex min-w-0 items-center overflow-x-auto py-1 ${TAB_GAP_CLASS}`}>
        {tabs.map((t) => <Tab key={t.id} tab={t} closeLabel={copy.shell.closeTab} previewTip={previewTip} onSelect={onSelect} onClose={onClose} onPin={onPin} onMove={onMove} />)}
      </div>
      {overflowing && moreLabel && onSelect && (
        <MenuButton
          iconOnly
          variant="ghost"
          icon={ChevronDown}
          label={moreLabel}
          align="right"
          items={tabs.map((t) => ({ id: t.id, label: t.label, icon: TAB_ICON[t.kind], checked: t.active, hint: t.count !== undefined ? String(t.count) : undefined }))}
          onSelect={onSelect}
        />
      )}
      <IconButton icon={Plus} label={copy.shell.addTab} onClick={onAdd} className="bg-transparent text-app-text-secondary" />
      <span className="min-w-0 flex-1" />
      {end}
    </div>
  );
}
