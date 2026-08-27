import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConnectionStatus, WSMessage, UnreadData } from '../types';
import { topicsApi } from '../lib/api';
import { dispatchFrame, dispatchLifecycle } from '../lib/wsFrameBus';
import { CLIENT_PROTOCOL_VERSION, CLIENT_CAPABILITIES, CLIENT_VERSION } from '../schemas/ws-handshake';
import { validateInbound } from '../schemas/ws-inbound';
import { serverWsBase } from '../lib/shell/net';
import { applyUnreadUpdate, clearUnreadFor, hasUnread } from '../state/unread';
import { setWsClientId } from '../state/wsIdentity';
import { SEEN_DWELL_MS } from '../state/signals';
import { isWindowAwake } from '../state/windowAwake';

interface UseWebSocketReturn {
  status: ConnectionStatus;
  unreadData: UnreadData;
  sendWS: (message: WSMessage) => void;
  onMessage: (handler: (msg: WSMessage) => void) => () => void;
  reconnect: () => void;
  lastConnectedAt: number | null;
}

const OFFLINE_THRESHOLD_MS = 10_000;

/**
 * Quanto silenzio dall'altra parte basta a dichiarare morto il filo.
 *
 * Due ping e mezzo: con la cadenza di 30s qui sotto, servono due `pong`
 * mancati di fila prima che scatti, quindi un singhiozzo di rete non chiude
 * niente. Piu' alto di 60s anche per un'altra ragione: un browser che manda la
 * scheda in secondo piano strozza i timer a uno al minuto, e una soglia di 60s
 * netti trasformerebbe ogni scheda in background in una riconnessione continua.
 */
const PONG_TIMEOUT_MS = 75_000;

export function useWebSocket(): UseWebSocketReturn {
  // Start as 'connected' initially — only show connecting states after a grace period
  // This prevents UI flicker on page load when the WS hasn't connected yet
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [displayStatus, setDisplayStatus] = useState<ConnectionStatus>('connected');
  const connectingGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unreadData, setUnreadData] = useState<UnreadData>({});
  // Specchio sincrono di `unreadData`. Serve a `sendWS`, che sul ping di focus
  // deve sapere SUBITO se c'è davvero qualcosa da azzerare prima di azzerarlo
  // ottimisticamente: lo stato React lo leggerebbe un render troppo tardi, e la
  // decisione arriverebbe sempre dopo lo zero, cioè sempre sbagliata.
  const unreadRef = useRef<UnreadData>({});
  /**
   * Unico punto di scrittura dell'unread: aggiorna il ref (verità sincrona) e
   * poi lo stato. Il valore passato a `setUnreadData` è già calcolato, mai una
   * funzione updater: gli updater in StrictMode vengono invocati due volte e
   * scriverci dentro il ref lo corromperebbe.
   *
   * I riduttori in `state/unread` restituiscono `prev` identico quando non
   * cambia niente, e qui quell'identità diventa il gate: nessun `setState`,
   * quindi nessun render dell'albero.
   */
  const applyUnread = useCallback((next: (prev: UnreadData) => UnreadData) => {
    const computed = next(unreadRef.current);
    if (computed === unreadRef.current) return;
    unreadRef.current = computed;
    setUnreadData(computed);
  }, []);
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef<Set<(msg: WSMessage) => void>>(new Set());
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Quando il server ha dato l'ultimo segno di vita. E' l'unico dato che
  // distingue una connessione viva da una MEZZA APERTA: lo legge il cane da
  // guardia dentro l'intervallo di ping, in `onopen`.
  //
  // Nasce a zero e non a `Date.now()`: leggere l'orologio durante il render e'
  // una chiamata impura (react-hooks/purity), e qui non servirebbe a niente —
  // l'unico che lo legge e' un timer che nasce in `onopen`, DOPO che `onopen`
  // ha scritto qui l'istante dell'apertura.
  const lastPongAtRef = useRef(0);
  // Self-reference for reconnection: `connect` schedules a reconnect that must
  // call `connect` again. Referencing the `connect` const directly inside its
  // own body reads it before initialization (react-hooks/immutability) and
  // pins the first closure; routing through a ref always invokes the latest
  // `connect` and removes the use-before-declare.
  const connectRef = useRef<() => void>(() => {});
  // Remember the last focused topic so onopen can re-announce it to the server.
  // A `focus` frame sent while the socket wasn't OPEN is dropped by sendWS below
  // and never retried — the server then keeps counting the focused topic as
  // unread (phantom badge on the topic the user is actively looking at).
  const lastFocusTopicRef = useRef<string | null>(null);
  // L'attesa della soglia di "visto" prima di marcare letto. Un ref e non uno
  // stato: cambiarlo non deve ri-renderizzare nulla, e un focus nuovo deve poter
  // annullare l'attesa del precedente in modo sincrono.
  const seenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // La topic la cui soglia di "visto" e' GIA' scattata mentre e' davanti. Serve a
  // ri-marcare letto i messaggi che arrivano MENTRE stai leggendo: ora che il
  // server incrementa sempre (nessuna soppressione da focus), senza questo un
  // messaggio in arrivo su una chat aperta ti lascerebbe un badge addosso appena
  // cambi tab. Si annulla quando il focus si sposta su un'altra topic.
  const seenTopicRef = useRef<string | null>(null);
  // Nessuna attesa sopravvive allo smontaggio: marcare letto dopo che l'hook e'
  // morto scriverebbe per conto di una finestra che non c'e' piu'.
  useEffect(() => () => {
    if (seenTimerRef.current !== null) clearTimeout(seenTimerRef.current);
  }, []);

  const clearOfflineTimer = useCallback(() => {
    if (offlineTimerRef.current) {
      clearTimeout(offlineTimerRef.current);
      offlineTimerRef.current = null;
    }
  }, []);

  const startOfflineTimer = useCallback(() => {
    clearOfflineTimer();
    offlineTimerRef.current = setTimeout(() => {
      setStatus('offline');
    }, OFFLINE_THRESHOLD_MS);
  }, [clearOfflineTimer]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${serverWsBase()}/ws`);
    wsRef.current = ws;

    /**
     * IL FILO E' CADUTO: tutto cio' che deve succedere, una volta sola.
     *
     * Stava dentro `ws.onclose`, ed e' li' che il difetto viveva. Misurato il
     * 20/08/2026 con la rete staccata per 110 secondi: il cane da guardia
     * scatta a 90s e chiama `ws.close()`, ma senza rete l'handshake di
     * chiusura non si completa, la socket resta in `CLOSING` e **`onclose` non
     * scatta mai**. Conseguenza a catena, tutta osservata:
     *
     *   · `status` non lascia mai `'connected'`, quindi l'indicatore «Offline»
     *     della barra di stato non compare MAI, nemmeno dopo due minuti;
     *   · al ritorno della rete `reconnectNow` apre davvero una socket nuova
     *     (contate: 3 CLOSED + 1 OPEN), ma per React lo stato era gia'
     *     `'connected'`, quindi non c'e' nessuna TRANSIZIONE;
     *   · l'effetto che svuota la coda in uscita
     *     (`usePanelLifecycle.ts:1388`) scatta solo su quella transizione:
     *     il messaggio scritto durante il blackout restava in coda per
     *     sempre, sotto la scritta «Message queued. It will send when
     *     reconnected.» — una promessa che l'app non manteneva.
     *
     * Chiamarla anche dal cane da guardia chiude la catena in un punto solo.
     * La guardia `persa` la rende idempotente: se un `onclose` in ritardo
     * arriva comunque, non raddoppia il backoff ne' i timer.
     *
     * NOTA su `navigator.onLine`, valutato e SCARTATO: sembra il segnale piu'
     * rapido, ma questo server sta quasi sempre su `localhost` o in LAN, e con
     * il wifi spento `onLine` e' false mentre la app funziona benissimo.
     * Dichiarare «Offline» li' sarebbe una bugia. Il `pong` resta l'unica
     * prova che dall'altra parte c'e' qualcuno.
     */
    let persa = false;
    const perdiIlFilo = () => {
      if (persa) return;
      persa = true;
      setStatus('reconnecting');
      dispatchLifecycle('close');
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Start timer to transition to 'offline' if we can't reconnect quickly
      startOfflineTimer();

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
      reconnectAttemptRef.current++;

      reconnectTimerRef.current = setTimeout(() => {
        connectRef.current();
      }, delay);
    };

    ws.onopen = () => {
      setStatus('connected');
      setLastConnectedAt(Date.now());
      reconnectAttemptRef.current = 0;
      clearOfflineTimer();
      // Notify lifecycle subscribers (e.g. pane-store syncWS resets its
      // monotonic seq gate on reconnect — without this the first
      // `ui-state:init` of a post-restart connection is silently dropped).
      dispatchLifecycle('open');

      // v3 foundations WS-02 — send `hello` so the server learns the client's
      // version + capabilities. Backward-compat: server tolerates clients
      // that don't send hello and treats them as legacy.
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          clientVersion: CLIENT_VERSION,
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: Array.from(CLIENT_CAPABILITIES),
        }));
      } catch {
        // Best-effort; if send fails the server proceeds without handshake info.
      }

      // Re-announce the focused topic (see lastFocusTopicRef) so per-client focus
      // survives a reconnect — or an initial focus that raced ahead of OPEN and
      // got dropped by sendWS. Without this the server keeps the focused topic
      // marked unread. Skipped when no topic is focused (ref null after blur).
      if (lastFocusTopicRef.current) {
        try {
          ws.send(JSON.stringify({ type: 'focus', topicId: lastFocusTopicRef.current }));
        } catch {
          // Best-effort; the next focus effect re-sends on the live socket.
        }
      }

      // Start ping interval
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      // Il polso riparte da zero: la connessione precedente non testimonia per
      // questa. Senza questa riga una socket nuova nascerebbe gia' scaduta dopo
      // un'ora di sonno, e si chiuderebbe al primo giro dell'intervallo.
      lastPongAtRef.current = Date.now();
      const pingTimer = setInterval(() => {
        // IL CANE DA GUARDIA, ed e' la ragione per cui il `ping` esiste.
        //
        // Senza qualcuno che ASPETTI la risposta, il ping e' una lettera spedita
        // a un indirizzo vuoto. Su una connessione mezza aperta — server ucciso
        // di netto, Mac che dorme, Tailscale che cade — la socket resta
        // `OPEN` e il `send` non solleva niente: `onclose` non scatta mai, il
        // backoff non parte, e la board continua a mostrare lo stato di prima
        // del guasto finche' qualcuno non ricarica la pagina. Chiudere e' cio'
        // che rimette in moto la strada normale di riconnessione.
        //
        // `pingTimer` e non `pingIntervalRef.current`: si spegne SOLO il timer
        // di questa connessione, mai quello che una riconnessione piu' veloce
        // potrebbe gia' aver messo nel ref.
        if (Date.now() - lastPongAtRef.current > PONG_TIMEOUT_MS) {
          clearInterval(pingTimer);
          try { ws.close(); } catch { /* gia' andata */ }
          // E NON si aspetta `onclose`: senza rete la socket resta in `CLOSING`
          // e quell'evento non arriva. Vedi `perdiIlFilo`.
          perdiIlFilo();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
      pingIntervalRef.current = pingTimer;
    };

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);

        // IL POLSO. Il `pong` e' l'unica prova che dall'altra parte c'e' ancora
        // qualcuno, e si data QUI, prima di ogni altra cosa: un frame di
        // keepalive non deve dipendere dal registro degli schemi per contare
        // come segno di vita, e non ha niente da dire a nessun sottoscrittore.
        // Chi lo legge davvero e' il cane da guardia in `onopen`.
        if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'pong') {
          lastPongAtRef.current = Date.now();
          return;
        }

        // v3 foundations WS-01 client-side validation: registered types
        // are schema-checked, unknown types pass through. On schema
        // failure we DROP the frame (defense in depth) and log in DEV.
        // Server-side already validates emits via devValidateOutbound,
        // so a failure here means protocol drift or a server bug that
        // slipped through.
        // `welcome` non sta nel registro outbound (vive in shared/ws-handshake),
        // quindi non e' nell'union `WSMessage` e va letto sul frame GREZZO, prima
        // del cast. L'id che porta e' quello di QUESTA socket: senza, un client
        // non sa riconoscere i propri echi. Va sostituito a ogni riconnessione —
        // il server ne assegna uno nuovo per socket.
        if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'welcome') {
          setWsClientId((raw as { clientId?: string }).clientId ?? null);
          return;
        }

        // Appaiamento di un dispositivo: si ripubblica come evento di finestra.
        // Il cartello di approvazione deve poter comparire OVUNQUE l'utente stia
        // guardando — chi arriva col telefono in mano e' fermo su una schermata
        // d'attesa, e una conferma sepolta in un pannello lo lascerebbe li'. Un
        // evento di finestra evita di infilare uno stato d'autenticazione nel
        // percorso caldo dei messaggi, che gira migliaia di volte al minuto.
        {
          const t = (raw as { type?: unknown })?.type;
          const NOMI: Record<string, string> = {
            'auth:pair-requested': 'topics:auth-pair-requested',
            'auth:pair-resolved': 'topics:auth-pair-resolved',
            'auth:device-revoked': 'topics:auth-device-revoked',
            // Le concessioni di QUESTO dispositivo sono cambiate. Arriva
            // mirato — non da un broadcast filtrato — perché su una revoca la
            // concessione non esiste più e un filtro per entità scarterebbe
            // proprio questo frame.
            'auth:shares-changed': 'topics:auth-shares-changed',
          };
          if (typeof t === 'string' && NOMI[t]) {
            window.dispatchEvent(new CustomEvent(NOMI[t], { detail: raw }));
            return;
          }
        }

        const validation = validateInbound(raw);
        if (!validation.ok) {
          if (import.meta.env.DEV) {
            console.warn(`[WS:inbound] Dropping malformed ${validation.type ?? 'frame'}: ${validation.error}`);
          }
          return;
        }
        const data = raw as WSMessage;

        // Fan out to the module-level frame bus FIRST — the pane-store
        // bootstrap subscribes here (review I4: keeps a single WS per tab
        // instead of bootstrap.ts opening its own). Before this hook,
        // `unread:init` triggers the setState below; both need to run.
        dispatchFrame(data);

        // L'id che il server ha assegnato a QUESTA socket. Il campo esisteva da
        // sempre nel `welcome` («Echo of the WS client id») e non lo leggeva
        // nessuno: senza, un client non sa riconoscere i propri echi. Va
        // sostituito a ogni riconnessione — il server assegna un id nuovo per
        // socket, e tenere il primo farebbe fallire il confronto in silenzio.
        // Handle unread init
        if (data.type === 'unread:init') {
          applyUnread(() => data.data || {});
          return;
        }

        // Handle unread updates.
        //
        // Bail su valore INVARIATO. `unreadData` risale fino ad App e da lì
        // scende nel provider delle notifiche e nella sidebar: una nuova
        // identità di oggetto ri-renderizza l'albero intero. Un
        // `unread:updated` che riporta il conteggio che avevamo già è però il
        // caso PIÙ frequente — ogni client lo riceve ogni volta che qualcuno,
        // ovunque, apre una tab — e pagarlo con un render globale era il costo
        // più grosso dello switch di tab. Restituire `prev` lo azzera.
        if (data.type === 'unread:updated') {
          applyUnread(prev => applyUnreadUpdate(prev, data.topicId, data.unreadCount));
          // Ri-marca letto un messaggio arrivato MENTRE stai gia' leggendo questa
          // topic (soglia gia' scattata + finestra sveglia). Il server ora
          // incrementa sempre; senza questo, un messaggio su una chat aperta ti
          // lascerebbe un badge appena cambi tab. Se la finestra e' dietro/nascosta
          // (`!isWindowAwake`) NON ri-marchiamo: il badge deve restare — e' il caso
          // "app in background" che questo intero fix serve a far funzionare.
          if (data.unreadCount > 0 && data.topicId === seenTopicRef.current && isWindowAwake()) {
            const tid = data.topicId;
            applyUnread(prev => clearUnreadFor(prev, tid));
            topicsApi.markRead(tid).catch(() => {});
          }
        }

        // Forward to all handlers
        for (const handler of handlersRef.current) {
          try { handler(data); } catch {}
        }
      } catch {}
    };

    ws.onclose = perdiIlFilo;

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, [clearOfflineTimer, startOfflineTimer, applyUnread]);

  useEffect(() => {
    // Keep the self-reference current so scheduled reconnects invoke the
    // latest `connect` closure (deps below re-run this when `connect` changes).
    connectRef.current = connect;
    connect();

    // Mobile PWAs (and laptops on sleep / Tailscale drops) SUSPEND the socket and
    // its backoff timer when backgrounded, so on return the scheduled reconnect can
    // be up to 30s away — the app shows STALE state (tabs/topics not synced) until
    // then. When the page becomes visible again, comes back online, or regains
    // focus, reconnect IMMEDIATELY (skip the accumulated backoff) if the socket
    // isn't already live — the fresh connection's `ui-state:init` re-hydrates the
    // pane store, so mobile re-syncs with the system the instant it foregrounds.
    const reconnectNow = () => {
      if (typeof document !== 'undefined' && document.hidden) return; // only when foreground
      const ws = wsRef.current;
      const state = ws ? ws.readyState : WebSocket.CLOSED;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return; // already live/connecting
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      reconnectAttemptRef.current = 0; // fresh — no inherited backoff delay
      connectRef.current();
    };
    const onVisible = () => { if (!document.hidden) reconnectNow(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', reconnectNow);
    window.addEventListener('focus', reconnectNow);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('focus', reconnectNow);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      clearOfflineTimer();
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        // CONNECTING sockets: handlers are nullified so they'll silently die
        // without triggering reconnect or the "closed before established" warning
      }
    };
  }, [connect, clearOfflineTimer]);

  const sendWS = useCallback((message: WSMessage) => {
    // Il ping di focus è l'UNICO segnale che l'utente sta guardando una topic,
    // quindi è qui che vive tutta la logica di "letto": azzeramento locale
    // ottimistico + la POST che lo rende persistente. Prima ogni punto che
    // mandava il focus chiamava anche `topicsApi.markRead` per conto suo — e
    // siccome una ChatPane vive dentro una ChatPanel, un solo cambio di tab
    // faceva partire la stessa POST due volte.
    //
    // Azzerare localmente nello STESSO tick, invece di aspettare il round-trip
    // di `unread:updated{0}`: quella latenza era la finestra in cui la
    // soppressione della tab attiva e il conteggio vero non erano d'accordo, e
    // il badge spariva per poi ricomparire mentre il focus si spostava fra tab
    // e gruppi. Il successivo `unread:updated` riconcilia con la verità, quindi
    // lo zero ottimistico è sicuro (si auto-corregge se nel frattempo arriva un
    // messaggio).
    // AGGIUNTA (FASE 2): "letto" ora aspetta la SOGLIA, non l'istante del focus.
    // Il frame `focus` parte subito — al server serve per il routing — ma
    // l'azzeramento scatta solo se quella topic e' ancora davanti dopo
    // SEEN_DWELL_MS, e con la finestra sveglia. E' la stessa soglia che tiene il
    // fill blu sulla tab (`useSeenDwell` in state/signals.ts): due politiche di
    // "visto" in disaccordo darebbero un badge che sfarfalla, quindi e' UNA.
    const m = message as unknown as { type?: string; topicId?: string | null };
    if (m.type === 'focus') {
      // Un focus su una topic DIVERSA azzera lo stato di "gia' vista": la nuova
      // deve riguadagnarsi la soglia da capo.
      if ((m.topicId ?? null) !== lastFocusTopicRef.current) seenTopicRef.current = null;
      // Track the focused topic so onopen can re-announce it after a reconnect.
      lastFocusTopicRef.current = m.topicId ?? null;
      // Un focus nuovo annulla l'attesa del precedente: un clic di passaggio non
      // deve marcare letto niente.
      if (seenTimerRef.current !== null) {
        clearTimeout(seenTimerRef.current);
        seenTimerRef.current = null;
      }
      if (m.topicId) {
        const tid = m.topicId;
        seenTimerRef.current = setTimeout(() => {
          seenTimerRef.current = null;
          // Guardie al momento dello scatto: la topic deve essere ANCORA quella
          // davanti (il focus può essersi spostato senza un nuovo frame) e la
          // finestra sveglia (può essere finita dietro durante l'attesa).
          if (lastFocusTopicRef.current !== tid) return;
          if (!isWindowAwake()) return;
          // Soglia raggiunta: da ora i messaggi che arrivano su questa topic vanno
          // ri-marcati letti al volo (vedi onmessage `unread:updated`), non lasciati
          // come badge.
          seenTopicRef.current = tid;
          // Letto PRIMA dello zero ottimistico: dopo, il conteggio sarebbe
          // sempre 0 e la POST non partirebbe mai.
          const toReset = hasUnread(unreadRef.current, tid);
          applyUnread(prev => clearUnreadFor(prev, tid));
          // Niente da azzerare ⇒ niente round-trip. Era il costo per-switch più
          // caro: la POST fa riscrivere al server l'intera tabella unread e poi
          // trasmette a TUTTI i client un `unread:updated{0}` che non cambia nulla.
          if (toReset) topicsApi.markRead(tid).catch(() => {});
        }, SEEN_DWELL_MS);
      }
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, [applyUnread]);

  const onMessage = useCallback((handler: (msg: WSMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const reconnect = useCallback(() => {
    // Clear any pending reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    clearOfflineTimer();
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    connect();
  }, [connect, clearOfflineTimer]);

  // Auto-reconnect when app comes back to foreground (mobile/tab switch)
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnect();
      }
    };
    const handleOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [reconnect]);

  // Only surface non-connected status after a grace period (avoids flash on load)
  useEffect(() => {
    if (status === 'connected') {
      if (connectingGraceRef.current) { clearTimeout(connectingGraceRef.current); connectingGraceRef.current = null; }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- debounce sync: mirrors the WS `status` into the flicker-suppressed `displayStatus`; the 'connected' branch surfaces immediately, the else branch defers via timer. setDisplayStatus never feeds back into `status`, so this converges and cannot loop
      setDisplayStatus('connected');
    } else {
      if (!connectingGraceRef.current) {
        connectingGraceRef.current = setTimeout(() => {
          setDisplayStatus(status);
          connectingGraceRef.current = null;
        }, 3000);
      }
    }
    return () => { if (connectingGraceRef.current) { clearTimeout(connectingGraceRef.current); connectingGraceRef.current = null; } };
  }, [status]);

  return { status: displayStatus, unreadData, sendWS, onMessage, reconnect, lastConnectedAt };
}
