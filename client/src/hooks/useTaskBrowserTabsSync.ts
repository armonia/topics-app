/**
 * useTaskBrowserTabsSync — bridge the server's task-owned browser fork into the
 * per-task tab store.
 *
 * When the agent working a task calls open_browser_pane on its dispatch topic
 * AND the server fork is enabled (env TOPICS_TASK_BROWSER), the server emits
 * `browser:open-task-tab {taskId, contextId, url}` INSTEAD of the layout-level
 * `browser:navigate`. The global layout hooks ignore that frame by design — this
 * hook is its ONLY consumer: it upserts the tab into `taskBrowserTabs` so the
 * task's in-drawer group shows (and drives) the agent's browser, out of the
 * global pane store entirely.
 *
 * Mounted once at App level (like useGlobalBoardCount / useClaudeEventNotifications)
 * so an agent open is captured whenever the app is running, regardless of which
 * task drawer — if any — is currently open. The upsert persists via ui-state, so
 * the tab survives a reload once it's been heard. We `ensureLoaded` first so the
 * upsert merges onto the task's persisted tabs instead of clobbering them.
 */
import { useEffect } from 'react';
import type { WSMessage } from '../types';
import { taskBrowserTabs } from '../state/taskBrowserTabs';

export function useTaskBrowserTabsSync(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): void {
  useEffect(() => {
    return onWSMessage((msg: WSMessage) => {
      if (msg.type !== 'browser:open-task-tab') return;
      const { taskId, contextId, url } = msg;
      if (!taskId || !contextId) return;
      // Load the task's persisted tabs first so the upsert merges rather than
      // committing a lone tab over a populated ui-state record. ensureLoaded is
      // idempotent; the upsert both refreshes/creates the tab and activates it,
      // so a live drawer on this task surfaces the agent's browser immediately.
      void taskBrowserTabs.ensureLoaded(taskId).then(() => {
        taskBrowserTabs.upsertTab(taskId, contextId, url ?? '');
      });
    });
  }, [onWSMessage]);
}
