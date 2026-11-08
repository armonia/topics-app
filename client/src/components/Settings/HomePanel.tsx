/**
 * THE PANEL OF A FORM THAT LIVES WHERE IT IS USED: anchored beside its home, a
 * centred sheet with no home on screen, a bottom sheet on the phone. Opened
 * only by `HomePanelHost`, which decides which and where.
 *
 * ONE PRIMITIVE FOR THE THREE SHAPES, `Menu`, and on purpose. A form holds
 * `Select`s, and their lists are popovers on the popover plane: inside a modal
 * (which sits ABOVE that plane, `Z_MODAL`) a list opened from the form would
 * draw under the veil and could not be picked. So the centred sheet is a popover
 * too, hung from an invisible box in the middle of the window, with a light veil
 * of its own on the scrim plane under it.
 */
import { lazy, Suspense, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Plug } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { FormPanelFrame, type Glyph } from '../Sidebar/FormLevel';
import { LevelCloseContext } from '../Shared/levelClose';
import { ConfirmInsidePopoverContext } from '@/hooks/confirmInsidePopover';
import { useMobile } from '@/hooks/useMobile';
import { useExitGhost } from '@/lib/exitGhost';
import { POPOVER_MARGIN, Z_POPOVER_SCRIM } from '@/lib/popoverStyles';
import type { PanelHome } from '@/lib/openHome';
import type { ProvidersTarget } from './AIProvidersSection';
import { useT } from '@/hooks/useT';

// Each form loads the first time its panel opens. Destructured on purpose: a
// bare `import()` is opaque to knip (`check:deadcode-blindspots`).
const ProvidersLevels = lazy(async () => {
  const { ProvidersLevels: Body } = await import('./AIProvidersSection');
  return { default: Body };
});
const ToolsSection = lazy(async () => {
  const { ToolsSection: Body } = await import('./ToolsSection');
  return { default: Body };
});
const CalendarSection = lazy(async () => {
  const { CalendarSection: Body } = await import('./CalendarSection');
  return { default: Body };
});

/** Wide enough for an API key with its button. */
const PANEL_WIDTH = 420;

/** Providers and keys as a sheet is as wide as the model selector it stands
 *  in for (model selector revision 2026-10-04, §5.1). */
const PROVIDERS_WIDTH = 704;
/** And as tall as the selector at most, with the levels scrolling inside. */
const PROVIDERS_HEIGHT = 'min(456px, calc(88vh - 2rem))';

/** Where the centred sheet's top edge sits: the palette's own height. */
const CENTERED_TOP = '12vh';

const PANELS: Record<Exclude<PanelHome, 'providers'>, { icon: Glyph; label: string; body: () => React.ReactNode }> = {
  tools: { icon: Plug, label: 'home.tools', body: () => <ToolsSection /> },
  calendar: { icon: CalendarDays, label: 'home.calendar', body: () => <CalendarSection /> },
};

export interface HomeRequest {
  home: PanelHome;
  anchor: HTMLElement | null;
  /** Where the focus goes back on close instead of the anchor (a typed command's field). */
  returnFocus?: HTMLElement | null;
  /** Providers and keys only: the account a door asked for. */
  providers?: ProvidersTarget;
  /** Changes on every request: the same panel asked twice opens fresh. */
  n: number;
}

export function HomePanel({ request, onClose }: { request: HomeRequest; onClose: () => void }) {
  if (request.home === 'providers') return <ProvidersSheet request={request} onClose={onClose} />;
  return <FormPanel request={request} home={request.home} onClose={onClose} />;
}

/** Gives the focus back on close: to `returnFocus`, else to the anchor. */
function useFocusBack(request: HomeRequest, testId: string) {
  // ON CLOSE THE FOCUS GOES BACK TO THE ANCHOR, said here rather than left to
  // `Menu`, which gives it back to what held it when the panel opened. That
  // was the menu the door sat in: the model selector inside the board
  // settings had given the focus back to the board settings' own panel by
  // then (WebKit does not focus a button on click), and Escape left the focus
  // there instead of on the selector. Only when the close orphaned it: a
  // focus the person moved elsewhere stays where it is.
  // A panel a TYPED command opened (`/mcp`, `/usage`) gives it back to the
  // field the command was typed in: on the «+» the next words were lost.
  const back = request.returnFocus ?? request.anchor;
  useEffect(() => () => {
    if (!back?.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || !active.isConnected || active.closest(`[data-testid="${testId}"]`)) {
      back.focus({ preventScroll: true });
    }
  }, [back, testId]);
}

/**
 * Providers and keys with no model chip on screen: a sheet as wide as the
 * selector, centred on the desktop, from the bottom on the phone, with the
 * levels inside and no ‹ on the list.
 */
function ProvidersSheet({ request, onClose }: { request: HomeRequest; onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const anchorRef = useRef<HTMLElement | null>(null);
  const testId = 'home-panel-providers';
  const width = Math.max(260, Math.min(PROVIDERS_WIDTH, window.innerWidth - 2 * POPOVER_MARGIN));
  useFocusBack(request, testId);
  return (
    <ConfirmInsidePopoverContext.Provider value={true}>
      {!isMobile && <CenteredAnchor anchorRef={anchorRef} width={width} />}
      <Menu
        open
        anchorRef={anchorRef}
        onClose={onClose}
        gap={0}
        role="dialog"
        ariaLabel={tr('home.providers')}
        minWidth={width}
        maxWidth={width}
        unmanagedFocus
        restoreFocus={false}
        testId={testId}
        owner={isMobile ? undefined : 'centred'}
        className="overflow-hidden"
      >
        <div className="flex flex-col" style={{ height: isMobile ? 'calc(100dvh - 5.5rem)' : PROVIDERS_HEIGHT }}>
          <LevelCloseContext.Provider value={onClose}>
            <Suspense fallback={null}>
              <ProvidersLevels target={request.providers} onClose={onClose} closeTestId={`${testId}-close`} />
            </Suspense>
          </LevelCloseContext.Provider>
        </div>
      </Menu>
    </ConfirmInsidePopoverContext.Provider>
  );
}

function FormPanel({ request, home, onClose }: { request: HomeRequest; home: Exclude<PanelHome, 'providers'>; onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const centered = !request.anchor && !isMobile;
  const anchorRef = useRef<HTMLElement | null>(request.anchor);
  const panel = PANELS[home];
  const label = tr(panel.label);
  const testId = `home-panel-${home}`;
  const width = Math.max(260, Math.min(PANEL_WIDTH, window.innerWidth - 2 * POPOVER_MARGIN));
  // BESIDE THE ANCHOR, NEVER OVER IT. The menu flips above when there is no
  // room below, but a form taller than either side was clamped to the window
  // and covered the selector it hangs from (measured: a 570 px panel over a
  // chip at y 496 of 900). The body scrolls anyway, so the cap is the larger
  // of the two sides, read once on open.
  const room = request.anchor && !isMobile ? roomBeside(request.anchor) : undefined;
  useFocusBack(request, testId);

  return (
    // A question a form asks («remove this key?») is part of the panel: it
    // opens inside it and answering it is not a press outside.
    <ConfirmInsidePopoverContext.Provider value={true}>
      {centered && <CenteredAnchor anchorRef={anchorRef} width={width} />}
      <Menu
        open
        anchorRef={anchorRef}
        onClose={onClose}
        gap={centered ? 0 : undefined}
        // A form is not a list of menu items (fields inside role=menu are
        // announced as items): a dialog named after the form.
        role="dialog"
        ariaLabel={label}
        minWidth={width}
        maxWidth={width}
        unmanagedFocus
        restoreFocus={false}
        testId={testId}
        owner={centered ? 'centred' : undefined}
        className="overflow-hidden"
      >
        <FocusOnOpen />
        <LevelCloseContext.Provider value={onClose}>
          <FormPanelFrame icon={panel.icon} label={label} testId={testId} maxHeight={room}>
            {panel.body()}
          </FormPanelFrame>
        </LevelCloseContext.Provider>
      </Menu>
    </ConfirmInsidePopoverContext.Provider>
  );
}

/** The height free above or below `anchor`, whichever is larger, minus the
 *  window's margin and the panel's gap. */
function roomBeside(anchor: HTMLElement): number {
  const r = anchor.getBoundingClientRect();
  return Math.max(160, Math.floor(Math.max(r.top, window.innerHeight - r.bottom) - POPOVER_MARGIN - 16));
}

/**
 * The panel takes the focus once it is placed, so Escape and Tab belong to it
 * from the first press. `unmanagedFocus` keeps `Menu`'s arrows away from the
 * fields, and with them `Menu`'s own focus on open: this puts that one back.
 * On the FRAME, not on the menu's container: the frame walks Tab, and a
 * keydown aimed at its parent never reaches it.
 */
function FocusOnOpen() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const popover = marker.current?.closest<HTMLElement>('[data-popover]');
    const panel = popover?.querySelector<HTMLElement>('[data-form-frame]') ?? popover;
    if (!panel) return;
    // The panel is placed (and visible) one frame after it mounts.
    const id = requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, []);
  return <span ref={marker} hidden />;
}

/**
 * No home on screen, on the desktop: an invisible box as wide as the panel,
 * centred under the top of the window, for the panel to hang from; and a light
 * veil under it. A press on the veil is a press outside, which closes.
 */
function CenteredAnchor({ anchorRef, width }: { anchorRef: React.MutableRefObject<HTMLElement | null>; width: number }) {
  const veil = useRef<HTMLDivElement>(null);
  // The veil fades out with the panel instead of vanishing in one frame.
  useExitGhost(veil, true, 'modal');
  return createPortal(
    <>
      <div
        ref={veil}
        aria-hidden="true"
        className="fixed inset-0 bg-black/20 dark:bg-black/40 modal-backdrop-enter"
        style={{ zIndex: Z_POPOVER_SCRIM }}
      />
      <div
        ref={(el) => { anchorRef.current = el; }}
        aria-hidden="true"
        data-testid="home-panel-centre"
        className="pointer-events-none fixed h-0"
        style={{ top: CENTERED_TOP, left: `calc(50% - ${width / 2}px)`, width }}
      />
    </>,
    document.body,
  );
}
