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
 * Layout (MSEL-02, amended 2026-10-06): one vertical list of company
 * sections on every viewport; under 768px the `Menu` sheet from the bottom.
 * The side-by-side columns (revision 2026-10-04 §3.4) read as a mess once the
 * companies grew past three, so this selector no longer picks them; `ModelList`
 * keeps `columns` as a tested layout value, unused from here. Band, search and
 * Automatic never scroll: only the sections do, inside a height of at most
 * `min(456, room on the roomier side - 16)` (§4.2).
 *
 * Providers and keys is a LEVEL of this panel (revision §5.1, Ribaltamento 2):
 * the foot, «Sistema ›» and the connect boxes put the providers' levels over
 * the models, in the same box (same x, y and width), while the models stay
 * mounted underneath, so ‹ and Escape find the search, the open sections and
 * the scroll as they were. A second Escape closes the panel, and the focus
 * goes back to the trigger.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '../Menu';
import { useMobile } from '../../../hooks/useMobile';
import { ModelList, loadModelList, modelListReady } from './modelListLazy';
import type { ModelListProps } from './ModelList';
import type { ProvidersTarget } from '../../Settings/AIProvidersSection';

// The levels load the first time somebody opens them: the foot is one row of
// every selector, the forms behind it are not.
const ProvidersLevels = lazy(async () => {
  const { ProvidersLevels: Levels } = await import('../../Settings/AIProvidersSection');
  return { default: Levels };
});

/** Room kept between the panel and the edge of the window, in px. */
const EDGE_PX = 16;
/** The tallest the desktop panel gets (revision §4.2). */
const MAX_PANEL_PX = 456;
/** The popover surface around the body: `py-1` and a 1px border. */
const SURFACE_CHROME_PX = 10;

export interface ModelSelectorProps extends Omit<ModelListProps, 'layout' | 'focusSearch' | 'onSelect' | 'onOpenProviders'> {
  onSelect: (selection: ModelListProps['value']) => void;
  open: boolean;
  /** Open on the providers level (or one account's detail) instead of the
   *  models: a door outside the panel asked for it (`/usage`, the palette). */
  initialLevel?: ProvidersTarget | null;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  testId?: string;
  ariaLabel?: string;
}

export function ModelSelector({ open, anchorRef, align, testId, ariaLabel, onClose, initialLevel, ...list }: ModelSelectorProps) {
  const { isMobile } = useMobile();
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

  // Desktop height: at most 456 px and the free space on the roomier side of
  // the trigger minus a margin. A panel that high always fits on that side,
  // which is the side `computeMenuPosition` opens on when it does not fit
  // below: side, top and ceiling come from the same side (AC-10). `Menu`
  // gives the desktop popover no ceiling.
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setMaxHeight(Math.min(MAX_PANEL_PX, Math.max(below, above) - EDGE_PX) - SURFACE_CHROME_PX);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, isMobile, anchorRef]);

  // On close the focus belongs to the trigger (MSEL-08). The menu gives it
  // back to what held it when the panel opened, and inside another surface
  // (the board settings, the chat settings dialog) WebKit leaves that to the
  // surface's own container, since it does not focus a button on click: the
  // focus is then moved on to the trigger, and only from such a container or
  // from nowhere, never from a control the person moved to.
  const close = () => {
    onClose();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const anchor = anchorRef.current;
      const active = document.activeElement as HTMLElement | null;
      const container = !!active && active !== anchor && !!anchor && active.contains(anchor);
      if (anchor?.isConnected && (!active || active === document.body || container)) anchor.focus({ preventScroll: true });
    }));
  };

  const panelWidth = isMobile ? undefined : 'min(22rem, calc(100vw - 1rem))';
  return (
    <Menu
      open={open && ready}
      anchorRef={anchorRef}
      onClose={close}
      align={align}
      role="dialog"
      minWidth={0}
      className="overflow-hidden"
      testId={testId}
      ariaLabel={ariaLabel}
    >
      <SelectorBody
        // A door that asks for another level while the panel is open starts
        // the inside again on that level.
        key={initialLevel ? `${initialLevel.account ?? ''}|${initialLevel.focus ?? ''}` : 'models'}
        list={list}
        anchorRef={anchorRef}
        onClose={close}
        initialLevel={initialLevel ?? null}
        isMobile={isMobile}
        style={{
          width: panelWidth,
          // The phone sheet keeps `Menu`'s own ceiling; inside it the sections
          // scroll, so the band and the search stay put while the list moves.
          maxHeight: isMobile ? 'calc(100dvh - 5.5rem)' : maxHeight ?? undefined,
        }}
        levelHeight={isMobile ? 'min(32rem, calc(100dvh - 5.5rem))' : maxHeight ?? undefined}
        ceiling={isMobile ? null : maxHeight}
      />
    </Menu>
  );
}

/**
 * The inside of the panel, mounted on every opening (the `Menu` drops its
 * children when closed), so a level chosen in one opening does not survive it.
 */
function SelectorBody({ list, anchorRef, onClose, initialLevel, isMobile, style, levelHeight, ceiling }: {
  list: Omit<ModelSelectorProps, 'open' | 'anchorRef' | 'align' | 'testId' | 'ariaLabel' | 'onClose' | 'initialLevel'>;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  initialLevel: ProvidersTarget | null;
  isMobile: boolean;
  style: React.CSSProperties;
  /** A level takes the panel's full height when the models are shorter. */
  levelHeight: number | string | undefined;
  /** The desktop body's `max-height`: the floor never goes over it. */
  ceiling: number | null;
}) {
  const [level, setLevel] = useState<ProvidersTarget | null>(initialLevel);
  const opener = useRef<HTMLElement | null>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // On desktop the panel does not shrink while it is open. `Menu` places it
  // again on every resize, so a search that left five rows moved it: above
  // the chip it hung 150 px off it, and back from the providers level it
  // jumped below the chip (seen in WebKit, 04/10). It still grows, up to the
  // ceiling, when a fold opens. The floor is held under the ceiling: it may
  // have been measured before the ceiling applied (the whole catalog, 3009 px
  // with jcode's ids) or before the window shrank, and in CSS a min-height
  // beats a max-height, so an unbounded floor covered the trigger or ran out
  // of the window (seen in WebKit at 1024 × 768, chat settings).
  const [floor, setFloor] = useState<number | null>(null);
  const heldFloor = floor !== null && ceiling !== null ? Math.min(floor, ceiling) : floor;
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (isMobile || !body) return;
    const keep = () => setFloor((current) => Math.max(current ?? 0, body.offsetHeight));
    keep();
    const observer = new ResizeObserver(keep);
    observer.observe(body);
    return () => observer.disconnect();
  }, [isMobile]);

  const openLevel = (target: ProvidersTarget) => {
    opener.current = document.activeElement as HTMLElement | null;
    setLevel(target);
  };
  // Back on the models, the focus goes to what opened the level, else the foot.
  const backToModels = () => {
    setLevel(null);
    requestAnimationFrame(() => {
      const from = opener.current;
      const target = from?.isConnected && modelsRef.current?.contains(from)
        ? from
        : modelsRef.current?.querySelector<HTMLElement>('[data-testid="ai-selector-providers"]');
      target?.focus({ preventScroll: true });
    });
  };

  return (
    <div
      ref={bodyRef}
      className="relative flex flex-col"
      style={{ ...style, minHeight: level ? levelHeight : heldFloor ?? undefined }}
    >
      <div
        ref={modelsRef}
        // Under a level the models stay laid out (the scroll of the list is
        // kept) but cannot be seen, reached or read.
        inert={level !== null}
        aria-hidden={level !== null || undefined}
        className={`flex min-h-0 flex-1 flex-col ${level ? 'invisible' : ''}`}
      >
        <Suspense fallback={null}>
          <ModelList
            {...list}
            // A choice closes the popover and gives the focus back to the
            // trigger (MSEL-08, MP-TASK-07), after whatever the surface does
            // with the choice in the same pass.
            onSelect={(selection, options) => {
              list.onSelect(selection);
              if (options?.keepOpen) return;
              requestAnimationFrame(() => requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true })));
            }}
            onClose={onClose}
            onOpenProviders={openLevel}
            layout="list"
            focusSearch={!isMobile}
          />
        </Suspense>
      </div>
      {level && (
        <div data-testid="model-selector-level" className="absolute inset-0 flex flex-col bg-[var(--popover-bg)]">
          <Suspense fallback={null}>
            <ProvidersLevels target={level} onBackToModels={backToModels} onClose={onClose} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
