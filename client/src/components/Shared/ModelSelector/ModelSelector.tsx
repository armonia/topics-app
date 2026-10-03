/**
 * ModelSelector: THE one model selector (MSEL-01).
 *
 * Every surface that picks a provider and a model for a chat or a card opens
 * this popover: the chat composer, the card composer and drawer (variant
 * `compact`), the board default, the chat settings and the default model of a
 * provider (variant `full`). The board card reads its choice with
 * `ModelRouteText` (variant `chip`) and opens the compact one.
 *
 * It owns the `Menu` around the list, so width, height, placement and the
 * phone sheet are decided here and nowhere else: the four `minWidth` the
 * callers used to pass were dead (the panel was fixed at 22rem), and a
 * difference between two surfaces that does not come from the variant or the
 * scope is a defect. The trigger stays with the caller: its look and its
 * `data-testid` belong to the surface.
 *
 * Layout (MSEL-02): from 720px of window up, one column per company side by
 * side, each scrolling on its own under a fixed heading; below, one list, and
 * under 768px the `Menu` sheet from the bottom. Band, search and Automatic
 * never scroll: only the sections do, inside a height taken from the free
 * space on the side the popover opens.
 */
import { Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { Menu } from '../Menu';
import { useMobile } from '../../../hooks/useMobile';
import { ModelList, loadModelList, modelListReady } from './modelListLazy';
import type { ModelListProps } from './ModelList';

/** Columns from here up (design §4). */
const COLUMNS_FROM_PX = 720;
/** Room kept between the panel and the edge of the window, in px. */
const EDGE_PX = 16;

export interface ModelSelectorProps extends Omit<ModelListProps, 'layout' | 'focusSearch'> {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  testId?: string;
  ariaLabel?: string;
}

function useViewportWidth(open: boolean): number {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    if (!open) return;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);
  return width;
}

export function ModelSelector({ open, anchorRef, align, testId, ariaLabel, onClose, ...list }: ModelSelectorProps) {
  const { isMobile } = useMobile();
  const width = useViewportWidth(open);
  const columns = width >= COLUMNS_FROM_PX;
  const [ready, setReady] = useState(modelListReady);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  // The body is a chunk of its own: the popover opens once it is there, so
  // `Menu` places and focuses a panel that already holds its rows.
  useEffect(() => {
    if (!open || ready) return;
    let alive = true;
    loadModelList().then(() => { if (alive) setReady(true); }, () => { /* the loader raises the reload prompt */ });
    return () => { alive = false; };
  }, [open, ready]);

  // Desktop height: the free space on the roomier side of the trigger, which
  // is the side `computeMenuPosition` opens on when the panel does not fit
  // below, minus a margin. `Menu` gives the desktop popover no ceiling.
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setMaxHeight(Math.max(below, above) - EDGE_PX - 8);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, isMobile, anchorRef]);

  const panelWidth = isMobile ? undefined : columns ? 'min(44rem, calc(100vw - 2rem))' : 'min(22rem, calc(100vw - 1rem))';
  return (
    <Menu
      open={open && ready}
      anchorRef={anchorRef}
      onClose={onClose}
      align={align}
      role="dialog"
      minWidth={0}
      className="overflow-hidden"
      testId={testId}
      ariaLabel={ariaLabel}
    >
      <div
        className="flex flex-col"
        style={{
          width: panelWidth,
          // The phone sheet keeps `Menu`'s own ceiling; inside it the sections
          // scroll, so the band and the search stay put while the list moves.
          maxHeight: isMobile ? 'calc(100dvh - 5.5rem)' : maxHeight ?? undefined,
        }}
      >
        <Suspense fallback={null}>
          <ModelList
            {...list}
            // A choice closes the popover and gives the focus back to the
            // trigger (MSEL-08, MP-TASK-07), after whatever the surface does
            // with the choice in the same pass.
            onSelect={(selection) => {
              list.onSelect(selection);
              requestAnimationFrame(() => requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true })));
            }}
            onClose={onClose}
            layout={columns ? 'columns' : 'list'}
            focusSearch={!isMobile}
          />
        </Suspense>
      </div>
    </Menu>
  );
}
