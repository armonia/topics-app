/**
 * SplitPositionContext — publishes, per open topic, WHERE its pane sits in the
 * standalone split grid, so surfaces OTHER than the tab bar (notably the
 * sidebar topic cards) can render the same `SplitMiniMap` with that topic's
 * cell lit. The geometry lives inside PanelGrid; this context lifts a
 * `topicId → SplitMapDescriptor` map out so the sidebar (a sibling subtree)
 * can read it without prop-threading through App.
 *
 * The map is empty unless the grid is actually split (>1 cell) — a single-cell
 * layout has nothing to orient against, so no card shows a map.
 */
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import type { SplitMapDescriptor } from '../components/Shared/SplitMiniMap';

type PositionMap = ReadonlyMap<string, SplitMapDescriptor>;

const EMPTY: PositionMap = new Map();

const MapCtx = createContext<PositionMap>(EMPTY);
const PublishCtx = createContext<(m: PositionMap) => void>(() => {});

export function SplitPositionProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<PositionMap>(EMPTY);
  // Stable publisher; collapses redundant publishes (same emptiness) to avoid
  // needless re-renders of every consuming sidebar card.
  const publish = useCallback((next: PositionMap) => {
    setMap((prev) => (prev.size === 0 && next.size === 0 ? prev : next));
  }, []);
  const value = useMemo(() => ({ map, publish }), [map, publish]);
  return (
    <PublishCtx.Provider value={value.publish}>
      <MapCtx.Provider value={value.map}>{children}</MapCtx.Provider>
    </PublishCtx.Provider>
  );
}

/** Descriptor for a topic's pane position, or undefined when not in a split. */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useSplitPosition(topicId: string | undefined | null): SplitMapDescriptor | undefined {
  const map = useContext(MapCtx);
  return topicId ? map.get(topicId) : undefined;
}

/** Setter used by the grid to publish the latest topic→position map. */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function usePublishSplitPositions(): (m: PositionMap) => void {
  return useContext(PublishCtx);
}
