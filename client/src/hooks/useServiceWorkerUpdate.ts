/**
 * Service-worker update detection (passive, never auto-reloads).
 *
 * Revised 2026-05-11 — was the silent culprit behind "the app refreshes
 * by itself". Old behaviour:
 *   · `setInterval(() => reg.update(), 60_000)`  → polled every minute
 *   · auto `window.location.reload()` on `controllerchange` → ANY new SW
 *     activation kicked the user out of whatever they were doing
 *
 * Combined with the SW that called `skipWaiting()` + `clients.claim()` in
 * its own install/activate, every backend bundle change cascaded into a
 * forced reload within 60 s.
 *
 * New behaviour:
 *   · NO polling. The browser already runs its own SW update check on
 *     navigation and on tab focus — that's enough. Manual refreshes via
 *     the sidebar's "Reload" button still call `reg.update()` explicitly.
 *   · NO reload-on-controllerchange. We track `updateAvailable` so the
 *     UI can flag the sidebar reload button (text-primary tint), but
 *     never reload the page on the user's behalf. The user stays in
 *     control — they click Reload (or restart the Electron app) when
 *     ready.
 *   · `applyUpdate()` is still exposed for a future "Apply now" CTA, but
 *     the dispatch is initiated by the user, not by us.
 */
import { useState, useEffect, useCallback } from 'react';

// When a waiting SW was first observed, persisted so the "X hours in waiting"
// clock survives page reloads (the SW stays in `waiting` across reloads until
// something calls skipWaiting). Cleared once no SW is waiting anymore.
const WAITING_SINCE_KEY = 'topics:sw-waiting-since';

function readWaitingSince(): number | null {
  const v = Number(localStorage.getItem(WAITING_SINCE_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function useServiceWorkerUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  // Epoch ms when the current update first entered `waiting`, or null.
  const [waitingSince, setWaitingSince] = useState<number | null>(() => readWaitingSince());

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let disposed = false;
    // The registration this effect attached `updatefound` to, so cleanup can
    // remove exactly that listener (not just "some" registration).
    let boundReg: ServiceWorkerRegistration | null = null;

    // Stamp/clear the waiting clock: the FIRST time we see a waiting SW we
    // record the moment (unless a persisted stamp already survives a reload);
    // when nothing is waiting we forget it.
    const markWaiting = (waiting: boolean) => {
      if (waiting) {
        const existing = readWaitingSince();
        const since = existing ?? Date.now();
        if (!existing) localStorage.setItem(WAITING_SINCE_KEY, String(since));
        setWaitingSince(since);
      } else {
        localStorage.removeItem(WAITING_SINCE_KEY);
        setWaitingSince(null);
      }
    };

    // Named (not inline) so cleanup can remove the EXACT listener it added.
    // `navigator.serviceWorker.getRegistration()` returns the SAME
    // ServiceWorkerRegistration object for the whole page lifetime, so a
    // component that mounts this hook repeatedly (e.g. a popover opened and
    // closed many times) without this cleanup would pile up one 'updatefound'
    // listener per mount on that shared object, forever.
    const onUpdateFound = () => {
      const reg = boundReg;
      const newSW = reg?.installing;
      if (!newSW) return;
      const onStateChange = () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          setUpdateAvailable(true);
          markWaiting(true);
        }
        // The worker only passes through 'installed'/'redundant' once each —
        // drop the listener once its outcome is known instead of leaving it
        // bound to a settled worker for the rest of the page's life.
        if (newSW.state === 'installed' || newSW.state === 'redundant') {
          newSW.removeEventListener('statechange', onStateChange);
        }
      };
      newSW.addEventListener('statechange', onStateChange);
    };

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      setRegistration(reg);
      if (reg.waiting) {
        setUpdateAvailable(true);
        markWaiting(true);
        return;
      }
      boundReg = reg;
      reg.addEventListener('updatefound', onUpdateFound);
    };

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg && !disposed) handleUpdate(reg);
    });

    // NOTE: No `setInterval(reg.update, …)` here, and NO `controllerchange`
    // listener. Both used to live in this file and were the direct cause
    // of "the app refreshes by itself". The browser still runs its own
    // SW lifecycle (install on load, activate when no controllers, etc.) —
    // we just don't piggy-back a forced page reload onto any of it.
    return () => {
      disposed = true;
      boundReg?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (registration?.waiting) {
      registration.waiting.postMessage('SKIP_WAITING');
      // The clock is spent — the update is being applied.
      localStorage.removeItem(WAITING_SINCE_KEY);
      setWaitingSince(null);
    }
  }, [registration]);

  return { updateAvailable, applyUpdate, waitingSince };
}
