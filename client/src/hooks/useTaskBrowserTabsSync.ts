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
import { topicIdFromKey } from '../state/topicBrowserKey';
import { getTabId } from '../state/pane/middleware/syncCrossTab';

/**
 * The per-topic browser window store, loaded on first use.
 *
 * This hook is mounted in App, so a static import put the whole store in the
 * entry chunk, which everyone downloads before anything renders (check:bundle
 * went over budget on it). Only the frames that are FOR a topic window need it,
 * and deciding that is a key-prefix check (`topicIdFromKey`) that answers
 * synchronously, so the early return stays synchronous too.
 *
 * One promise for every caller: `.then` callbacks on the same promise run in
 * the order they were attached, so frames reach the store in the order they
 * arrived, before and after the chunk has loaded.
 */
// Destructured on purpose, not `import(...)` handed around whole: knip reads a
// bare `import()` as opaque and would count every export of the store as used
// (`check:deadcode-blindspots`).
const importTopicWindowStore = async () => {
  const { applyTopicWindowFrame, reloadTopicWindowsFromServer, forgetTopicWindow } = await import(
    '../state/topicBrowserWindow'
  );
  return { applyTopicWindowFrame, reloadTopicWindowsFromServer, forgetTopicWindow };
};
let topicWindowStore: ReturnType<typeof importTopicWindowStore> | null = null;
const loadTopicWindowStore = () => (topicWindowStore ??= importTopicWindowStore());

/**
 * Route one WS frame. Exported so the routing can be tested without React; the
 * promise it returns, when the frame went to the lazily loaded topic window
 * store, resolves once the store has applied it.
 */
export function routeTaskBrowserFrame(msg: WSMessage): Promise<void> | undefined {
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
    // Same bridge, other store: the per-topic browser window
    // (`topic-browser:<topicId>`) drops its own echo inside
    // `applyTopicWindowFrame`.
    if (topicIdFromKey(msg.key)) {
      return loadTopicWindowStore().then((store) => { store.applyTopicWindowFrame(msg); });
    }
    const taskId = taskIdFromKey(msg.key);
    if (!taskId) return;
    if (msg.sourceClientId && msg.sourceClientId === getTabId()) return;
    // server_seq orders this frame against a PUT of ours that may still be in
    // flight: without it the store can only hold the frame and adopt it blindly.
    applyRemoteTaskTabs(taskId, msg.value, msg.server_seq);
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
    return loadTopicWindowStore().then((store) => store.reloadTopicWindowsFromServer(msg.data));
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
  // Same story one level up: archiving a TOPIC deletes its
  // `topic-browser:<topicId>` row (services/topic-browser-teardown.ts).
  // Without this the debounced PUT of an open window writes the key back a
  // second later, and the row outlives the topic forever.
  //
  // Only when the topic IS archived: the server sends the same frame with
  // `archived: false` to unarchive a topic, from a bulk unarchive, and when
  // it repairs a coordinator's provider, prompt or icon. None of those
  // deletes the row, and forgetting there threw away a queued move and left
  // an empty cache that a later `open` would PUT over the saved window.
  if (msg.type === 'topic:archived') {
    const topic = msg.topic;
    if (!topic?.archived) return;
    return loadTopicWindowStore().then((store) => store.forgetTopicWindow(topic.id));
  }
  return undefined;
}

export function useTaskBrowserTabsSync(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): void {
  useEffect(() => onWSMessage((msg: WSMessage) => { void routeTaskBrowserFrame(msg); }), [onWSMessage]);
}
