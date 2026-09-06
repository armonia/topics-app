// App lifecycle + external-link capabilities, unified across Electron / Tauri / web.
// PORTING-PLAN.md §5b. Callsites import from here instead of branching on the host.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';
import { encodeNotifyTarget, openNotifyTarget, type NotifyTarget } from '../notify/notifyTarget';
import { markReloadFlash } from '../reloadFlash';
import type { NotifyAction } from '../../../../shared/notify-actions';

// `openExternal` now lives in ./external, a leaf that depends only on the host.
// It was moved out of here because this module also owns the notification
// banner, so importing it for an external link pulled in the whole notify stack
// and closed an import cycle. Import it from './shell/external'.

/** Native folder picker — returns the chosen directory path, or null if the user
 *  cancelled. No-op (null) on web/PWA where there's no OS dialog. */
export async function selectDirectory(): Promise<string | null> {
  switch (shellKind) {
    case 'tauri': {
      // tauri-plugin-dialog: open({ directory: true }) → string | string[] | null.
      const sel = await tauriInvoke<string | string[] | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Apri / Crea progetto' },
      });
      return typeof sel === 'string' ? sel : null;
    }
    default:
      return null;
  }
}

/**
 * Fire a native OS notification (completion / idle banners), unified across hosts.
 *
 * Returns true iff a banner was posted SYNCHRONOUSLY (Electron renderer / web, via
 * the permission-gated web Notification API) so the caller can drop a redundant
 * in-app toast. Tauri routes through the native `notify` command — WKWebView's web
 * Notification API is unreliable — fire-and-forget, and returns FALSE: delivery
 * can't be confirmed synchronously, so the caller keeps its in-app fallback as a
 * guarantee (you still get the native banner too when permission is granted).
 * Never throws — a denied permission or locked-down env just means no banner.
 */
export function notifyNative(
  title: string,
  body: string,
  opts?: { silent?: boolean; tag?: string; target?: NotifyTarget | null; actions?: NotifyAction[] },
): boolean {
  const targetToken = encodeNotifyTarget(opts?.target);
  if (shellKind === 'tauri') {
    // Il BERSAGLIO del click viaggia qui dentro, codificato: il guscio lo
    // trasporta e basta (lo mette nell'identificatore della notifica e al click
    // lo ridà a `window.__topicsOpenTask`, che lo decodifica). Il campo si
    // chiama ancora `taskId` di proposito: e' il nome che i gusci GIA'
    // INSTALLATI leggono, e ribattezzarlo spegnerebbe il click su tutti loro.
    // La codifica sta in lib/notify/notifyTarget.ts. null = banner senza
    // destinazione.
    //
    // `actions` sono i TASTI del banner (rispondi alla domanda, approva,
    // rimetti in coda): il guscio ne fa `UNNotificationAction` e al click
    // rimanda indietro l'id, che `window.__topicsNotificationAction` esegue.
    // Solo qui: la web `Notification` API NON sa disegnare tasti — le `actions`
    // esistono solo su `ServiceWorkerRegistration.showNotification`, cioè sul
    // percorso della push (client/public/sw.js), non su `new Notification`.
    void tauriInvoke('notify', {
      title,
      body,
      taskId: targetToken,
      actions: opts?.actions?.length ? opts.actions : null,
    });
    return false;
  }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const n = new Notification(title, { body, silent: opts?.silent, tag: opts?.tag });
    // Click su un banner con un bersaglio → finestra a fuoco e destinazione
    // aperta. Il bersaglio e' il task quando c'e', altrimenti il TOPIC: prima
    // qui passava solo il task, quindi i banner della chat (fine turno,
    // messaggio nuovo, terminale) erano cliccabili senza portare da nessuna
    // parte.
    const target = opts?.target;
    if (target?.id) {
      n.onclick = () => {
        try { window.focus(); } catch { /* focus may be blocked, the deep-link still opens */ }
        openNotifyTarget(target);
        n.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Il permesso web `Notification` visto da qui — SENZA mai chiederlo.
 *
 * `'unsupported'` copre i due casi che al chiamante interessano allo stesso
 * modo: l'API non esiste (contesto non sicuro, WebView spartana), oppure siamo
 * sotto Tauri — dove quel permesso non governa niente, perché la consegna passa
 * dal comando nativo `notify` (vedi `notifyNative`).
 */
export function webNotificationPermission(): NotificationPermission | 'unsupported' {
  if (shellKind === 'tauri') return 'unsupported';
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  } catch {
    return 'unsupported';
  }
}

/** La richiesta in corso (o già risolta): si chiede UNA volta per finestra. */
let webPermissionPrimed: Promise<NotificationPermission | 'unsupported'> | null = null;

/**
 * Chiede il permesso dei banner web — una volta sola, e solo dove serve.
 *
 * Questa è la PORTA UNICA: nessun altro modulo parla con `Notification`. Non è
 * pignoleria, è la forma del bug che ha causato «le tre spuntine da riaggiungere
 * a ogni avvio». La regola vera è una sola — sotto Tauri il permesso web non va
 * MAI chiesto — ma era scritta in un solo punto (`useCompletionNotifier`) e
 * dimenticata negli altri due (`usePanelLifecycle`, `usePushNotifications`).
 * Chiusa qui dentro, una quarta copia non può nascere senza portarsela dietro.
 *
 * Perché sotto Tauri non si chiede: in WKWebView `Notification.permission` NON
 * sopravvive al rilancio dell'app, quindi la richiesta ripartiva a ogni avvio; e
 * `usePanelLifecycle` è montato una volta PER FINESTRA, quindi con i gruppi
 * staccati partivano N prompt insieme. Il permesso, per giunta, non serviva a
 * niente: `notifyNative` instrada su `tauriInvoke('notify')` e la web API non la
 * tocca mai.
 *
 * Non lancia mai: un permesso negato vuol dire soltanto niente banner web.
 */
export function primeWebNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  const current = webNotificationPermission();
  // 'granted' / 'denied' / 'unsupported': la risposta c'è già, e ri-chiedere un
  // 'denied' non riapre nessun prompt — lo fa solo sembrare possibile.
  if (current !== 'default') return Promise.resolve(current);
  if (!webPermissionPrimed) {
    try {
      // La promessa resta in cache anche quando l'utente chiude il prompt senza
      // decidere (esito 'default'): quello è un «non ora», e ri-proporlo dentro
      // la stessa sessione è esattamente il fastidio da cui nasce questa porta.
      webPermissionPrimed = Promise.resolve(Notification.requestPermission())
        .catch(() => webNotificationPermission());
    } catch {
      webPermissionPrimed = Promise.resolve(webNotificationPermission());
    }
  }
  return webPermissionPrimed;
}

/** Azzera la memoria della richiesta. Solo per i test. */
export function __resetWebNotificationPrimeForTests(): void {
  webPermissionPrimed = null;
}

/** Stato REALE della catena dei banner nativi (solo Tauri). */
export interface NativeNotificationStatus {
  platform: 'macos' | 'windows' | 'linux';
  /** Gira da un vero .app: fuori dal bundle non si posta nulla. */
  bundled: boolean;
  /** Il sistema ci autorizza a postare a NOSTRO nome. */
  authorized: boolean;
  /**
   * `pending` = nessuna lettura ancora tornata · `notDetermined` = macOS non ha
   * ancora deciso (nessun prompt andato a buon fine) · `granted` / `denied` =
   * risposta definitiva del sistema.
   *
   * `notDetermined` e `denied` NON sono la stessa cosa e non vanno confusi: il
   * secondo si risolve in Impostazioni di sistema → Notifiche, il primo no —
   * lì l'app non compare nemmeno.
   */
  authState: 'pending' | 'notDetermined' | 'granted' | 'denied' | 'unknown';
  /** Carrier di ripiego risolto (terminal-notifier), o null: null + non
   *  autorizzati = nessun banner nativo, punto. */
  helper: string | null;
  logPath: string | null;
}

/**
 * Interroga la catena delle notifiche native. `null` fuori da Tauri (dove non
 * c'è catena nativa: web e PWA usano l'API `Notification` del browser, il cui
 * stato si legge da `Notification.permission`).
 *
 * Serve perché `notifyNative` è fire-and-forget per contratto — giusto per il
 * chiamante, pessimo per l'utente: su macOS un banner può cadere in tre punti
 * diversi senza che nessuno lo dica, e il pannello Impostazioni continua a
 * promettere notifiche che non arriveranno mai. Sola lettura, non cambia nulla.
 */
export async function notificationStatus(): Promise<NativeNotificationStatus | null> {
  if (shellKind !== 'tauri') return null;
  try {
    return await tauriInvoke<NativeNotificationStatus>('notification_status');
  } catch {
    return null;
  }
}

/**
 * Act on the native notification permission from Settings, and get the fresh
 * state back in the same shape as `notificationStatus`.
 *
 * The shell decides what "act" means from the real state (ask macOS, open
 * System Settings when the answer was a denial, nothing when granted or off
 * macOS): the client only presses the button and redraws. `null` outside
 * Tauri, like `notificationStatus`. If the command itself fails the panel must
 * still tell the truth, so the fallback is a plain re-read, not `null`, which
 * would redraw the browser verdict on a desktop shell.
 */
export async function requestNotificationPermission(): Promise<NativeNotificationStatus | null> {
  if (shellKind !== 'tauri') return null;
  try {
    return await tauriInvoke<NativeNotificationStatus>('request_notification_permission');
  } catch {
    return notificationStatus();
  }
}

/**
 * Ricarica il client. Sul desktop ricarica TUTTE le finestre, non solo questa.
 *
 * Il bundle è uno solo: con più finestre aperte (i gruppi staccati), ricaricarne
 * una sola lascia due versioni dello stesso client a parlarsi sullo stesso
 * pane-store. Chi preme ⌘R non sta chiedendo "ricarica questa scheda", sta
 * chiedendo "riparti". Sul web resta il reload della sola pagina: non c'è
 * nessun'altra finestra che questo codice possa raggiungere.
 */
export async function reloadAllWindows(): Promise<void> {
  if (shellKind === 'tauri') {
    try {
      // ZERO NON È UN SUCCESSO, ed è l'unico modo in cui questo gesto può
      // fallire in silenzio: `app_reload_all` torna QUANTE finestre ha
      // ricaricato, e per un anno quel numero è stato buttato via. Quando il
      // nativo non ne trovava nessuna — succedeva a ogni pane browser aperta,
      // vedi `reload_all_ui_windows` — il `return` qui sotto usciva contento e
      // nemmeno questa finestra ripartiva. Un conteggio che nessuno legge è un
      // errore che nessuno vede.
      const n = await tauriInvoke<number>('app_reload_all');
      if (n > 0) return;
    } catch {
      // Guscio vecchio senza il comando: almeno questa finestra riparte.
    }
  }
  // Sul web (e sul guscio vecchio) il segno lo mettiamo noi: nel ramo Tauri
  // sopra ce l'ha già messo `app_reload_all`, che ricarica finestre che questo
  // documento non può toccare. Vedi `lib/reloadFlash.ts`.
  markReloadFlash();
  window.location.reload();
}

/** Hard-restart the desktop app (bypasses the service worker). No-op on web. */
export async function relaunch(): Promise<void> {
  switch (shellKind) {
    case 'tauri':
      // tauri-plugin-process
      await tauriInvoke('plugin:process|restart');
      return;
    default:
      window.location.reload();
  }
}

/** App version string. Falls back to the build-time version on web. */
export async function getVersion(): Promise<string> {
  switch (shellKind) {
    case 'tauri':
      try {
        return await tauriInvoke<string>('plugin:app|version');
      } catch {
        return buildVersion();
      }
    default:
      return buildVersion();
  }
}

// Version baked at build time by Vite (`define.__APP_VERSION__`, from
// electron-app/package.json). Guarded so it's safe if the define is absent.
declare const __APP_VERSION__: string;
function buildVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
}
