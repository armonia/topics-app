import { useState, useEffect, type ComponentType } from 'react';
import { sweepAskDrafts } from '../components/Chat/askDraft';
import { initDevBundleReload } from '../lib/devBundleReload';
import { initDevLayoutProbe } from '../lib/devLayoutProbe';
import { initDevHeapProbe } from '../lib/devHeapProbe';
import { initDevStorageProbe } from '../lib/devStorageProbe';
import { registerFeatureWeightSources } from '../lib/featureWeightSources';
import { initChunkReloadGuard, reportLoadFailure } from '../lib/chunkReloadGuard';
import { subscribeServiceWorkerTaskOpen } from '../lib/deepLinkEntry';
import { subscribeServiceWorkerBanner } from '../lib/push/swBridge';
import { flushAtPageExit } from '../lib/pageExitFlush';
import { initEdgeSwipeGuard } from '../lib/edgeSwipeGuard';
import { decodeNotifyTarget, openNotifyToken } from '../lib/notify/notifyTarget';
import { runNotificationAction } from '../lib/notify/notificationAction';
import { boardNotificationDeps } from '../lib/notify/boardActionDeps';
import { isTauri } from '../lib/shell';
import { importCommandPalette } from './commandPaletteChunk';

/**
 * The mount-time side effects of the app root that read no state: dev probes,
 * service worker bridges, the ⌘K warm-up and the unload flush. Returns the
 * DEV-only pane-store overlay once it has loaded (null in production).
 */
export function useAppBootstrap(): ComponentType | null {
  // DEV-only overlay, lazy-loaded via dynamic import() so the module stays
  // out of the production graph entirely (PANE-05 strip contract). The static
  // import was fragile: Vite minification could flatten the path string and
  // the strip-assert script would false-green.
  const [DevOverlay, setDevOverlay] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) {
      void (async () => {
        const { MutationLogOverlay } = await import('../state/pane/devOverlay');
        setDevOverlay(() => MutationLogOverlay);
      })();
    }
  }, []);

  // The answer panel's drafts expire on their own, but a question that is never
  // answered has no other moment at which to be cleaned up: it is swept at
  // startup. See Chat/askDraft.ts.
  useEffect(() => { sweepAskDrafts(); }, []);

  // Dev bundle freshness: when the server (behind its dev flag) says /public
  // was rebuilt, OR a lazy chunk 404s against a rebuilt bundle, surface a
  // "Ricarica" prompt (DevBundleToast), never an auto-reload under the user.
  // See lib/devBundleReload.ts + lib/chunkReloadGuard.ts.
  useEffect(() => {
    const offRev = initDevBundleReload();
    const offChunk = initChunkReloadGuard();
    return () => { offRev(); offChunk(); };
  }, []);

  // Layout diagnosis probe: inert until someone ARMS it by writing
  // `dev-layout-probe` in the ui-state. It exists to say WHO dirties the layout
  // in the real app, where the native profilers cannot name the JS and the E2E
  // environment does not reproduce the problem. See lib/devLayoutProbe.ts.
  useEffect(() => initDevLayoutProbe(), []);
  useEffect(() => initDevHeapProbe(), []);
  // Who writes to localStorage, and how many bytes a minute: the WebKit journal
  // grows with the number of rewrites, not with what is stored. See
  // lib/devStorageProbe.ts.
  useEffect(() => initDevStorageProbe(), []);
  /* THE WEIGHT INVENTORY: who declares what. A single registration, here, and
   * not scattered across the stores, a list that silently omits is worse than
   * no list, because the reader believes they see everything. See
   * `lib/featureWeightSources.ts`.
   *
   * It ABSORBED the two `registerHeapOwner` calls that used to be here
   * (`pane.store` and `pane.residency`): they were the same mechanism with a
   * registry of its own, and two lists of owners diverge as soon as one of
   * them is updated alone. */
  useEffect(() => registerFeatureWeightSources(), []);

  // Click on a web-push (app open but in the background): the service worker
  // focuses this window and hands it the destination, because it cannot
  // navigate it without reloading the SPA. Same path as the `/task/<id>`
  // deep-links.
  useEffect(() => subscribeServiceWorkerTaskOpen(), []);
  // Its twin: with the «banner in Topics» preference the service worker does NOT
  // show the system notification and sends the content here. Without this
  // listener that preference would be an elaborate way of saying «no
  // notification».
  useEffect(() => subscribeServiceWorkerBanner(), []);

  // Warm the ⌘K command-palette chunk on idle so its FIRST open is composited
  // from an already-parsed module (no fetch+eval on the opening frame). Idle-
  // scheduled so it never competes with the initial paint; guarded for Safari
  // (no requestIdleCallback) with a setTimeout fallback.
  useEffect(() => {
    const warm = () => { void importCommandPalette().catch(reportLoadFailure); };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) { const id = ric(warm, { timeout: 3000 }); return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(id); }
    const t = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(t);
  }, []);

  // Unload-time flush: commit the closes still counting down, THEN flush what
  // they produced. Order matters and is why this lives in ONE handler instead
  // of independent `pagehide` listeners, which register at bootstrap, before
  // this component mounts, and so run before the commit (`lib/pageExitFlush`).
  useEffect(() => {
    const onUnload = flushAtPageExit;
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  // Edge swipes no longer navigate (iOS PWA only): see `edgeSwipeGuard`, which
  // also explains why history is not involved and what price is paid on the
  // controls that live on the edge.
  useEffect(() => initEdgeSwipeGuard(), []);
  return DevOverlay;
}

/**
 * The globals the native shells call into: the notification click, its action
 * buttons, and the Tauri sidebar toggle the FPS self-test drives.
 */
export function useShellGlobals(toggleSidebar: () => void): void {
  // Diagnostic (Tauri): expose the sidebar toggle so the env-gated FPS self-test
  // (TOPICS_FPS_SELFTEST, injected at boot by src-tauri) can drive a real
  // collapse/expand and sample rAF frame timing. Inert when the test isn't running.
  useEffect(() => {
    if (!isTauri) return;
    (window as unknown as { __topicsToggleSidebar?: () => void }).__topicsToggleSidebar = toggleSidebar;
  }, [toggleSidebar]);

  // A stable global the native (Tauri) notification delegate can call on click to
  // open a banner's destination. The web/Electron path gets there by itself
  // (notifyNative.onclick).
  //
  // It receives a TOKEN, not a task id: the shell only carries it, and the same
  // string is valid for a task (`/task/<id>`) or a topic (`/topic/<id>`).
  // Before, "it is always a task" was assumed here, so every chat banner left
  // with no target and the click only raised the window. The name of the global
  // stays this one because it is the one the shells already installed call:
  // the decoding lives in lib/notify/notifyTarget.ts.
  useEffect(() => {
    (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask =
      (id: string) => { openNotifyToken(id); };
    return () => { delete (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask; };
  }, []);

  // The twin of the previous one for the native banner's BUTTONS: the Rust
  // delegate reads `actionIdentifier` and calls here. The shell carries, the
  // client executes, the call needs the session, cookie and board endpoint,
  // which live on this side.
  //
  // The project is RESOLVED from the id instead of travelling in the
  // notification: so a banner still hanging in the Notification Centre stays
  // pressable even after an app restart, which is precisely when an in-memory
  // map would already have forgotten everything.
  //
  // What resolves is `boardApi.resolve` (inside `boardNotificationDeps`), the
  // single door "from an id to its task, at any depth". Before, the global feed
  // was searched, which is `rootsOnly`, so for a SUBTASK id the find returned
  // `undefined`, the project stayed `null` and the button fell back to "open
  // the task". That is: precisely the step banners, which are the majority of
  // those that ask for an answer, never did their action.
  useEffect(() => {
    type ActionGlobal = { __topicsNotificationAction?: (taskId: string, actionId: string) => void };
    (window as unknown as ActionGlobal).__topicsNotificationAction = (taskId: string, actionId: string) => {
      // The shell sends the same token as the click on the body: here it only
      // runs if it is a TASK token, because the buttons are board actions. A
      // topic token carries no buttons, but decoding it costs nothing and
      // removes the possibility that a call leaves with an id that is not a task.
      const target = decodeNotifyTarget(taskId);
      if (target?.kind !== 'task') return;
      // The same dependencies the in-page banner of the `in-app` push uses
      // (`InAppBanners`): two surfaces, one executor and one wiring.
      void runNotificationAction(target.id, actionId, boardNotificationDeps());
    };
    return () => { delete (window as unknown as ActionGlobal).__topicsNotificationAction; };
  }, []);
}
