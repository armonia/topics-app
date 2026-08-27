/**
 * useTaskBrowserTabsSync — bridge the server ↔ per-task tab store, in BOTH
 * directions.
 *
 * Outbound (open): when the agent working a task calls open_browser_pane on its
 * dispatch topic AND the server fork is enabled (env TOPICS_TASK_BROWSER), the
 * server emits `browser:open-task-tab {taskId, contextId, url}` INSTEAD of the
 * layout-level `browser:navigate`. The global layout hooks ignore that frame by
 * design — this hook upserts it into `taskBrowserTabs` so the task's in-drawer
 * group shows (and drives) the agent's browser, out of the global pane store.
 *
 * Inbound (cross-device sync): `taskBrowserTabs` persists via the generic ui-state
 * store but — unlike every other synced store — had NO inbound WS consumer, so it
 * was write-only. A park/close/reorder/rename on one device PUT the per-task key
 * and the server broadcast `ui-state:updated`, but no client applied it: the tab
 * stayed live on the other device until a full reload re-ran the initial GET. This
 * hook now also applies `ui-state:updated` (single key, own echo dropped by
 * sourceClientId) into the store, so closing a task browser tab on the Mac
 * closes it on the PWA live. Alla riconnessione l'`ui-state:init` fa da segnale
 * e il resync è mirato (`resyncTaskTabsFromServer`): le chiavi `task-browser-*`
 * non viaggiano più nello snapshot.
 *
 * Mounted once at App level (like useGlobalBoard / CompletionNotifierBridge)
 * so it's active whenever the app is running, regardless of which task drawer — if
 * any — is open. We `ensureLoaded` before an OPEN upsert so it merges onto the
 * task's persisted tabs instead of clobbering them.
 */
import { useEffect } from 'react';
import type { WSMessage } from '../types';
import {
  taskBrowserTabs,
  applyTaskTabOpen,
  applyRemoteTaskTabs,
  resyncTaskTabsFromServer,
  forgetTaskTabs,
  taskIdFromKey,
} from '../state/taskBrowserTabs';
import { forgetTaskLayout } from '../state/taskBrowserLayout';
import { getTabId } from '../state/pane/middleware/syncCrossTab';

export function useTaskBrowserTabsSync(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): void {
  useEffect(() => {
    return onWSMessage((msg: WSMessage) => {
      // Server-fork OPEN — an agent's open_browser_pane on its dispatch topic.
      if (msg.type === 'browser:open-task-tab') {
        const { taskId, contextId, url, title } = msg;
        if (!taskId || !contextId) return;
        // Load the task's persisted tabs first so the upsert merges rather than
        // committing a lone tab over a populated ui-state record. ensureLoaded is
        // idempotent; the upsert both refreshes/creates the tab and activates it,
        // so a live drawer on this task surfaces the agent's browser immediately.
        // `title` è il nome prescritto dall'agente: entra come `agent`, cioè
        // pinnato contro il poll del titolo di pagina ma non contro una rinomina.
        // `applyTaskTabOpen` upserts the record AND, for a tab that already
        // exists (hence already mounted), pushes the navigation: a mounted panel
        // reads `initialUrl` only at mount, so without it the tab kept showing
        // the previous page while the record claimed the new URL.
        void taskBrowserTabs.ensureLoaded(taskId).then(() => {
          applyTaskTabOpen(taskId, contextId, url ?? '', title ?? '', title ? 'agent' : 'auto');
        });
        return;
      }
      // Cross-device MUTATION — another client PUT a task-browser-tabs key; the
      // server rebroadcasts it here. Drop our own echo so a stale broadcast can't
      // revert a newer local edit (the PUT stamps X-Client-Id → sourceClientId).
      if (msg.type === 'ui-state:updated') {
        const taskId = taskIdFromKey(msg.key);
        if (!taskId) return;
        if (msg.sourceClientId && msg.sourceClientId === getTabId()) return;
        applyRemoteTaskTabs(taskId, msg.value);
        return;
      }
      // Reconnect resync — MIRATO. L'`ui-state:init` non porta più le chiavi
      // `task-browser-*` (erano il 30% del payload di ogni riconnessione e il
      // client le legge per-task); qui l'init vale solo come SEGNALE di
      // riconnessione: si ri-GETtano le sole chiavi dei task in cache. Lo
      // snapshot si passa lo stesso, così un server vecchio che le manda ancora
      // le fa applicare direttamente, senza GET.
      if (msg.type === 'ui-state:init') {
        void resyncTaskTabsFromServer(msg.data);
        return;
      }
      // ARCHIVED — the server has just deleted this task's two ui-state rows
      // (services/task-tab-teardown.ts) and closed its browser contexts. Forget
      // them here or our debounced PUT recreates the key seconds later, which is
      // exactly how these records became immortal in the first place. `taskIds`
      // carries the whole archived subtree (archiving cascades); older servers
      // omit it, so fall back to the root.
      if (msg.type === 'task:deleted') {
        for (const id of msg.taskIds?.length ? msg.taskIds : [msg.taskId]) {
          forgetTaskTabs(id);
          forgetTaskLayout(id);
        }
        return;
      }
    });
  }, [onWSMessage]);
}
