import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';
import type { NotificationRow } from '../../../shared/notification-log';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import {
  fetchNotificationHistory,
  markNotificationsSeen,
  mergeNotificationPage,
  mergeNotificationRow,
  type NotificationHistoryPage,
} from '../lib/notify/history';
import { NOTIFICATION_MAX_ROWS, NOTIFICATION_PAGE_SIZE } from '../../../shared/notification-log';
import { openDeepLinkInApp } from '../lib/deepLinkEntry';

export interface NotificationHistoryState {
  rows: NotificationRow[];
  unseen: number;
  loading: boolean;
  /** There may be OLDER rows than the ones in hand: the registry keeps up to
   *  `NOTIFICATION_MAX_ROWS` and a page is `NOTIFICATION_PAGE_SIZE` long. */
  hasMore: boolean;
  /** An older page is on its way. */
  loadingMore: boolean;
  /** Ask for the page BEFORE the oldest row in hand. Idempotent while in
   *  flight, a no-op when there is nothing older. */
  loadMore: () => void;
  /**
   * APRIRE la cronologia: rileggere l'elenco e segnare viste le righe che si
   * stanno guardando. È UNA azione sola, e va chiesta così — vedi il commento
   * sull'implementazione: erano due, partivano insieme, e sbagliavano.
   */
  openAndMarkSeen: () => void;
  /** Click su una riga: segna vista (col suo gruppo) e porta alla cosa.
   *  Torna false se non c'era niente da aprire. */
  openRow: (row: NotificationRow) => boolean;
}

/**
 * Lo stato della CRONOLOGIA delle notifiche per questa finestra.
 *
 * Tre sorgenti, in ordine di autorità: il fronte `notification:new` (dal vivo),
 * il fronte `notification:seen` (il contatore che qualcun altro ha azzerato) e
 * la lettura HTTP (al montaggio e a ogni apertura). L'elenco NON si tiene in
 * locale fra un avvio e l'altro: il registro è sul server apposta, così il
 * numero è lo stesso su ogni finestra e sul telefono.
 *
 * Sul RIAVVIO non ricompare niente come nuovo: le righe già viste tornano
 * `seenAt` valorizzato e il contatore parte dal conteggio REALE delle non viste
 * — è il registro stesso a dire cosa è già stato mostrato. È la difesa contro
 * la trappola pagata in passato, quando al boot l'app rigiocava le notifiche
 * vecchie come se fossero appena arrivate.
 */
export function useNotificationHistory(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): NotificationHistoryState {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unseen, setUnseen] = useState(0);
  // Parte a `true`: al montaggio la lettura è già in volo, e mostrare «Nessuna
  // notifica» per un istante prima dell'elenco è una bugia breve ma è una bugia
  // — proprio sulla schermata che deve dire la verità sul registro vuoto.
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // La lettura IN VOLO, se c'è. Una alla volta — due aperture rapide non devono
  // poter consegnare due elenchi in ordine invertito — ma in CODA, non scartate:
  // è una promessa su cui chi chiede può aspettare.
  const inFlight = useRef<Promise<NotificationHistoryPage | null> | null>(null);
  // Vista a ref dell'elenco: serve a `openAndMarkSeen`, che deve leggere
  // l'ultima riga SENZA passare dall'updater di `setRows` (vedi lì).
  // `useRefMirror` è il ponte stato→ref canonico di questo progetto.
  const rowsRef = useRefMirror(rows);
  // L'ISTANTE fino al quale il server ci ha confermato il «visto». È il
  // filo-guardia contro i fronti in ritardo: `notification:new` porta `unseen`
  // come ISTANTANEA presa al momento del broadcast, e una rete lenta la può
  // consegnare dopo che quella riga è già stata guardata. Senza confronto vince
  // l'ultimo arrivato invece del più recente, e il contatore si riaccende su una
  // riga che il server considera vista — acceso per sempre, perché nessuno lo
  // richiama finché il pannello non si richiude.
  const seenUpTo = useRef('');
  // Quante VERITÀ DAL VIVO sono passate. La alzano i due fronti, e serve a una
  // cosa sola: una lettura HTTP porta un'istantanea presa quando è PARTITA, e se
  // mentre era in volo è arrivato un fronte quell'istantanea è vecchia —
  // applicarla al ritorno riscriverebbe col passato ciò che il presente ha già
  // detto. Misurato sul montaggio: la GET parte a registro vuoto, la notifica
  // arriva subito dopo e il fronte porta `unseen: 1`; la GET torna con lo zero
  // che aveva letto e il badge, già acceso, si rispegne. Da lì non si riaccende
  // più, perché nessun'altra lettura è prevista.
  const liveTick = useRef(0);

  // La lettura vera. Non tocca lo stato in modo SINCRONO: tutto succede dentro
  // le callback della promessa, così l'effetto di montaggio qui sotto può
  // chiamarla senza innescare la cascata di render che `set-state-in-effect`
  // (giustamente) vieta.
  const load = useCallback((): Promise<NotificationHistoryPage | null> => {
    // Si mette in CODA dietro alla lettura in volo, non viene scartata.
    //
    // Prima chi chiamava mentre una lettura era in corso veniva respinto a mani
    // vuote (`if (inFlight.current) return;`), e a mani vuote restava anche chi
    // dall'elenco doveva ricavare qualcosa. Incatenandole l'ordine è garantito
    // lo stesso — sono seriali — ma la risposta che ognuno riceve riflette il
    // momento in cui l'ha chiesta, e non uno precedente.
    const next: Promise<NotificationHistoryPage | null> = (inFlight.current ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => {
        // Da QUI in poi si conta: se il numero cambia prima che la risposta
        // torni, è passata di mezzo una verità più fresca.
        const startedAt = liveTick.current;
        // The limit is asked for, not inherited: the panel decides how long a
        // page is, and `hasMore` below is read off that same number.
        return fetchNotificationHistory({ limit: NOTIFICATION_PAGE_SIZE }).then((page) => ({ page, startedAt }));
      })
      .then(({ page, startedAt }) => {
        // La pagina si RESTITUISCE comunque (chi ha chiesto la lettura ha
        // diritto alla sua risposta), ma non si SCRIVE sopra a un fronte.
        if (liveTick.current === startedAt) {
          // MERGE, not replace: the newest page must not throw away the older
          // pages the reader asked for, nor the live rows arrived since.
          setRows((prev) => mergeNotificationPage(prev, page.rows));
          setUnseen(page.unseen);
        }
        // A full page back means the registry has more than a page. Read off
        // the page LENGTH and not off a total, because the route returns rows.
        setHasMore(page.rows.length >= NOTIFICATION_PAGE_SIZE);
        return page;
      })
      .catch(() => {
        /* server irraggiungibile: si tiene quello che c'è, il tastino non mente
           mostrando zero */
        return null;
      })
      .finally(() => {
        if (inFlight.current === next) inFlight.current = null;
        setLoading(false);
      });
    inFlight.current = next;
    return next;
  }, []);

  useEffect(() => { void load(); }, [load]);

  useWSSubscription(onWSMessage, 'notification:new', (msg) => {
    const row = msg.row;
    if (!row) return;
    liveTick.current += 1;
    // Già COPERTA dal «visto» che il server ci ha confermato? Allora questo
    // fronte è in ritardo: la riga si mostra (spenta, com'è davvero), ma il suo
    // `unseen` è un numero vecchio e non deve toccare il contatore.
    const covered = !!seenUpTo.current && row.createdAt <= seenUpTo.current;
    setRows((prev) => mergeNotificationRow(prev, covered ? { ...row, seenAt: row.seenAt ?? seenUpTo.current } : row, NOTIFICATION_MAX_ROWS));
    if (!covered) setUnseen(msg.unseen ?? 0);
  });

  useWSSubscription(onWSMessage, 'notification:seen', (msg) => {
    liveTick.current += 1;
    setUnseen(msg.unseen ?? 0);
    // Le righe in pagina si spengono insieme al contatore: un pallino che resta
    // acceso su una riga mentre il totale dice zero è una contraddizione a
    // schermo.
    const at = new Date().toISOString();
    setRows((prev) => prev.map((r) => (r.seenAt ? r : { ...r, seenAt: at })));
  });

  const openAndMarkSeen = useCallback(() => {
    // PRIMA si legge, POI si segna visto. In quest'ordine, e aspettando.
    //
    // Il click sul tastino ne lanciava due insieme: una rilettura e un «visto».
    // Sbagliavano in due modi indipendenti, e i due sbagli si vedevano in faccia
    // uguali: il contatore restava acceso PER SEMPRE, perché niente lo richiama
    // finché il pannello non si richiude e si riapre.
    //
    //  1. l'istante da segnare veniva dal ref dell'elenco IN MANO. Se la
    //     cronologia non era ancora arrivata quel ref è vuoto, `if (!upTo)
    //     return` usciva e non partiva nessuna POST: misurato trattenendo di 2,5s
    //     il fronte `notification:new` — il pannello si apriva sulla riga giusta
    //     e il badge restava a 1 con il server che continuava a dire `unseen: 1`.
    //     Con l'elenco vecchio invece della lista vuota è lo stesso difetto in
    //     forma peggiore: si segna visto un istante ANTERIORE alla riga appena
    //     arrivata, e quella riga non viene mai coperta.
    //  2. la GET della rilettura e la POST del «visto» leggono ENTRAMBE `unseen`
    //     e vinceva quella che tornava per ultima: una GET partita prima e
    //     arrivata dopo rimetteva a 1 un contatore già azzerato.
    //
    // Aspettare la lettura chiude tutti e due: l'elenco non può essere più
    // vecchio della domanda, e la POST è per costruzione l'ultima a scrivere il
    // contatore.
    setLoading(true);
    void load()
      .then((page) => {
        // `upTo` = la riga più recente che ho davvero davanti, non `now`: segno
        // viste le cose che ho avuto sotto gli occhi. Una notifica arrivata DOPO
        // questa lettura resta non vista, ed è giusto così.
        const upTo = (page?.rows ?? rowsRef.current)[0]?.createdAt;
        if (!upTo) return;
        return markNotificationsSeen({ upTo }).then((n) => {
          // Alzato solo a CONFERMA avvenuta: è ciò che il server dice di aver
          // segnato, non ciò che gli abbiamo chiesto.
          if (upTo > seenUpTo.current) seenUpTo.current = upTo;
          setUnseen(n);
          const at = new Date().toISOString();
          setRows((prev) => prev.map((r) => (r.seenAt || r.createdAt > upTo ? r : { ...r, seenAt: at })));
        });
      })
      .catch(() => {});
  }, [load, rowsRef]);

  /**
   * The page BEFORE the oldest row in hand.
   *
   * `before` has existed on both sides since the registry was born and nobody
   * passed it: the panel drew fifty rows out of a log of five hundred and said
   * nothing about the other four hundred and fifty.
   */
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    const oldest = rowsRef.current[rowsRef.current.length - 1]?.createdAt;
    if (!oldest) return;
    setLoadingMore(true);
    void fetchNotificationHistory({ limit: NOTIFICATION_PAGE_SIZE, before: oldest })
      .then((page) => {
        setRows((prev) => mergeNotificationPage(prev, page.rows));
        setHasMore(page.rows.length >= NOTIFICATION_PAGE_SIZE);
      })
      .catch(() => {
        /* unreachable server: keep what is on screen, and keep the control
           offered - the next click is the retry */
      })
      .finally(() => setLoadingMore(false));
  }, [hasMore, loadingMore, rowsRef]);

  const openRow = useCallback((row: NotificationRow): boolean => {
    void markNotificationsSeen({ ids: [row.id] })
      .then((n) => setUnseen(n))
      .catch(() => {});
    setRows((prev) => {
      const at = new Date().toISOString();
      // Vista LEI e vista tutta la sua compagnia: il server fa la stessa
      // cascata sul `group_key`, e le due viste devono dire la stessa cosa.
      return prev.map((r) =>
        r.seenAt || (r.id !== row.id && !(row.groupKey && r.groupKey === row.groupKey))
          ? r
          : { ...r, seenAt: at },
      );
    });
    return row.targetUrl ? openDeepLinkInApp(row.targetUrl) : false;
  }, []);

  return { rows, unseen, loading, hasMore, loadingMore, loadMore, openAndMarkSeen, openRow };
}
