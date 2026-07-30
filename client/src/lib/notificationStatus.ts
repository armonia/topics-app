/**
 * Cosa DIRE all'utente sullo stato dei banner nativi.
 *
 * Il pannello Impostazioni prometteva "native macOS notification when an agent
 * finishes". Su una build rilasciata è falso: macOS 26 nega l'autorizzazione a
 * qualunque app senza firma della catena Apple (né adhoc né auto-firmata
 * bastano — nessun prompt, e l'app non compare nemmeno in Impostazioni di
 * sistema → Notifiche), quindi Topics non può postare a nome proprio. Resta
 * solo il carrier di ripiego (`terminal-notifier`), che però c'è solo se
 * l'utente ce l'ha. Quando non c'è, la catena cade in silenzio e la promessa
 * resta scritta lì.
 *
 * Questa è la traduzione da stato → frase. Sta qui, fuori dal componente,
 * perché è la parte che va inchiodata: la UI la disegna, il test la verifica.
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

  // Non autorizzati. Se c'è il carrier, i banner arrivano lo stesso — ma a nome
  // suo: vale la pena dirlo, perché spiega il nome che si legge nel banner e
  // perché in Impostazioni di sistema Topics non compare.
  if (status.helper) {
    return {
      health: 'degraded',
      headline: 'I banner arrivano tramite terminal-notifier, non a nome di Topics.',
      hint: 'macOS non autorizza le app non firmate da Apple a postare per conto proprio: per questo Topics non compare in Impostazioni di sistema → Notifiche.',
    };
  }

  // Né autorizzati né carrier: qui non arriva niente, ed è il caso che finora
  // era del tutto invisibile.
  return {
    health: 'broken',
    headline: 'I banner di sistema NON arrivano.',
    hint:
      status.authState === 'denied'
        ? 'Le notifiche di Topics sono negate in Impostazioni di sistema → Notifiche. Il toast in finestra continua a funzionare.'
        : 'macOS non autorizza le app non firmate da Apple, e non c’è nessun ripiego installato. Il toast in finestra continua a funzionare.',
  };
}
