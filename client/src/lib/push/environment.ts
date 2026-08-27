/**
 * La fotografia dell'ambiente che `describePushState` giudica, e l'identità
 * stabile di questo dispositivo.
 *
 * Tutto ciò che tocca `navigator`, `Notification` o `localStorage` sta qui, e
 * solo qui: la decisione è pura e vive in `pushStatus.ts`, così si può testare
 * senza montare un browser.
 */

import { shellKind } from '../shell';
import { mediaQueryMatches } from '../mediaQuery';
import { webNotificationPermission } from '../shell/app';
import type { PushEnvironment, WebPermission } from './pushStatus';

const DEVICE_ID_KEY = 'topics.push.deviceId';

/**
 * L'id di QUESTO dispositivo, stabile nel tempo.
 *
 * Non è l'endpoint: quello è un URL che il browser rigenera da solo (chiavi
 * ruotate, PWA reinstallata) e che quindi non può reggere una preferenza. È un
 * numero casuale nel localStorage — cioè per-dispositivo e per-profilo, che è
 * esattamente la granularità con cui l'utente ragiona: «il telefono», «il Mac».
 *
 * Se il localStorage non è scrivibile (navigazione privata bloccata, storage
 * pieno) si restituisce comunque un id valido per questa sessione: peggio è
 * un'iscrizione che fallisce del tutto.
 */
export function pushDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh = newId();
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return newId();
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

/** iOS/iPadOS fuori dalla PWA installata: lì `PushManager` NON esiste, e non è
 *  un limite del browser ma una condizione con un rimedio preciso. Il controllo
 *  è duplice perché da iPadOS 13 un iPad si dichiara «Macintosh»: senza il
 *  marcatore touch un iPad in Safari finirebbe nel ramo desktop. */
function isIosWithoutInstall(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPhone = /iPhone|iPod/.test(ua);
  const iPadOs = /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  if (!iPhone && !iPadOs) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    mediaQueryMatches('(display-mode: standalone)');
  return !standalone;
}

/** `serviceWorker` + `PushManager`: senza entrambi non c'è niente da iscrivere. */
export function pushCapable(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window;
}

export function readPushEnvironment(subscribed: boolean): PushEnvironment {
  return {
    capable: pushCapable(),
    permission: webNotificationPermission() as WebPermission,
    subscribed,
    nativeShell: shellKind === 'tauri',
    iosNeedsInstall: isIosWithoutInstall(),
  };
}
