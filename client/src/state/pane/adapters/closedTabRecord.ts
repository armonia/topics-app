/**
 * Adapter for closed-tab records.
 *
 * The reducer's `closedStack` is the source of truth. This file hosts three
 * responsibilities the reducer can't cleanly own:
 *   - `captureClosedTab` — a pure factory used at close-call sites to build a
 *     ClosedTabRecord before dispatching CLOSE_PANE.
 *   - `reopenClosedTab` — an async flow that re-issues a terminal session via
 *     /api/terminal/sessions (side-effect, must live outside Immer) and then
 *     dispatches PANE_ID_REMAP to swap every reference in-place.
 *   - `scheduleTerminalCleanup` / `cancelTerminalCleanup` — a module-level
 *     timer Map. Timers can't live in Immer state (pitfall #4).
 *
 * Everything else that used to be exported (legacy stack manipulation
 * primitives addClosedTab / pushClosedTab / popLastClosedTab / popClosedTab
 * / listClosedTabs) has been removed — external consumers use the
 * useClosedTabs hook, which talks to the reducer directly.
 */
import { usePaneStore } from '../store';
import type { Pane } from '../../../types';
import { createPaneId, getTerminalSessionFromPaneId } from './paneConfig';

/**
 * Legacy ClosedTabRecord shape. Preserved verbatim so consumers importing the
 * type continue to compile. The reducer's new `ClosedPaneRecord` is a
 * superset; serialization/deserialization between the two happens in the
 * adapter boundary.
 */
export interface ClosedTabRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;
  level: 'project' | 'app';
  projectPath?: string;
  terminal?: {
    sessionType: 'shell' | 'claude-code';
    cwd: string;
    name: string;
    claudeSessionId?: string;
    skipPermissions: boolean;
  };
  topicId?: string;
  filePath?: string;
}

// Module-level resource — see RESEARCH.md pitfall #4 (timers can't live in Immer state).
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Build a ClosedTabRecord from a live pane (pre-close snapshot).
 * Pure function — mirrors captureClosedTab from the legacy module.
 *
 * ID ALIGNMENT: record.id must equal pane.id so consumers that call
 * removeClosedTab(capturedRecord.id) match the reducer's ClosedPaneRecord
 * (which is keyed on pane.id). The legacy `closed-${ts}-${n}` scheme
 * produced ids that never matched anything in the reducer, making
 * CLEAR_CLOSED_RECORD a silent no-op.
 */
export function captureClosedTab(
  pane: Pane,
  groupId: string,
  groupIndex: number,
  level: 'project' | 'app',
  opts?: {
    projectPath?: string;
    terminal?: ClosedTabRecord['terminal'];
  },
): ClosedTabRecord {
  return {
    id: pane.id,
    closedAt: Date.now(),
    pane: { ...pane },
    groupId,
    groupIndex,
    level,
    projectPath: opts?.projectPath,
    terminal: opts?.terminal,
    topicId: pane.topicId,
    filePath: pane.filePath,
  };
}

/**
 * Reopen a closed tab. Terminal panes may need a fresh session id because the
 * original server session may have died — we POST to /api/terminal/sessions
 * and then dispatch PANE_ID_REMAP so every reference to the old id (groups,
 * focused id, closedStack) swaps to the new one atomically in the reducer.
 */
export function reopenClosedTab(record: ClosedTabRecord): Promise<Pane> {
  return reopenClosedTabImpl(record);
}

async function reopenClosedTabImpl(record: ClosedTabRecord): Promise<Pane> {
  // Cancel any pending cleanup (deferred terminal DELETE).
  cancelTerminalCleanup(record.id);

  if (record.pane.type === 'terminal' && record.terminal) {
    const sessionId = getTerminalSessionFromPaneId(record.pane.id);
    if (sessionId) {
      try {
        const check = await fetch(`/api/terminal/sessions/${sessionId}`);
        if (check.ok) {
          return record.pane;
        }
      } catch {
        /* session dead, recreate below */
      }
    }

    // Idempotency key: derived from paneId + closedAt so a retry after a
    // transient 5xx doesn't spawn duplicate terminals. The server honors
    // X-Idempotency-Key via an in-memory 60 s cache in
    // server/routes/terminal.ts.
    const idempotencyKey = `${record.pane.id}:${record.closedAt}`;

    const res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        cwd: record.terminal.cwd,
        type: record.terminal.sessionType,
        name: record.terminal.name,
        skipPermissions: record.terminal.skipPermissions,
        claudeSessionId: record.terminal.claudeSessionId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to recreate terminal session: ${res.status}`);
    }
    const session = await res.json();

    const newId = createPaneId('terminal', session.id);
    const reopenedPane: Pane = {
      ...record.pane,
      id: newId,
      title: session.name || record.pane.title || '',
    };

    // Keep reducer state coherent: remap every reference to the old id.
    usePaneStore.getState().dispatch({
      type: 'PANE_ID_REMAP',
      payload: { from: record.pane.id, to: newId },
    });

    return reopenedPane;
  }

  return record.pane;
}

/**
 * Schedule a deferred cleanup action (used by terminal DELETE debouncing).
 * Timer lives outside Immer state per pitfall #4.
 */
export function scheduleTerminalCleanup(
  recordId: string,
  delayMs: number,
  fn: () => void,
): void {
  const existing = cleanupTimers.get(recordId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cleanupTimers.delete(recordId);
    fn();
  }, delayMs);
  cleanupTimers.set(recordId, t);
}

export function cancelTerminalCleanup(recordId: string): void {
  const t = cleanupTimers.get(recordId);
  if (t) {
    clearTimeout(t);
    cleanupTimers.delete(recordId);
  }
}
