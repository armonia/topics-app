/**
 * Shared types for the App.tsx hook decomposition (Phase 3 refactor).
 *
 * The 4 hooks (useSidebarAndLayout, useTerminalLifecycle, usePanelLifecycle,
 * useKeyboardShortcuts) share a small surface of cross-hook contracts:
 *  - chat-stream callbacks (read-only / append-only — no setters cross seam)
 *  - terminal lifecycle ops (markRecentlyCreated etc.)
 *
 * Co-locating the contracts here keeps the per-hook signatures tight while
 * making the seams explicit. Per CRITIQUE C5: NO `setOpenPanels` ever
 * crosses a hook seam — the terminal hook exports a pure prune helper
 * (`pruneStaleTerminalPanes`) and the panel hook calls it from its own effect.
 */

import type { Message, TerminalSessionInfo } from '../types';

/**
 * Stream / WS callbacks the panel hook needs from useChat.
 * All read-only or append-only — no mutating setters cross the seam.
 */
export interface ChatStreamHandlers {
  isOwnStream: (sessionKey: string) => boolean;
  getSessionMessages: (sessionKey: string) => Message[];
  addMessageFromWS: (
    sessionKey: string,
    msg: { role: 'user' | 'assistant'; content: string; timestamp: string },
  ) => void;
  clearSession: (sessionKey: string) => void;
  loadHistory: (sessionKey: string) => void;
  appendMediaToLastAssistant: (sessionKey: string, media: string[]) => void;
  sendMessage: (
    sessionKey: string,
    content: string,
    options?: { planMode?: boolean },
  ) => Promise<unknown>;
  drainQueue: () => void;
}

/**
 * Operations exposed by `useTerminalLifecycle` for `usePanelLifecycle`.
 * The panel hook calls these from `handleQuickCreateTerminal` /
 * `handleCloseTerminal` so the terminal hook can keep its own state +
 * grace-period ref consistent without sharing setters.
 */
export interface TerminalOps {
  /** Optimistic insert into terminalSessions (called by quick-create). */
  addOptimisticSession: (session: TerminalSessionInfo) => void;
  /** Mark a session id as recently created (5s grace). */
  markRecentlyCreated: (sessionId: string) => void;
  /** Remove a session id (called by handleCloseTerminal). */
  removeSession: (sessionId: string) => void;
}
