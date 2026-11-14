import { useEffect } from 'react';
import { useToast } from '../components/Shared/Toast';
import { currentTaskTarget } from '../lib/openTaskLink';
import { openTaskFromUrl, setDeepLinkNotifier } from '../lib/deepLinkEntry';
import { consumeTabLinkFromUrl, currentTabTarget, openTabInApp, openTabInAppWhenHydrated, tabAckReleasesIntent } from '../lib/tabLink';
import { TAB_PATH_PREFIX, type TabTarget } from '../../../shared/tab-link';
import { installOsOpenPathBridge, defaultOsOpenDeps } from '../lib/osOpenPath';
import { usePaneStore } from '../state/pane/store';
import { hubBookmarkTarget, openHubBookmarkWhenHydrated } from '../lib/hubPlaces';

/**
 * The deep-link target the URL carries at boot, or `null`.
 *
 * `currentTabTarget()` covers the whole permalink grammar (`/tab/…`) and the
 * `/task/<id>` and `/topic/<id>` aliases. ONE form stays out: the LEGACY query
 * `?task=<slug>~<id>`, which is not in the `/tab/` grammar and only
 * `openTaskLink` can read. The bridge exists because those links are already
 * pasted in review comments: without it they would open the drawer at mount
 * and then see their focus stolen by the hydrate, which is exactly the
 * regression the re-assertion exists to prevent.
 */
function bootDeepLinkTarget(): TabTarget | null {
  try {
    const direct = currentTabTarget();
    if (direct) return direct;
    const legacy = currentTaskTarget();
    return legacy ? { kind: 'task', key: legacy.taskId } : null;
  } catch {
    return null;
  }
}

// The boot deep-link is read ONCE, at module load, before React mounts. This is
// not an optimisation: a `/tab/…` route is CONSUMED (stripped from the URL), so
// reading it again later would give `null`. In dev StrictMode mounts, unmounts
// and remounts, and with the read inside the effect the second pass would find
// an already clean URL: the permalink would open nothing exactly while it is
// being tried. Same reason `detachedTopicIds` parses the query once.
const BOOT_TAB_PERMALINK = (() => {
  try {
    return window.location.pathname.startsWith(TAB_PATH_PREFIX);
  } catch {
    return false;
  }
})();
const BOOT_DEEP_LINK = bootDeepLinkTarget();

/**
 * The boot deep-link. THREE routes, one effect because it is ONE race:
 *   /task/<taskId>  (+ the legacy form ?task=<slug>~<taskId>) → the board drawer
 *   /topic/<topicId>                                          → the chat
 *   /tab/<kind>/…                                             → any tab
 *
 * ── Why this is a component, and why it sits INSIDE ToastProvider ────────────
 * Because a SILENT rejection is the worst of the three outcomes. `openTabInApp`
 * can say "this tab no longer exists", but only to a caller that passes it a
 * `notify`, and for a whole year no call-site did, so every dead end was a
 * silent no-op: you click the link, nothing happens, and you do not know why.
 * The toast, though, is a context, and App cannot read it: App is what renders
 * `<ToastProvider>`, so `useToast()` inside App returns the no-op (Toast.tsx).
 * Hence the extraction: the effect is identical, but it runs in a component
 * mounted under the provider, where the toast really exists.
 *
 * ── The re-assertion, and why it exists ─────────────────────────────────────
 * The single mount-time fire RACES the boot pane-store hydrate: the first
 * `ui-state:init` re-runs the focus reconciliation and restores the
 * previously-focused pane, stealing the board activation before its drawer
 * opens (repro: open /task/<id> cold → the last project pane shows, no
 * drawer). So we RE-ASSERT the deep-link on each pane-store hydrate during a
 * short boot window, riding the same (proven-working) open path once the store
 * is stable. Bounded and safe: it stops the instant the drawer opens
 * (`topics:task-opened`) or when the permalink declares it has ARRIVED, or
 * that it has no destination, with `topics:tab-opened`; only re-fires while the
 * URL still carries the target, and self-cancels after the boot window so it
 * can never yank focus from a user who has since navigated elsewhere.
 *
 * ⚠︎ Why the SUCCESS ack matters as much as the failure one: `stop` is the
 * only thing that switches off the 8s window, and inside that window the
 * subscription to `lastSeq` wakes at EVERY dispatch, a click on another tab
 * produces one (FOCUS_PANE), so 400ms later the re-assertion threw the user
 * back onto the permalink. On every click, for eight seconds.
 *
 * The target is read with `currentTabTarget()`, which is the SUPERSET: `/tab/…`
 * plus the `/task/` and `/topic/` aliases. Two intended consequences: a
 * `/topic/<id>` opened cold, the destination of the end-of-turn push, used to
 * die on the `currentTaskTarget()` guard and opened nothing; and every tab
 * permalink inherits the same anti-focus-theft protection as the board
 * deep-link (the `topics:open-tab` intent in usePanelLifecycle).
 */
export function BootDeepLinkResolver({ isDetached }: { isDetached: boolean }) {
  // `useToast()` returns the provider's STABLE API (Toast.tsx: two contexts,
  // the senders one never changes identity after mount), so it sits among the
  // dependencies like any other fixed value and the boot effect runs once.
  // Until 2026-08-15 there was a ref-shim synced in an effect here: it was
  // needed because the context value was rebuilt on every App render, and
  // putting it among the dependencies would have restarted the whole boot race
  // on every toast shown.
  const toast = useToast();
  // THE WARNING CHANNEL FOR THE NOTIFICATION CLICKS, registered from the one
  // component that sits under `<ToastProvider>`. A native banner, a web-push and
  // a row of the bell history all land in `openDeepLinkInApp`, which is a pure
  // module and cannot read a React context: without this registration a topic
  // that no longer exists would go from minting a ghost tab to doing nothing at
  // all, which is the outcome this repository calls the worst of the three.
  useEffect(() => setDeepLinkNotifier((message) => toast.warning(message)), [toast]);
  // `/lavori[/<filter>]`: System > Agenti e lavori on that filter (the hub's `#work/<filter>`,
  // where the tray pointed). After the menu hosts have mounted their listeners: the next tick.
  useEffect(() => {
    if (isDetached) return;
    // Loaded only for such an address: the boot chunk does not carry it.
    if (!window.location.pathname.startsWith('/lavori')) return;
    const consume = async () => {
      const { consumeAgentsJobsLinkFromUrl } = await import('../lib/agentsJobsLink');
      consumeAgentsJobsLinkFromUrl();
    };
    const t = setTimeout(() => { void consume(); }, 0);
    return () => clearTimeout(t);
  }, [isDetached]);
  // An old bookmark of the hub (`:3360/#automations` sends here keeping its fragment): the place
  // of Topics that took that page, once the pane store has hydrated (lib/hubPlaces).
  useEffect(() => {
    if (isDetached) return;
    if (!hubBookmarkTarget(window.location.hash)) return;
    return openHubBookmarkWhenHydrated();
  }, [isDetached]);
  useEffect(() => {
    // DETACHED windows (`?topics=`) are read-only towards the pane-store
    // (bootstrap.ts: no local persistence, no PUT, no cross-tab): if they
    // resolved a permalink on their own they would mint panes that nobody
    // persists, the incident of 2026-07-20, nine orphan browser panes in
    // group:default. They neither consume nor open: it is the least invasive
    // way, because FORWARDING to the main window would mean switching on here
    // the cross-tab channel that the detached window keeps off on purpose. And
    // above all the URL is NOT stripped: the `?topics=` query IS the window's
    // identity, cleaning it would turn it into a main window at the first
    // reload.
    // (`consumeTabLinkFromUrl` now has the same guard of its own: this one
    // stays because the rest of the race is here too.)
    if (isDetached) return;
    const boot = BOOT_DEEP_LINK;
    if (!BOOT_TAB_PERMALINK && !boot) return;
    // The channel to tell the user the link leads nowhere. `warning` and not
    // `error`: it is not an app failure, it is an old address.
    const notify = (message: string) => toast.warning(message);
    // A `/tab/` route is CONSUMED (the pane-store already is the tab's
    // persistence: leaving it in the URL would reopen it on every reload,
    // forever, the known defect of `/topic/<id>`). It must be consumed even
    // when the target is UNREADABLE: a `/tab/…` that opens nothing must still
    // disappear, or it comes back identical at every reload. `/task/` and
    // `/topic/` stay where they are instead: the first is the live reflection
    // of the drawer, and is not ours.
    //
    // `consumeTabLinkFromUrl` strips at once and ROUTES after hydration: it is
    // now the guaranteed shot for a `/tab/…` permalink (see `kick`).
    const consumed = BOOT_TAB_PERMALINK ? consumeTabLinkFromUrl({ notify }) : null;
    if (!BOOT_TAB_PERMALINK) openTaskFromUrl();
    if (!boot) return;
    let done = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (done) return;
      done = true;
      unsub();
      kick();
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      window.removeEventListener('topics:task-opened', stop);
      window.removeEventListener('topics:tab-opened', onTabAck);
    };
    // The ack of a permalink switches off the re-assertion ONLY if it is a dead end.
    //
    // Why not on success too, which would be the natural reading of "the race
    // is over": the success ack is emitted by `scheduleOpenAck` as soon as the
    // pane APPEARS in the store, i.e. an instant after the open, while the
    // hydrate wave may still have a tail (`ui-state:updated` from peers).
    // Stopping there means withdrawing the guard too early: the tab opens, a
    // late hydrate steals its focus and nothing is left to bring it back
    // (TABLINK-05/06, `data-active` staying `false` forever). On a dead end
    // stopping at once stays right: there is no pane to bring back to focus.
    const onTabAck = (e: Event) => {
      if (tabAckReleasesIntent((e as CustomEvent<unknown>).detail)) stop();
    };
    // DEBOUNCED re-assert: a hydrate wave re-runs the focus reconciliation, so
    // we wait for it to go QUIET (no new seq for 400ms) and then re-assert ONCE
    //, matching the stable post-boot open path. Re-asserting on every wave
    // instead flaps the drawer; firing only after the storm settles does not.
    const scheduleReassert = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        // The URL stays the source while it is there: if the drawer already
        // took it back to '/' (the user closed the task), NOTHING is reopened.
        // The target captured at boot is valid ONLY for a `/tab/` permalink,
        // which by construction is no longer in the URL, we consumed it.
        const target = currentTabTarget() ?? (BOOT_TAB_PERMALINK ? boot : null);
        if (done || !target) return;
        openTabInApp(target, { notify });
        // ONE re-assertion only for a TAB permalink, then stop.
        // Belt AND braces: the tab already has its ack (`topics:tab-opened`) and
        // its focus intent with a TTL in usePanelLifecycle, so this
        // re-assertion is only the reinforcement for the case where the ack is
        // late. The BOARD deep-link instead stays on an open loop: its ack
        // comes from the drawer, which can take more than one settle, and
        // there the re-assertion is the only protection.
        if (BOOT_TAB_PERMALINK) stop();
      }, 400);
    };
    const unsub = usePaneStore.subscribe((s) => s.lastSeq, scheduleReassert);
    // The GUARANTEED shot, and the reason it is no longer a `setTimeout(0)`.
    //
    // The bus listeners (`topics:open-topic`, `topics:open-terminal-pane`,
    // `topics:open-utility`…) live in usePanelLifecycle and on the first round
    // of effects they are not registered yet, so an open at mount is lost: a
    // deferral was needed anyway. But the right deferral is not "one tick", it
    // is THE FIRST HYDRATE of the pane-store (`openTabInAppWhenHydrated`, where
    // the matrix of the five measured configurations lives). Opening earlier is
    // TABLINK-06: the permalink to an ALREADY OPEN chat that made it vanish from
    // the bar at ~1800ms. And it is also conceptually right: the link says
    // "take me to this tab", and to know whether the tab is already there you
    // must have received the state.
    //
    // For a `/tab/…` route `consumeTabLinkFromUrl` already armed the shot (same
    // wait): arming a second one would mean opening twice, which is the
    // configuration TABLINK-06 finds red. When instead the consume armed nothing
    //, `null`, i.e. the URL was already clean: it is the SECOND mount of
    // StrictMode in dev, the shot is given from here, on the target captured
    // at module level. Without this distinction, in dev the permalink would
    // never open.
    const kick = consumed ?? openTabInAppWhenHydrated(boot, { notify });
    // Drawer opened → the deep-link is fulfilled, stand down.
    window.addEventListener('topics:task-opened', stop);
    // Permalink ARRIVED (the pane appeared) or without a destination (the tab
    // no longer exists): either way there is nothing left to re-assert, and
    // stopping at once avoids 8s in which every click is yanked back.
    window.addEventListener('topics:tab-opened', onTabAck);
    // Boot window only, never yank focus long after load.
    const deadline = setTimeout(stop, 8000);
    return stop;
  }, [isDetached, toast]);

  // "OPEN WITH TOPICS" from the operating system: a file or a folder opened from
  // the Finder, or dragged onto the dock icon. It is a deep-link like the ones
  // above, only the OS delivers it: the Rust shell queues the path and rings the
  // bell, here the queue is drained and opened through the same door
  // (`openTabInApp`), which already knows how to wait for the project window to
  // mount.
  //
  // The round made at mount is the half that counts: the path of a COLD LAUNCH
  // arrives before this page exists, so no event could have picked it up.
  // Detached windows route nothing, as above; outside Tauri the bridge does not
  // even register the listener.
  useEffect(() => {
    if (isDetached) return;
    return installOsOpenPathBridge(defaultOsOpenDeps((message) => toast.warning(message)));
  }, [isDetached, toast]);
  return null;
}
