import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from '../state/pane/store';
import { resolvePaneSpace, isLiveSpaceId } from '../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID } from '../state/pane/types';
import { useSpaceWindows } from '../state/windowPresence';
import { useGoToSpace } from '../components/Sidebar/useSpaceCards';
import { spaceWindowId } from '../lib/windowRole';
import { focusSpaceWindow, isSpaceClaimedLocally } from '../lib/popOutSpace';
import { groupChromeActive, isDetachedWindow, firstOtherLiveSpace, tabsPerSpace } from '../components/Layout/spaceHelpers';

/**
 * The groups ("spaces"), for the sidebar: which group each open pane lives in,
 * whether the group chrome is on, and the two hand-offs that keep a window from
 * sitting on a group that lives elsewhere or that has emptied.
 */
export function useSpaceGroups(openPanels: string[], activeSpaceId: string) {
  // ── The group, for the sidebar ───────────────────────────────────────────
  // Which group each open pane lives in. We subscribe to the RESULT (an array
  // of strings, with `useShallow`) and not to `s.panes`: that changes identity
  // at every pane write, `setPaneScrollOffset` makes one every 250 ms while
  // you scroll a chat, and would redraw the sidebar for a datum that neither
  // of these two looks at.
  const paneSpaces = usePaneStore(
    useShallow((s) => openPanels.map((id) => resolvePaneSpace(s.panes[id], s.spaces))),
  );
  const paneSpaceById = useMemo(
    () => new Map(openPanels.map((id, i) => [id, paneSpaces[i]])),
    [openPanels, paneSpaces],
  );
  // The groups that live in a window of their own. It is needed twice, and the
  // first is just below: a detached group counts as "there" even at zero tabs.
  const spaceWindows = useSpaceWindows();
  // True when the group header is there: then the tree splits into "the tabs of
  // this group" and "outside the groups". Same answer SpaceGroups gives to
  // decide whether to draw itself.
  //
  // The selector returns a BOOLEAN, so subscribing to `s.panes` here redraws
  // nothing until the answer changes, the map of counts is born and dies
  // inside the call.
  const spaceChrome = usePaneStore((s) => groupChromeActive(
    s.spaces,
    spaceWindowId(),
    tabsPerSpace(s.groups['group:default']?.paneIds ?? [], s.panes, s.spaces),
    spaceWindows,
  ));
  const goToSpace = useGoToSpace();
  // Does the active group live in ANOTHER window? Then it is not drawn here: two
  // windows on the same grid are two copies of the same live terminals.
  const activeSpaceWindow = spaceWindows.get(activeSpaceId);
  // ── The group lives over there: we do NOT show a sign, we move ────────────
  // The right thing to do when this window finds itself on a group that already
  // has a home is to show WHERE IT LIVES: its window is brought to the front and
  // this one is put on another group (a FREE one, sending itself to another
  // detached group would be a bounce). The panel stays only for the case where
  // there is no other place to go.
  //
  // Not in a GROUP window: there the group is its own, and the presence excludes
  // itself, if it fired, the window would run away from its own home.
  const pinnedSpaceForHandoff = spaceWindowId();
  useEffect(() => {
    if (!activeSpaceWindow || pinnedSpaceForHandoff) return;
    // If the user said "I want it here" (the fallback of a click on the card,
    // when that window was not responding), the old presence does not send it
    // back.
    if (isSpaceClaimedLocally(activeSpaceId)) return;
    void focusSpaceWindow(activeSpaceWindow);
    const store = usePaneStore.getState();
    const next = firstOtherLiveSpace(store.spaces, activeSpaceId, spaceWindows);
    if (next) store.dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: next } });
  }, [activeSpaceWindow, activeSpaceId, pinnedSpaceForHandoff, spaceWindows]);

  // ── The group you are on has emptied: go back home ────────────────────────
  // A group at zero tabs is no longer drawn (`useSpaceCards`), and staying in it
  // would be the dead end: empty grid, and no card to click to leave, precisely
  // because its own is gone. Once the last tab is closed or taken away, the
  // window goes back to the Main one.
  //
  // The two `usePaneStore` here return BOOLEANS: subscribing to `s.panes` costs
  // a comparison per write, not a redraw.
  const activeSpaceHasTabs = usePaneStore((s) => (
    (tabsPerSpace(s.groups['group:default']?.paneIds ?? [], s.panes, s.spaces).get(s.activeSpaceId) ?? 0) > 0
  ));
  // Is the active group a LIVE record of the registry? If not, the registry has
  // not arrived yet (at startup `activeSpaceId` is restored from localStorage
  // before the snapshot): without this guard every reload inside a group would
  // end up in the Main one.
  const activeSpaceLive = usePaneStore((s) => isLiveSpaceId(s.activeSpaceId, s.spaces));
  useEffect(() => {
    if (pinnedSpaceForHandoff) return;      // the group window IS its group
    if (activeSpaceWindow) return;          // the effect above takes care of it
    if (activeSpaceId === DEFAULT_SPACE_ID) return;
    if (!activeSpaceLive || activeSpaceHasTabs) return;
    usePaneStore.getState().dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: DEFAULT_SPACE_ID } });
  }, [activeSpaceId, activeSpaceHasTabs, activeSpaceLive, activeSpaceWindow, pinnedSpaceForHandoff]);

  const spaceScoped = spaceChrome && !isDetachedWindow();
  return { paneSpaceById, goToSpace, activeSpaceWindow, spaceScoped };
}
