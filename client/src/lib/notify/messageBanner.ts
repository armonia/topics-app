// La decisione del banner di `message:new`, pura e in un posto solo — gemella di
// `decideTerminalBanner` in terminalNotify.ts, per lo stesso motivo.
//
// Questi gate vivevano dentro il cluster WS di `usePanelLifecycle`, che chiamava
// `notifyNative` per conto suo. Non era solo un secondo sito di chiamata: era un
// percorso FUORI dall'unica porta delle notifiche, e quindi fuori da tutto ciò
// che quella porta garantisce — il mute per topic/progetto, l'interruttore
// generale, il gate Focus/Non disturbare. Tre promesse dell'interfaccia che quel
// banner non manteneva.
//
// E due dei gate che invece aveva erano IMPLICITI: stavano nel `return` di un
// `if` precedente dello stesso handler (`isOwnStream`, corpo vuoto), non in una
// condizione del banner. Chiunque avesse spostato il blocco di dieci righe
// avrebbe cambiato il comportamento senza toccare una riga di logica. Scritti
// qui dentro, e testati, non possono più sparire per riordino.

/** Tutto ciò che serve a decidere. Nessun ref, nessun DOM, nessun orologio: il
 *  chiamante li legge e li passa, così il test può falsificarli tutti. */
export interface MessageBannerInput {
  topicId: string;
  /** Il ruolo del messaggio arrivato. Solo l'assistente bannerizza: il proprio
   *  messaggio appena inviato non è una notizia. */
  role: 'user' | 'assistant';
  /** `document.visibilityState` di QUESTA finestra. L'unico gate per-finestra:
   *  a finestra nascosta l'utente non sta guardando nessuna tab, quindi non
   *  conta quale fosse l'ultima a fuoco (stessa dottrina di
   *  `isTabActivelyVisible`). */
  visibilityState: string;
  /** L'interruttore generale — Impostazioni → Notifiche. */
  notificationsEnabled: boolean;
  /** Questa finestra sta streammando quella sessione: ha già il messaggio in
   *  pagina. */
  isOwnStream: boolean;
  /** Corpo del banner (`preview` o `content`). Vuoto = niente da mostrare. */
  body: string;
  /** Nome del topic, o null/undefined se il topic è sconosciuto a questa
   *  finestra: senza titolo non c'è banner da comporre. */
  topicName: string | null | undefined;
  /** Mute per topic o per progetto (muteGate.ts). */
  muted: boolean;
  /** Un agente di board sta lavorando QUESTO topic adesso. */
  agentWorking: boolean;
  /** Quando questo topic ha bannerizzato l'ultima volta su questo percorso, o
   *  undefined se mai. */
  lastFiredAt: number | undefined;
  now: number;
}

export interface MessageBannerDecision {
  title: string;
  body: string;
  /** `tag` del banner web: due messaggi dello stesso topic si sostituiscono
   *  invece di impilarsi. Sotto Tauri non esiste — lì il compito lo fa la
   *  cooldown qui sotto. */
  tag: string;
  /** La chiave da segnare nella cooldown quando il banner parte davvero.
   *  Deliberatamente NON `topicId` nudo: quella è la chiave del percorso fasi, e
   *  una finestra comune fra i due mangerebbe il banner di review — il guasto
   *  documentato in dispatchedTopic.ts. */
  cooldownKey: string;
}

/** Quanto un topic resta zitto su questo percorso dopo aver bannerizzato. Non
 *  serve a deduplicare (a quello pensa la claim per messageId): serve a non
 *  trasformare una raffica di messaggi in una raffica di banner. */
export const MESSAGE_BANNER_COOLDOWN_MS = 10_000;

/**
 * `null` = questa finestra non bannerizza. Un oggetto = c'è un banner da
 * consegnare, SE la claim cross-finestra la assegna a noi (vedi
 * messageBannerClaim.ts) e se il gate Focus/Non disturbare dentro `fire` lo
 * lascia passare.
 */
export function decideMessageBanner(i: MessageBannerInput): MessageBannerDecision | null {
  if (i.role !== 'assistant') return null;
  if (i.visibilityState !== 'hidden') return null;
  if (!i.notificationsEnabled) return null;
  if (i.isOwnStream) return null;
  if (!i.body) return null;
  if (!i.topicName) return null;
  if (i.muted) return null;
  // Mentre un agente di board lavora il topic, i suoi messaggi non sono un
  // evento per l'umano: la consegna la annuncia `task:review-ready`, che è più
  // informativo. Senza questo, una consegna sola produceva banner quasi identici
  // (il nome del topic È il testo del task).
  if (i.agentWorking) return null;
  if (i.lastFiredAt !== undefined && i.now - i.lastFiredAt < MESSAGE_BANNER_COOLDOWN_MS) return null;
  return {
    title: i.topicName,
    body: i.body,
    tag: `topic-${i.topicId}`,
    cooldownKey: `msg:${i.topicId}`,
  };
}
