/**
 * SpaceSwitcher — the Spazi strip above the standalone panel grid.
 *
 * Compact chips, one per space (the implicit default first), active chip =
 * SELECTED_SURFACE, resting chips = RESTING_SURFACE — the same card grammar as
 * tabs/sidebar rows (lib/selectionStyles.ts). The context menu (rename /
 * delete) is a POPOVER_SURFACE portal like every other menu
 * (lib/popoverStyles.ts).
 *
 * Renders NOTHING until at least one live user space exists ("Nuovo Spazio"
 * in the tab context menu creates the first one), so users who never touch
 * Spazi pay zero chrome. Renders on mobile too — hidden spaces would
 * otherwise be unreachable there — and never in detached `?topic=` windows
 * (those skip the pane-store bridges entirely).
 *
 * Attention parity: a HIDDEN space with pending attention gets a small tier
 * dot (amber 'input' / blue 'done') aggregated from the SAME signals.ts data
 * the tab bar and sidebar read — badge-parity invariant, no switcher-only
 * math.
 */
import { useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDismissable } from '../../hooks/useDismissable';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { SELECTED_SURFACE, RESTING_SURFACE, ROW_INSET } from '../../lib/selectionStyles';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_MARGIN, POPOVER_ITEM_DANGER, POPOVER_DIVIDER, Z_POPOVER } from '../../lib/popoverStyles';
import { clearPanelGridStorage } from './usePanelGridPersistence';
import {
  DEFAULT_SPACE_LABEL,
  liveSpacesOrdered,
  createSpaceId,
  nextSpaceName,
  isDetachedWindow,
} from './spaceHelpers';
import type { AttentionTier, Topic, TerminalSessionInfo } from '../../types';

interface AttentionSets {
  awaitingInputTopics: Set<string>;
  awaitingFeedbackTopics: Set<string>;
  claudePhaseAwaitingInputTermIds: Set<string>;
  claudePhaseAwaitingTermIds: Set<string>;
  terminalFinishedIds: Set<string>;
}

/**
 * Aggregate attention tier for one space: the loudest tier among its member
 * panes ('input' wins over 'done'), or null. Built on the same per-subject
 * sets the tab bar / sidebar read.
 */
function spaceAttentionTier(
  spaceId: string,
  panes: Record<string, Pane>,
  spaces: Record<string, SpaceMeta>,
  sig: AttentionSets,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
): AttentionTier | null {
  let hasDone = false;
  for (const pane of Object.values(panes)) {
    if (resolvePaneSpace(pane, spaces) !== spaceId) continue;
    if (pane.type === 'chat') {
      const topicId = pane.topicId ?? pane.id;
      if (sig.awaitingInputTopics.has(topicId)) return 'input';
      if (sig.awaitingFeedbackTopics.has(topicId)) hasDone = true;
    } else if (pane.type === 'terminal') {
      const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
      if (!sid) continue;
      if (sig.claudePhaseAwaitingInputTermIds.has(sid)) return 'input';
      if (sig.claudePhaseAwaitingTermIds.has(sid) || sig.terminalFinishedIds.has(sid)) hasDone = true;
    } else if (pane.type === 'project' && pane.projectPath) {
      const tier = projectAttentionTier(
        pane.projectPath,
        topics,
        terminalSessions,
        sig.awaitingFeedbackTopics,
        sig.claudePhaseAwaitingTermIds,
        sig.awaitingInputTopics,
        sig.claudePhaseAwaitingInputTermIds,
      );
      if (tier === 'input') return 'input';
      if (tier === 'done') hasDone = true;
    }
  }
  return hasDone ? 'done' : null;
}

/** This menu's own min-width — lets the horizontal clamp work without a
 *  measure-then-place pass (keep in lockstep with the min-w-[170px] below). */
const MENU_MIN_W = 170;

interface ChipMenuState {
  spaceId: string;
  x: number;
  y: number;
}

export function SpaceSwitcher() {
  const dispatch = usePaneStore((s) => s.dispatch);
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const panes = usePaneStore((s) => s.panes);
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const sig = useSignalsStore(
    useShallow((s) => ({
      awaitingInputTopics: s.awaitingInputTopics,
      awaitingFeedbackTopics: s.awaitingFeedbackTopics,
      claudePhaseAwaitingInputTermIds: s.claudePhaseAwaitingInputTermIds,
      claudePhaseAwaitingTermIds: s.claudePhaseAwaitingTermIds,
      terminalFinishedIds: s.terminalFinishedIds,
    })),
  );

  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss the chip menu via the shared contract (capture-phase pointerdown +
  // touch + Escape, focus-restore). The rename input lives inside menuRef, so it
  // counts as "inside" for free. Cursor-anchored positioning is kept below.
  useDismissable({
    open: chipMenu !== null,
    onClose: () => setChipMenu(null),
    refs: [menuRef],
  });

  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);

  const tierFor = (spaceId: string): AttentionTier | null =>
    spaceAttentionTier(spaceId, panes, spaces, sig, topics, terminalSessions);

  if (isDetachedWindow()) return null;
  // Zero chrome until Spazi is actually in use ("Nuovo Spazio" in the tab
  // context menu creates the first space).
  if (ordered.length === 0) return null;

  const chips: { id: string; name: string }[] = [
    { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
    ...ordered.map((s) => ({ id: s.id, name: s.name || 'Spazio' })),
  ];

  const menuSpace = chipMenu ? spaces[chipMenu.spaceId] : undefined;

  return (
    <div
      // chrome-glass, NOT bg-surface: every peer chrome row (the pane tab bars,
      // the sidebar) is frosted, so an opaque strip read as a flat slab wedged
      // between two sheets of glass — the "non è coerente col resto" half of the
      // report. Same token they use, no new values.
      className="flex items-center gap-1 h-8 border-b border-app-border chrome-glass flex-shrink-0 overflow-x-auto app-drag-region"
      style={{ paddingLeft: ROW_INSET, paddingRight: ROW_INSET }}
      data-testid="space-switcher"
      role="tablist"
      aria-label="Spazi"
    >
      {chips.map((chip) => {
        const isActive = chip.id === activeSpaceId;
        // FOCUS WINS (sidebarRowCard precedent): the space you're looking at
        // never shows an attention dot — you're already there.
        const tier = isActive ? null : tierFor(chip.id);
        return (
          <button
            key={chip.id}
            role="tab"
            aria-selected={isActive}
            data-space-id={chip.id}
            onClick={() => {
              if (!isActive) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: chip.id } });
            }}
            onContextMenu={(e) => {
              if (chip.id === DEFAULT_SPACE_ID) return; // implicit — no rename/delete
              e.preventDefault();
              setRenameDraft(null);
              setChipMenu({ spaceId: chip.id, x: e.clientX, y: e.clientY });
            }}
            className={`h-6 px-2.5 flex items-center gap-1.5 rounded-md text-[12px] whitespace-nowrap transition-colors cursor-pointer app-no-drag flex-shrink-0 ${
              isActive ? SELECTED_SURFACE : `${RESTING_SURFACE} text-app-text-secondary hover:text-app-text`
            }`}
            title={chip.name}
          >
            <span className="truncate max-w-[120px]">{chip.name}</span>
            {tier && (
              <span
                aria-label={tier === 'input' ? 'richiede input' : 'attività completata'}
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  tier === 'input' ? 'bg-amber-500 animate-pulse' : 'bg-[#0a84ff]'
                }`}
              />
            )}
          </button>
        );
      })}
      {liveSpaceCount(spaces) < SPACES_MAX && (
        <button
          onClick={() => {
            const id = createSpaceId();
            dispatch({ type: 'SPACE_UPSERT', payload: { space: { id, name: nextSpaceName(spaces) } } });
            dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id } });
          }}
          className={`h-6 w-6 flex items-center justify-center rounded-md ${RESTING_SURFACE} text-app-text-muted hover:text-app-text transition-colors cursor-pointer app-no-drag flex-shrink-0`}
          title="Nuovo Spazio"
          aria-label="Nuovo Spazio"
        >
          <Plus size={13} />
        </button>
      )}

      {chipMenu && menuSpace && !menuSpace.deleted && createPortal(
        <div
          ref={menuRef}
          // Opened at raw cursor coords with no bound at all: right-clicking a
          // chip near the right or bottom edge pushed the menu off-screen. Clamp
          // both axes to the shared POPOVER_MARGIN (MENU_MIN_W is this menu's
          // own min-width, so the horizontal clamp needs no measurement) and let
          // it scroll rather than overflow.
          className={`fixed ${POPOVER_SURFACE} min-w-[170px] overflow-y-auto overscroll-contain`}
          style={{
            top: chipMenu.y,
            left: Math.max(
              POPOVER_MARGIN,
              Math.min(chipMenu.x, window.innerWidth - MENU_MIN_W - POPOVER_MARGIN),
            ),
            maxHeight: `calc(100vh - ${chipMenu.y + POPOVER_MARGIN}px)`,
            zIndex: Z_POPOVER,
          }}
        >
          {renameDraft !== null ? (
            <form
              className="px-2 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                const name = renameDraft.trim();
                if (name) {
                  dispatch({ type: 'SPACE_UPSERT', payload: { space: { id: chipMenu.spaceId, name } } });
                }
                setChipMenu(null);
              }}
            >
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                className="w-full px-2 py-1 text-[12px] rounded-md bg-app-hover text-app-text outline-none border border-app-border-light focus:border-primary"
                placeholder="Nome dello Spazio"
                aria-label="Rinomina Spazio"
              />
            </form>
          ) : (
            <button onClick={() => setRenameDraft(menuSpace.name)} className={POPOVER_ITEM}>
              <Pencil size={14} />
              <span className="flex-1">Rinomina</span>
            </button>
          )}
          <div className={POPOVER_DIVIDER} />
          <button
            onClick={() => {
              // Soft-delete: member tabs reassign to the default space (the
              // reducer owns both moves), nothing closes.
              dispatch({ type: 'SPACE_DELETE', payload: { id: chipMenu.spaceId } });
              // Drop the deleted space's device-local grid overlay so its
              // suffixed localStorage key doesn't leak (the reducer is pure and
              // can't touch storage; PanelGrid's remount key is now gone too).
              clearPanelGridStorage(chipMenu.spaceId);
              setChipMenu(null);
            }}
            className={POPOVER_ITEM_DANGER}
            title="Le schede tornano nello Spazio principale"
          >
            <Trash2 size={14} />
            <span className="flex-1">Elimina Spazio</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
