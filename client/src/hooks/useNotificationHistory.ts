import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';
import type { NotificationRow } from '../../../shared/notification-log';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import {
  fetchNotificationHistory,
  markNotificationsSeen,
  mergeNotificationRow,
} from '../lib/notify/history';
import { openDeepLinkInApp } from '../lib/openTaskLink';

export interface NotificationHistoryState {
  rows: NotificationRow[];
  unseen: number;
  loading: boolean;
  /** Rileggi l'elenco dal server (apertura della cronologia, rimonta). */
  refresh: () => void;
  /** Le ho guardate tutte: azzera il contatore, qui e sulle altre finestre. */
  markAllSeen: () => void;
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
  // Una lettura alla volta: due aperture rapide non devono poter consegnare
  // due elenchi in ordine invertito.
  const inFlight = useRef(false);
  // Vista a ref dell'elenco: serve a `markAllSeen`, che deve leggere l'ultima
  // riga SENZA passare dall'updater di `setRows` (vedi lì). `useRefMirror` è il
  // ponte stato→ref canonico di questo progetto.
  const rowsRef = useRefMirror(rows);

  // La lettura vera. Non tocca lo stato in modo SINCRONO: tutto succede dentro
  // le callback della promessa, così l'effetto di montaggio qui sotto può
  // chiamarla senza innescare la cascata di render che `set-state-in-effect`
  // (giustamente) vieta.
  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void fetchNotificationHistory()
      .then((page) => {
        setRows(page.rows);
        setUnseen(page.unseen);
      })
      .catch(() => {
        /* server irraggiungibile: si tiene quello che c'è, il tastino non mente
           mostrando zero */
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => { load(); }, [load]);

  useWSSubscription(onWSMessage, 'notification:new', (msg) => {
    if (!msg.row) return;
    setRows((prev) => mergeNotificationRow(prev, msg.row));
    setUnseen(msg.unseen ?? 0);
  });

  useWSSubscription(onWSMessage, 'notification:seen', (msg) => {
    setUnseen(msg.unseen ?? 0);
    // Le righe in pagina si spengono insieme al contatore: un pallino che resta
    // acceso su una riga mentre il totale dice zero è una contraddizione a
    // schermo.
    const at = new Date().toISOString();
    setRows((prev) => prev.map((r) => (r.seenAt ? r : { ...r, seenAt: at })));
  });

  const markAllSeen = useCallback(() => {
    // `upTo` = la riga più recente che ho in mano, non `now`: segno viste le
    // cose che ho davvero avuto sotto gli occhi. Una notifica arrivata mentre
    // guardavo la lista resta non vista, ed è giusto così.
    //
    // Letta da un REF e non dentro l'updater di `setRows`: un effetto di rete
    // dentro un updater parte due volte in StrictMode (e a ogni ri-render
    // concorrente), cioè due POST per un gesto solo.
    const upTo = rowsRef.current[0]?.createdAt;
    if (!upTo) return;
    void markNotificationsSeen({ upTo })
      .then((n) => setUnseen(n))
      .catch(() => {});
    const at = new Date().toISOString();
    setRows((prev) => prev.map((r) => (r.seenAt || r.createdAt > upTo ? r : { ...r, seenAt: at })));
  }, [rowsRef]);

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

  return { rows, unseen, loading, refresh, markAllSeen, openRow };
}
