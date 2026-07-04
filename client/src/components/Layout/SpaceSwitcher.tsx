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
import { selectVisiblePaneIds } from '../../state/pane/selectors';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { SELECTED_SURFACE, RESTING_SURFACE, ROW_INSET } from '../../lib/selectionStyles';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_ITEM_DANGER, POPOVER_DIVIDER, Z_POPOVER } from '../../lib/popoverStyles';
import { generateUUID } from '../../utils/uuid';
import { clearPanelGridStorage } from './usePanelGridPersistence';
import type { AttentionTier, Topic, TerminalSessionInfo } from '../../types';

/** Label for the implicit default space (never stored in the registry). */
export const DEFAULT_SPACE_LABEL = 'Principale';

/** Live (non-deleted) spaces, ordered — the switcher's chip list after the
 *  default chip. */
export function liveSpacesOrdered(spaces: Record<string, SpaceMeta>): SpaceMeta[] {
  return Object.values(spaces)
    .filter((s) => !s.deleted)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Mint a fresh space id (`space:` prefix per the coherence ruling). */
export function createSpaceId(): string {
  return `space:${generateUUID()}`;
}

/** Default name for the Nth user space ("Spazio 2", …). */
export function nextSpaceName(spaces: Record<string, SpaceMeta>): string {
  return `Spazio ${liveSpacesOrdered(spaces).length + 2}`;
}

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

/** Detached pop-out windows (`?topic=`) skip every pane-store bridge — the
 *  switcher (and the "Sposta nello Spazio" menu) must not render there
 *  (coherence ruling 3.8). */
export function isDetachedWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('topic');
  } catch {
    return false;
  }
}

/**
 * Move an app-level pane to another Spazio ("Sposta nello Spazio →"). The
 * membership write is a plain UPDATE_PANE (spaceId is a synced Pane field);
 * the default space is encoded as ABSENT. If the moved pane was the focused
 * one it just left the visible set — hand focus to the first pane still
 * visible (or null) BEFORE the focus-follow effect could yank the window to
 * the target space. No auto-switch: Arc semantics, the tab travels quietly.
 */
export function movePaneToSpace(paneId: string, targetSpaceId: string): void {
  const s = usePaneStore.getState();
  const pane = s.panes[paneId];
  if (!pane) return;
  if (resolvePaneSpace(pane, s.spaces) === targetSpaceId) return; // already there
  s.dispatch({
    type: 'UPDATE_PANE',
    payload: {
      id: paneId,
      updates: { spaceId: targetSpaceId === DEFAULT_SPACE_ID ? undefined : targetSpaceId },
    },
  });
  const after = usePaneStore.getState();
  if (after.focusedPaneId === paneId) {
    const visible = selectVisiblePaneIds(after);
    after.dispatch({ type: 'FOCUS_PANE', payload: { id: visible[0] ?? null } });
  }
}

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
      className="flex items-center gap-1 h-8 border-b border-app-border bg-surface flex-shrink-0 overflow-x-auto app-drag-region"
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
          className={`fixed ${POPOVER_SURFACE} min-w-[170px]`}
          style={{ top: chipMenu.y, left: chipMenu.x, zIndex: Z_POPOVER }}
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
