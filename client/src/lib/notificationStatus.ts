/**
 * Cosa DIRE all'utente sullo stato dei banner nativi.
 *
 * Il pannello Impostazioni prometteva "native macOS notification when an agent
 * finishes", e su una build non firmata da Apple quella promessa poteva essere
 * falsa senza che nulla lo dicesse: la catena cade in silenzio in tre punti
 * (fuori dal bundle / non autorizzati / nessun carrier di ripiego). Da fuori è
 * indistinguibile da «non c'era niente da notificare».
 *
 * Questa è la traduzione da stato → frase. Sta qui, fuori dal componente,
 * perché è la parte che va inchiodata: la UI la disegna, il test la verifica.
 *
 * ── La regola che tiene insieme i rami ──────────────────────────────────────
 * `health` risponde a UNA domanda sola: **i banner arrivano, sì o no?** Non a
 * «siamo autorizzati», non a «è tutto come vorremmo». Quando arrivano tramite
 * `terminal-notifier` arrivano davvero — il canale funziona — e marcarlo
 * `degraded` metteva un'icona ambra permanente su una cosa che va: l'utente
 * leggeva come errore una nota su un canale sano. Il perché (il nome sul
 * banner, l'assenza dalle Impostazioni di sistema) è informazione utile, e sta
 * in `hint`: nel testo, non nel tono.
 */
import type { NativeNotificationStatus } from './shell/app';

export type NotificationHealth = 'ok' | 'degraded' | 'broken' | 'unknown';

export interface NotificationVerdict {
  health: NotificationHealth;
  /** Una riga, al presente: cosa succede DAVVERO adesso. */
  headline: string;
  /** Cosa può farci l'utente, o null se non c'è niente da fare. */
  hint: string | null;
}

export function describeNativeNotifications(
  status: NativeNotificationStatus | null,
): NotificationVerdict {
  // Fuori da Tauri: web/PWA usano l'API `Notification` del browser, che ha il
  // suo permesso e il suo prompt. Non è questa catena.
  if (!status) {
    return {
      health: 'unknown',
      headline: 'I banner di sistema passano dal browser.',
      hint: 'Il permesso si concede dalla barra degli indirizzi, non da qui.',
    };
  }

  if (status.platform !== 'macos') {
    return {
      health: 'unknown',
      headline: 'I banner passano dal sistema operativo.',
      hint: null,
    };
  }

  if (!status.bundled) {
    return {
      health: 'broken',
      headline: 'Nessun banner di sistema: l’app non gira da un bundle .app.',
      hint: 'Succede solo in sviluppo. La build installata non ha questo problema.',
    };
  }

  if (status.authorized) {
    return {
      health: 'ok',
      headline: 'I banner di sistema arrivano.',
      hint: null,
    };
  }

  // Non autorizzati a postare a nostro nome, ma col carrier i banner ARRIVANO:
  // questo è `ok`. Il dettaglio che cambia — il nome che si legge sul banner, e
  // il fatto che Topics non compaia in Impostazioni di sistema — è la risposta
  // alla domanda che uno si fa guardandolo, non un allarme.
  if (status.helper) {
    return {
      health: 'ok',
      headline: 'I banner di sistema arrivano.',
      hint: 'Li consegna terminal-notifier, non Topics: per questo il nome sul banner è diverso e Topics non compare in Impostazioni di sistema → Notifiche.',
    };
  }

  // Né autorizzati né carrier: qui non arriva niente, ed è il caso che finora
  // era del tutto invisibile.
  //
  // Il consiglio si sdoppia sullo stato, perché mandare l'utente in un pannello
  // dove l'app non è elencata è peggio che non dirgli niente. «Negato» è l'unico
  // caso in cui in Impostazioni di sistema c'è davvero una voce da riaccendere:
  // arriva SOLO da `UNAuthorizationStatus::Denied`. Con la richiesta di
  // autorizzazione che fallisce lo stato resta «non ancora deciso», e lì Topics
  // in quel pannello non c'è proprio.
  return {
    health: 'broken',
    headline: 'I banner di sistema NON arrivano.',
    hint:
      status.authState === 'denied'
        ? 'Le notifiche di Topics sono negate in Impostazioni di sistema → Notifiche. Il toast in finestra continua a funzionare.'
        : 'macOS non ci ha ancora autorizzati a postare a nome di Topics, e non c’è nessun ripiego installato. Il toast in finestra continua a funzionare.',
  };
}

/** What the one button under the verdict does, if it is drawn at all. */
export interface NotificationPermissionAction {
  kind: 'request' | 'open-settings' | 'none';
  /** i18n key of the button label. Empty when `kind` is `none`. */
  labelKey: string;
}

/**
 * The DECISION behind the permission button, as a pure function.
 *
 * The verdict above says what happens; this says what pressing the button
 * does, and it has to agree with the shell's `request_permission`:
 * - `request` while macOS has not decided (`pending` or `notDetermined`):
 *   the system prompt can still be shown, so we ask;
 * - `open-settings` on `denied`: macOS shows the prompt once per install,
 *   the only way back is System Settings > Notifications;
 * - `none` when granted, outside a .app bundle (nothing can be asked from
 *   there, and the verdict already says so), off macOS, or outside Tauri
 *   (the browser owns that permission and its prompt).
 */
export function notificationPermissionAction(
  status: NativeNotificationStatus | null,
): NotificationPermissionAction {
  if (!status || status.platform !== 'macos' || !status.bundled) {
    return { kind: 'none', labelKey: '' };
  }
  switch (status.authState) {
    case 'denied':
      return { kind: 'open-settings', labelKey: 'notif.perm.openSettings' };
    case 'pending':
    case 'notDetermined':
      return { kind: 'request', labelKey: 'notif.perm.request' };
    default:
      return { kind: 'none', labelKey: '' };
  }
}
