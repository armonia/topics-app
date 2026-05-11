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

export function useServiceWorkerUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      setRegistration(reg);
      if (reg.waiting) {
        setUpdateAvailable(true);
        return;
      }
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            setUpdateAvailable(true);
          }
        });
      });
    };

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) handleUpdate(reg);
    });

    // NOTE: No `setInterval(reg.update, …)` here, and NO `controllerchange`
    // listener. Both used to live in this file and were the direct cause
    // of "the app refreshes by itself". The browser still runs its own
    // SW lifecycle (install on load, activate when no controllers, etc.) —
    // we just don't piggy-back a forced page reload onto any of it.
  }, []);

  const applyUpdate = useCallback(() => {
    if (registration?.waiting) {
      registration.waiting.postMessage('SKIP_WAITING');
    }
  }, [registration]);

  return { updateAvailable, applyUpdate };
}
