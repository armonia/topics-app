/**
 * Che cosa succede DAVVERO alle notifiche di questo dispositivo, detto in una
 * riga che un umano può usare.
 *
 * Il motivo per cui questo file esiste: «non iscritto», «negato dal sistema» e
 * «su iPhone serve la PWA installata» oggi si vedono tutti e tre allo stesso
 * modo — nessuna notifica. L'utente conclude che le notifiche sono rotte, e in
 * due casi su tre il rimedio è a due tocchi di distanza. Un interruttore che
 * sembra funzionare mentre il permesso è negato è peggio di nessun interruttore:
 * promette una cosa che il sistema operativo ha già deciso di non concedere.
 *
 * Puro di proposito: prende una fotografia dell'ambiente e restituisce testo +
 * un tag. Nessun accesso a `navigator`, `Notification` o al DOM — quelli stanno
 * in `readPushEnvironment()`, che è l'unico pezzo non testabile.
 */

/** Il permesso web visto da qui. `unsupported` = l'API non c'è (contesto non
 *  sicuro, WebView spartana) oppure siamo nel guscio nativo, dove quel permesso
 *  non governa niente. */
export type WebPermission = 'default' | 'denied' | 'granted' | 'unsupported';

export interface PushEnvironment {
  /** `serviceWorker` + `PushManager` esistono in questo contesto. */
  capable: boolean;
  permission: WebPermission;
  /** Esiste una subscription REGISTRATA per questo dispositivo. */
  subscribed: boolean;
  /** Siamo dentro il guscio desktop: il push non c'entra, i banner passano dal
   *  comando nativo. */
  nativeShell: boolean;
  /** iOS/iPadOS in Safari, non in modalità app installata. È il caso in cui
   *  l'API di push semplicemente NON esiste finché non aggiungi alla Home, e
   *  l'unico in cui «non supportato» ha un rimedio. */
  iosNeedsInstall: boolean;
}

export type PushHealth = 'on' | 'off' | 'blocked' | 'unavailable';

export interface PushStatusView {
  /** Il tag su cui la UI decide cosa disegnare (interruttore, riga muta, invito). */
  health: PushHealth;
  /** Perché siamo in questo stato: `denied` e `unsupported` chiedono rimedi
   *  diversi e non vanno confusi in un unico «non funziona». */
  reason: 'subscribed' | 'not-subscribed' | 'denied' | 'ios-needs-install' | 'unsupported' | 'native-shell';
  headline: string;
  /** La riga che dice dove si rimedia. Vuota quando non c'è niente da fare. */
  hint: string;
  /** L'interruttore «iscrivi questo dispositivo» ha senso premerlo adesso? */
  canSubscribe: boolean;
}

export function describePushState(env: PushEnvironment): PushStatusView {
  // L'ordine dei rami è la parte che conta: dal fatto più vincolante al meno.
  // Un iPhone non installato riporta comunque `capable: false`, e senza questo
  // ramo PRIMA finirebbe in «non supportato» — cioè in un vicolo cieco, quando
  // invece basta aggiungere alla schermata Home.
  if (env.nativeShell) {
    return {
      health: 'unavailable',
      reason: 'native-shell',
      headline: "L'app da scrivania usa i banner di sistema, non il push",
      hint: 'Le notifiche a app chiusa riguardano il telefono e il browser.',
      canSubscribe: false,
    };
  }

  if (env.iosNeedsInstall) {
    return {
      health: 'unavailable',
      reason: 'ios-needs-install',
      headline: 'Su iPhone e iPad serve Topics installato',
      hint: 'Condividi → «Aggiungi a Home», poi riapri Topics da lì: prima di quel passaggio iOS non concede il permesso alle notifiche.',
      canSubscribe: false,
    };
  }

  if (!env.capable) {
    return {
      health: 'unavailable',
      reason: 'unsupported',
      headline: 'Questo browser non supporta le notifiche a app chiusa',
      hint: '',
      canSubscribe: false,
    };
  }

  if (env.permission === 'denied') {
    return {
      health: 'blocked',
      reason: 'denied',
      headline: 'Negato dal sistema',
      hint: 'Il permesso lo hai già rifiutato: si riattiva dalle impostazioni del browser (o del telefono) per questo sito, non da qui.',
      canSubscribe: false,
    };
  }

  if (env.permission === 'unsupported') {
    return {
      health: 'unavailable',
      reason: 'unsupported',
      headline: 'Questo browser non supporta le notifiche a app chiusa',
      hint: '',
      canSubscribe: false,
    };
  }

  if (env.subscribed) {
    return {
      health: 'on',
      reason: 'subscribed',
      headline: 'Iscritto: le notifiche arrivano anche ad app chiusa',
      hint: '',
      canSubscribe: false,
    };
  }

  return {
    health: 'off',
    reason: 'not-subscribed',
    headline: 'Non iscritto: ad app chiusa non arriva niente',
    // Il permesso concesso senza subscription è il caso più insidioso: il
    // browser non chiederà più niente, quindi l'utente crede di aver già detto
    // sì e non capisce perché tace.
    hint: env.permission === 'granted'
      ? 'Il permesso c\'è già: manca solo la registrazione di questo dispositivo.'
      : 'Attiva per ricevere qui le notifiche di fine turno e dei task in review.',
    canSubscribe: true,
  };
}
