import { useCallback, useEffect, useRef } from 'react';
// "Un turno che non ha prodotto niente non lascia niente" — la STESSA regola che
// applica il server prima di cancellare la riga. Due definizioni di "vuoto"
// vorrebbero dire bolla via da una parte e ancora lì dall'altra.
import {
// Importata con l'alias storico: e' una funzione di MODULO, quindi stabile per
// definizione — ed e' anche il motivo per cui non compare in nessuna lista di
// dipendenze, mentre il vecchio `setMessages` di `useState` ci compariva.
updateMessages as setMessages
} from '../state/messageStore';
import { getExpiredQueue, getOutboundQueue, messagesRef, queueStorage, type SendMessageOptions } from './chatShared';
import {
EXPIRED_QUEUE_KEY,
OUTBOUND_QUEUE_KEY,
decideQueuedMessage,
enqueue,
moveToExpired,
queueItemKey,
removeItem as removeQueueItem,
removeSession as removeQueueSession,
writeQueue,
type QueuedMessage
} from './outboundQueue';

export interface QueueRetryCtx {
  drainingRef: React.RefObject<boolean>;
  isSendLocked: (sk: string) => boolean;
  setExpiredMessages: (value: React.SetStateAction<QueuedMessage[]>) => void;
  setPendingQueue: (value: React.SetStateAction<QueuedMessage[]>) => void;
  sendMessageRef: React.RefObject<((sk: string, content: string, opts?: SendMessageOptions) => Promise<boolean>) | null>;
}

export function useQueueRetry(ctx: QueueRetryCtx) {
  const { drainingRef, isSendLocked, setExpiredMessages, setPendingQueue, sendMessageRef } = ctx;


  // Ritentativo del drain per gli item rinviati (sessione occupata). Un solo
  // timer alla volta; si autospegne quando la coda non rinvia più nulla.
  const drainRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainQueueRef = useRef<(() => Promise<void>) | null>(null);
  const DRAIN_RETRY_MS = 2_000;
  const scheduleDrainRetry = useCallback(() => {
    if (drainRetryRef.current) return;
    drainRetryRef.current = setTimeout(() => {
      drainRetryRef.current = null;
      void drainQueueRef.current?.();
    }, DRAIN_RETRY_MS);
  }, []);
  useEffect(() => () => {
    if (drainRetryRef.current) clearTimeout(drainRetryRef.current);
  }, []);

  // Drain outbound queue on reconnect.
  //
  // Invariante: la coda durevole si tocca UN ITEM ALLA VOLTA, e un item ne esce
  // solo quando è stato consegnato o deliberatamente scartato. La versione
  // precedente svuotava tutto in testa al drain e teneva gli item in una
  // variabile locale: bastava chiudere la tab a metà per perderli, e un item su
  // sessione occupata veniva semplicemente saltato — cioè cancellato. Vedi
  // `outboundQueue.ts` per la decisione item-per-item.
  const drainQueue = useCallback(async () => {
    // Prevent concurrent drains (e.g. rapid WS reconnects)
    if (drainingRef.current) return;
    drainingRef.current = true;

    let deferred = 0;
    try {
      const queue = getOutboundQueue();
      if (queue.length === 0) return;

      const now = Date.now();

      for (const item of queue) {
        const verdict = decideQueuedMessage(item, {
          now,
          locked: isSendLocked(item.sessionKey),
          sessionMessages: messagesRef.current[item.sessionKey] || [],
        });

        if (verdict.action === 'expire') {
          // Cambia coda, non evapora: resta offerto in retry anche dopo un reload.
          moveToExpired(queueStorage, item);
          setExpiredMessages(getExpiredQueue());
          setPendingQueue(getOutboundQueue());
          continue;
        }

        if (verdict.action === 'defer') {
          // La sessione sta già spedendo: l'item RESTA in coda. Nessuna scrittura.
          deferred += 1;
          continue;
        }

        if (verdict.action === 'drop') {
          setPendingQueue(removeQueueItem(queueStorage, OUTBOUND_QUEUE_KEY, item));
          continue;
        }

        // Un-mark the queued user message
        setMessages(prev => {
          const sessionMessages = prev[item.sessionKey] || [];
          const idx = sessionMessages.findIndex(
            m => m.role === 'user' && m.partial && m.content === item.content
          );
          if (idx >= 0) {
            const updated = [...sessionMessages];
            updated[idx] = { ...updated[idx], partial: false };
            return { ...prev, [item.sessionKey]: updated };
          }
          return prev;
        });

        try {
          // La chiave del tentativo di prima viaggia col rinvio: se il server
          // quel messaggio l'aveva già preso, risponde `duplicate_message` e
          // `sendMessage` lo lascia andare invece di scriverlo due volte. È ciò
          // che rende sicura la rimozione qui sotto — prima non lo era, e il
          // commento che segue lo diceva.
          await sendMessageRef.current!(item.sessionKey, item.content, { ...item.options, clientMessageId: item.id });
          // Esce di coda solo ADESSO, a tentativo concluso: per tutta la durata
          // dell'invio è rimasto scritto su disco, quindi una tab che muore a
          // metà lo ritrova. Si toglie anche quando `sendMessage` ha risposto
          // `false`, perché in quel caso è LUI che ha già deciso il destino del
          // messaggio — o l'ha ri-accodato da sé (rete giù, id nuovo, che questa
          // rimozione per id vecchio non tocca) o ha alzato l'errore lasciando
          // il messaggio visibile in chat. Tenerlo qui significherebbe
          // rispedirlo a un server che potrebbe averlo già preso.
          setPendingQueue(removeQueueItem(queueStorage, OUTBOUND_QUEUE_KEY, item));
        } catch {
          // `sendMessage` non lancia mai: se succede è un bug, e l'item resta in
          // coda esattamente dov'è. Si riprova al prossimo giro.
          deferred += 1;
        }
      }
    } finally {
      drainingRef.current = false;
      // Qualcosa è rimasto in coda per una sessione occupata: il lock si
      // libererà da solo (fine turno, o scadenza a 60s) ma nessun evento ci
      // richiamerebbe. Ripassiamo noi, finché la coda non si svuota o gli item
      // scadono. Senza questo, "resta in coda" diventerebbe "resta lì per
      // sempre" — meno grave della perdita, ma comunque un messaggio non
      // spedito.
      if (deferred > 0) scheduleDrainRetry();
    }
  }, [scheduleDrainRetry, drainingRef, isSendLocked, sendMessageRef, setExpiredMessages, setPendingQueue]);
  drainQueueRef.current = drainQueue;

  const retryExpired = useCallback(async (item: QueuedMessage) => {
    const key = queueItemKey(item);
    const without = (list: QueuedMessage[]) => list.filter(m => queueItemKey(m) !== key);
    writeQueue(queueStorage, EXPIRED_QUEUE_KEY, without(getExpiredQueue()));
    setExpiredMessages(prev => without(prev));
    try {
      // Anche il retry a mano porta la chiave di allora. Quasi sempre il server
      // l'avrà già dimenticata (scade in mezz'ora, e un messaggio scaduto è più
      // vecchio) e riparte pulito: portarla non può causare un doppione, può
      // solo evitarne uno.
      await sendMessageRef.current?.(item.sessionKey, item.content, { ...item.options, clientMessageId: item.id });
    } catch {
      setExpiredMessages(enqueue(queueStorage, EXPIRED_QUEUE_KEY, item));
    }
  }, [sendMessageRef, setExpiredMessages]);

  // Discard the expired messages of ONE chat. The banner names a chat per row,
  // so "dismiss" has to be per row too: dropping every chat's messages because
  // one of them is no longer wanted is the loss this queue exists to prevent.
  const dismissExpiredSession = useCallback((sessionKey: string) => {
    setExpiredMessages(removeQueueSession(queueStorage, EXPIRED_QUEUE_KEY, sessionKey));
  }, [setExpiredMessages]);

  return { drainQueue, retryExpired, dismissExpiredSession };
}
