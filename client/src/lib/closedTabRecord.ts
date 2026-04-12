import type { Pane } from '../types';
import { createPaneId, getTerminalSessionFromPaneId } from './paneConfig';

/**
 * Captures everything needed to reopen a closed tab — works for all pane types.
 * Used by both the "recently closed" stack and the UI undo system.
 */
export interface ClosedTabRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;          // position within the group's paneIds
  level: 'project' | 'app';
  projectPath?: string;
  // Terminal restoration metadata (not available from Pane alone)
  terminal?: {
    sessionType: 'shell' | 'claude-code';
    cwd: string;
    name: string;
    claudeSessionId?: string;
    skipPermissions: boolean;
  };
  topicId?: string;
  filePath?: string;
  // Cleanup timer: for terminals, DELETE is deferred so undo can cancel it
  _cleanupTimer?: ReturnType<typeof setTimeout>;
}

let _recordCounter = 0;

/** Capture a pane's state before closing, ready for later restoration. */
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
    id: `closed-${Date.now()}-${++_recordCounter}`,
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
 * Reopen a closed tab. For terminals, creates a new server session
 * (original session may be dead) and returns the new pane with updated ID.
 * For everything else, returns the original pane as-is.
 */
export async function reopenClosedTab(record: ClosedTabRecord): Promise<Pane> {
  // Cancel any pending cleanup (e.g., deferred terminal DELETE)
  if (record._cleanupTimer) {
    clearTimeout(record._cleanupTimer);
    record._cleanupTimer = undefined;
  }

  if (record.pane.type === 'terminal' && record.terminal) {
    // Check if the original session is still alive
    const sessionId = getTerminalSessionFromPaneId(record.pane.id);
    if (sessionId) {
      try {
        const check = await fetch(`/api/terminal/sessions/${sessionId}`);
        if (check.ok) {
          // Session still alive — reuse it
          return record.pane;
        }
      } catch { /* session dead, recreate below */ }
    }

    // Create a new terminal session with the same parameters
    const res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: record.terminal.cwd,
        type: record.terminal.sessionType,
        name: record.terminal.name,
        skipPermissions: record.terminal.skipPermissions,
        claudeSessionId: record.terminal.claudeSessionId,
      }),
    });

    if (!res.ok) throw new Error(`Failed to recreate terminal session: ${res.status}`);
    const session = await res.json();

    return {
      ...record.pane,
      id: createPaneId('terminal', session.id),
      title: session.name || record.pane.title,
    };
  }

  // Non-terminal panes: return as-is
  return record.pane;
}
