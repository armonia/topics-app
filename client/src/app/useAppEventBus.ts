import { useCallback, useEffect, type RefObject } from 'react';
import { selectDirectory } from '../lib/shell/app';
import { openTaskInApp } from '../lib/openTaskLink';
import type { UsePanelLifecycleReturn } from '../hooks/usePanelLifecycle';
import type { Topic } from '../types';

type PanelHandlers = UsePanelLifecycleReturn['handlers'];

interface AppEventBusArgs {
  handleProjectClick: PanelHandlers['handleProjectClick'];
  handleTerminalClick: PanelHandlers['handleTerminalClick'];
  handleTopicClick: PanelHandlers['handleTopicClick'];
  handleQuickCreateTopic: PanelHandlers['handleQuickCreateTopic'];
  handleQuickCreateTerminal: PanelHandlers['handleQuickCreateTerminal'];
  handleOpenBoard: () => void;
  claudeSkipPermissions: boolean;
  topicsRef: RefObject<Record<string, Topic>>;
}

/**
 * The window-level CustomEvent bus the app root answers: the project picker, the
 * chat's sub-agent strip and code-block terminal door, the compaction notice's
 * "new chat", and the native tray. Returns the project picker opener, which the
 * command palette shares.
 */
export function useAppEventBus({
  handleProjectClick, handleTerminalClick, handleTopicClick, handleQuickCreateTopic,
  handleQuickCreateTerminal, handleOpenBoard, claudeSkipPermissions, topicsRef,
}: AppEventBusArgs) {
  // Open / create a project via the native folder picker (select an existing
  // folder OR create a new one in the OS dialog). Shared by CommandPalette
  // (onNewProject) and PaneAddMenu's open/create project items, the latter
  // firing a window event so the action needs no prop-threading through every
  // menu host. Shell-resolved: Electron IPC dialog OR Tauri dialog plugin; no-op
  // (null) on web. Previously read electronAPI directly → dead under Tauri.
  const handleOpenProjectPicker = useCallback(async () => {
    // Guard the native dialog: a rejected/cancelled call must not bubble up as
    // an unhandled promise rejection. (Toast isn't reachable here, this
    // component renders ToastProvider, so swallow + log is the safe floor.)
    try {
      const path = await selectDirectory();
      if (path) handleProjectClick(path);
    } catch (err) {
      console.error('Project picker dialog failed', err);
    }
  }, [handleProjectClick]);

  useEffect(() => {
    const handler = () => { void handleOpenProjectPicker(); };
    window.addEventListener('topics:open-project-picker', handler);
    return () => window.removeEventListener('topics:open-project-picker', handler);
  }, [handleOpenProjectPicker]);

  // In-chat sub-agent strip → open/focus the sub-agent's terminal pane. Routed
  // via the CustomEvent bus (same pattern as topics:open-project-picker) so the
  // chat pane doesn't need handleTerminalClick threaded down three layers. The
  // handler is the exact same one the sidebar sub-agent rows use, so a click
  // from inside the topic lands on the identical (now non-blank) terminal pane.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string; name?: string } | undefined;
      if (!detail?.sessionId) return;
      // A native sub-agent has no terminal: its agentId is its chat's topic id.
      // Opening it as a terminal made a dead terminal tab; it opens as the chat.
      if (topicsRef.current[detail.sessionId]?.subagentOf) {
        window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: detail.sessionId, mode: 'permanent', reveal: true } }));
        return;
      }
      handleTerminalClick(detail.sessionId, detail.name || '');
    };
    window.addEventListener('topics:open-terminal-pane', handler as EventListener);
    return () => window.removeEventListener('topics:open-terminal-pane', handler as EventListener);
  }, [handleTerminalClick, topicsRef]);

  // «Open in terminal» under a code block of a reply (CHAT-RUN-05): a shell
  // where that chat's agent works, with the command typed and not run. Same
  // bus as above: the block lives deep inside the message list. Without a
  // sessionKey (the model selector's «Accedi», revision 2026-10-04 §4.6) the
  // shell opens in the home directory, with `codex login` typed, not run.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionKey?: string; command?: string } | undefined;
      if (!detail?.command) return;
      void handleQuickCreateTerminal('shell', claudeSkipPermissions, detail.sessionKey ? { cwdOf: detail.sessionKey, paste: detail.command } : { paste: detail.command });
    };
    window.addEventListener('topics:open-terminal-with-command', handler);
    return () => window.removeEventListener('topics:open-terminal-with-command', handler);
  }, [handleQuickCreateTerminal, claudeSkipPermissions]);

  // Compaction notice in the composer → "New chat". Same bus as the project
  // picker: the strip lives inside ChatInput, three levels down, and the only
  // alternative would have been threading onNewChat through ChatPane →
  // ChatInput just for a button that shows above 90% of the context.
  useEffect(() => {
    const handler = () => { handleQuickCreateTopic(); };
    window.addEventListener('topics:new-chat', handler);
    return () => window.removeEventListener('topics:new-chat', handler);
  }, [handleQuickCreateTopic]);

  // Native tray menu (Tauri) click on an attention row → open/focus that topic,
  // exactly like a sidebar click. The Rust `nav:` handler dispatches this DOM
  // CustomEvent into the webview (no @tauri-apps/event dependency).
  // A terminal row of the tray (notifications-redesign: the tray lists the
  // terminals the number counts) carries its `terminal:` subject instead.
  useEffect(() => {
    const handler = (e: Event) => {
      const topicId = (e as CustomEvent<{ topicId?: string }>).detail?.topicId;
      if (!topicId) return;
      if (topicId.startsWith('terminal:')) handleTerminalClick(topicId.slice('terminal:'.length), '');
      else handleTopicClick(topicId);
    };
    window.addEventListener('topics:tray-navigate', handler);
    return () => window.removeEventListener('topics:tray-navigate', handler);
  }, [handleTopicClick, handleTerminalClick]);

  // The tray's «Board» section: a status row opens THAT task (same deep-link as
  // the click on a notification, hence the same landing), the head of the
  // section opens the board from the SINGLE DOOR (`handleOpenBoard`), which is
  // also the only one that brings the window to the group where the board
  // lives. The job stays on this side: the tray says WHAT, the client knows HOW.
  useEffect(() => {
    const onTask = (e: Event) => {
      const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (taskId) openTaskInApp({ taskId });
    };
    const onBoard = () => { handleOpenBoard(); };
    window.addEventListener('topics:tray-open-task', onTask as EventListener);
    window.addEventListener('topics:tray-open-board', onBoard);
    return () => {
      window.removeEventListener('topics:tray-open-task', onTask as EventListener);
      window.removeEventListener('topics:tray-open-board', onBoard);
    };
  }, [handleOpenBoard]);

  return { handleOpenProjectPicker };
}
