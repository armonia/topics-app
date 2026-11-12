import { useState, useRef, useEffect, useCallback, type RefObject } from 'react';
import { useUserMenuRequest } from '../hooks/useUserMenuHost';
import { prefetchTopicsMenuItems } from '../components/Sidebar/topicsMenuItemsLazy';
import { useSheetDrag } from '../hooks/useSheetDrag';
import { useDismissable } from '../hooks/useDismissable';
import { useExitGhost } from '../lib/exitGhost';

/**
 * State, refs and effects of the «Topics» title menu: the dropdown on the
 * desktop, the two-floor sheet on the phone (where it IS the user menu).
 */
export function useTopicsMenu(isMobile: boolean, sidebarContentRef: RefObject<HTMLDivElement | null>) {
  const [showTopicsMenu, setShowTopicsMenu] = useState(false);
  // A1: two states that live on the phone only. `mobileTopFull`: the top row
  // is compact at the head of the list and reveals itself whole once the list
  // moves. `mobileSheetTopics`: the user sheet has two floors, the root and
  // the Topics floor, false is the root, where the sheet always opens.
  const [mobileTopFull, setMobileTopFull] = useState(false);
  const [mobileSheetTopics, setMobileSheetTopics] = useState(false);
  const topicsMenuRef = useRef<HTMLDivElement>(null);
  const topicsDropdownRef = useRef<HTMLDivElement>(null);
  const topicsScrimRef = useRef<HTMLDivElement>(null);
  const [topicsMenuPos, setTopicsMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Under 768px this menu is a bottom sheet, and a sheet is pushed down
  // with the finger (hooks/useSheetDrag). It does not apply to the desktop card.
  useSheetDrag({
    enabled: showTopicsMenu && isMobile,
    sheetRef: topicsDropdownRef,
    scrimRef: topicsScrimRef,
    onClose: () => { setShowTopicsMenu(false); },
  });

  // Close topics menu on outside click or Escape (canonical useDismissable
  // contract: capture-phase pointer/touch + Escape). Trigger wrapper + dropdown
  // panel both count as "inside". restoreFocus off to preserve prior behaviour.
  useDismissable({
    open: showTopicsMenu,
    onClose: () => { setShowTopicsMenu(false); },
    refs: [topicsMenuRef, topicsDropdownRef],
    restoreFocus: false,
  });
  // The sheet slides back down and its scrim fades with it (lib/exitGhost),
  // as every `Menu` sheet does, instead of both vanishing in one frame.
  useExitGhost(topicsDropdownRef, showTopicsMenu, isMobile ? 'sheet' : 'popover');
  useExitGhost(topicsScrimRef, showTopicsMenu && isMobile, 'modal');

  // On the phone the title menu IS the user menu: it answers `openUserMenu`.
  const openTopicsMenu = useCallback(() => setShowTopicsMenu(true), []);
  const [topicsMenuRequest, resetTopicsMenuRequest] = useUserMenuRequest(isMobile, openTopicsMenu);
  // The phone's title menu rows are a lazy chunk, warmed once the phone layout is up.
  useEffect(() => {
    if (!isMobile) return;
    const timer = setTimeout(prefetchTopicsMenuItems, 0);
    return () => clearTimeout(timer);
  }, [isMobile]);
  // A1: THE SHEET OPENS AT THE ROOT, unless a door asks for a precise floor.
  // Appearance, notifications and view live on the Topics floor, so a request
  // for one of them opens the sheet already down there (the bell with the
  // gear, the shortcut, and the palette commands land where they landed when
  // the list was flat). Plan and devices stay at the root.
  useEffect(() => {
    if (!showTopicsMenu || !isMobile) return;
    const level = topicsMenuRequest.level;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the floor follows the request that opened the sheet; one boolean set when the sheet opens or a door asks for a level, and it converges in one pass
    setMobileSheetTopics(level === 'appearance' || level === 'notifications' || level === 'view');
  }, [showTopicsMenu, isMobile, topicsMenuRequest]);
  // A1: THE TOP ROW REVEALS ITSELF ON SCROLL. At the head it is compact (44,
  // its buttons and nothing else); once the list moves it takes the whole
  // size. The listener is on CAPTURE on the wrapper: `scroll` does not
  // bubble, so it does not matter which scroller is inside right now (the
  // list or the skeleton). One boolean, and only when it flips: a state per
  // pixel would be a render per pixel.
  useEffect(() => {
    if (!isMobile) return;
    const wrap = sidebarContentRef.current;
    if (!wrap) return;
    const onScroll = (e: Event) => {
      const top = (e.target as HTMLElement | null)?.scrollTop ?? 0;
      // Same boolean, no render: React bails out by itself when the value is
      // unchanged, so no hand-written guard is needed here.
      setMobileTopFull(top > 8);
    };
    wrap.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => wrap.removeEventListener('scroll', onScroll, { capture: true });
  }, [isMobile, sidebarContentRef]);

  return {
    showTopicsMenu, setShowTopicsMenu,
    mobileTopFull, mobileSheetTopics, setMobileSheetTopics,
    topicsMenuRef, topicsDropdownRef, topicsScrimRef,
    topicsMenuPos, setTopicsMenuPos,
    topicsMenuRequest, resetTopicsMenuRequest,
  };
}

export type TopicsMenuState = ReturnType<typeof useTopicsMenu>;
