/**
 * PaneStage / StagedPane / PaneEventLevel — pane bodies that survive the
 * reorganisation of the split around them (SPLITPERF-01).
 *
 * `PaneStage` goes around ONE tiling surface (the standalone grid, a project's
 * grid). Inside it, a group renders `<StagedPane paneKey>{body}</StagedPane>`
 * where it used to render the body: the StagedPane draws an empty slot, and the
 * body itself is mounted by the stage, once per key, and portalled into that
 * slot. When the pane moves to another group, another row, another stack, the
 * slot is rebuilt and the body is not — the store moves its DOM (see
 * paneStageStore.ts for the hand-over).
 *
 * `PaneEventLevel` declares a layout element whose React handlers the body's
 * events must still reach: see `BridgeLevel`. Every element that sits between
 * the stage and a slot and handles one of `BRIDGE_EVENTS` must declare itself,
 * or events coming from inside a body skip it.
 *
 * Without a stage above it (the phone layout, a host that did not opt in),
 * `StagedPane` renders its children in place, exactly as before.
 */
import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BRIDGE_EVENTS,
  createPaneStageStore,
  type BridgeEventName,
  type BridgeLevel,
  type PaneStageStore,
  type StageEntry,
} from './paneStageStore';

const StageContext = createContext<PaneStageStore | null>(null);

interface LevelChain {
  readonly level: BridgeLevel;
  readonly parent: LevelChain | null;
}

const LevelContext = createContext<LevelChain | null>(null);

/** `display: contents`: the slot and the wrappers take no box, the pane shell
 *  stays the flex item of the group's content area exactly as before. */
const CONTENTS = { display: 'contents' } as const;

export function PaneStage({ children }: { children: ReactNode }) {
  const [store] = useState(createPaneStageStore);
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const parkingRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    store.setParking(parkingRef.current);
    return () => store.setParking(null);
  }, [store]);
  return (
    <StageContext.Provider value={store}>
      {/* The level chain restarts at the stage: the levels ABOVE it are
          bridged by whoever stages this surface itself (a project window is a
          body of the grid it sits in), and replaying them here too would run
          them twice. */}
      <LevelContext.Provider value={null}>{children}</LevelContext.Provider>
      <div ref={parkingRef} hidden data-pane-stage-parking="" />
      {entries.map((entry) => (
        <StagedBody key={entry.key} entry={entry} />
      ))}
    </StageContext.Provider>
  );
}

const StagedBody = memo(function StagedBody({ entry }: { entry: StageEntry }) {
  const { container } = entry;
  // The store created the container and put it in its slot; once the body
  // unmounts (a real close), the container has nothing left to hold.
  useLayoutEffect(() => () => container.remove(), [container]);
  return createPortal(
    <div style={CONTENTS} {...bridgeProps(entry.levels, container)}>
      {entry.element}
    </div>,
    container,
  );
});

/**
 * Replay the levels' handlers on an event that came from inside the body, in
 * DOM order: capture handlers from the outermost level in, bubble handlers from
 * the innermost out, stopping where one of them stops propagation. Each handler
 * sees as `currentTarget` the element it was written for, found again from the
 * body's own position, so a handler that measures `currentTarget` measures the
 * same box it always did.
 */
function bridgeProps(
  levels: readonly BridgeLevel[],
  container: HTMLElement,
): Partial<Record<BridgeEventName, (e: SyntheticEvent) => void>> {
  const props: Partial<Record<BridgeEventName, (e: SyntheticEvent) => void>> = {};
  // Each name carries its own event type in `BridgeHandlers`; the replay only
  // forwards the event React handed to the wrapper for that same name.
  type AnyHandler = (e: SyntheticEvent) => void;
  for (const name of BRIDGE_EVENTS) {
    const involved = levels.filter((l) => l.handlers[name]);
    if (involved.length === 0) continue;
    const ordered = name.endsWith('Capture') ? [...involved].reverse() : involved;
    props[name] = (e) => {
      const own = e.currentTarget;
      const writable = e as { currentTarget: EventTarget | null };
      try {
        for (const level of ordered) {
          const el = container.closest(level.selector);
          if (!el) continue;
          writable.currentTarget = el;
          (level.handlers[name] as AnyHandler)(e);
          if (e.isPropagationStopped()) break;
        }
      } finally {
        writable.currentTarget = own;
      }
    };
  }
  return props;
}

function levelsOf(chain: LevelChain | null): BridgeLevel[] {
  const out: BridgeLevel[] = [];
  for (let c = chain; c; c = c.parent) out.push(c.level);
  return out;
}

/** Declare the layout element found by `selector` as one the bodies' events must reach. */
export function PaneEventLevel({
  selector,
  handlers,
  children,
}: BridgeLevel & { children: ReactNode }) {
  const parent = useContext(LevelContext);
  return (
    <LevelContext.Provider value={{ level: { selector, handlers }, parent }}>{children}</LevelContext.Provider>
  );
}

/**
 * The place of one pane body in the layout. `children` is the body (its keep-
 * alive shell included); under a stage it is mounted by the stage and shown
 * here, without a stage it is rendered here.
 */
export function StagedPane({ paneKey, children }: { paneKey: string; children: ReactNode }) {
  const store = useContext(StageContext);
  const chain = useContext(LevelContext);
  const slotRef = useRef<HTMLDivElement>(null);
  // Every render hands the stage the current body: it is what the group just
  // rendered for this pane, with its current props.
  useLayoutEffect(() => {
    if (store && slotRef.current) store.put(paneKey, children, slotRef.current, levelsOf(chain));
  });
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!store || !slot) return;
    return () => store.release(paneKey, slot);
  }, [store, paneKey]);
  if (!store) return <>{children}</>;
  return <div ref={slotRef} style={CONTENTS} data-pane-slot={paneKey} />;
}
