/**
 * Il goal della topic aperta (3.4).
 *
 * Lettura sola più eventi: le scritture passano da `goalApi` e tornano indietro
 * come `goal:updated`, esattamente come tornerebbe la scrittura di un'altra
 * finestra. Nessun aggiornamento ottimistico: la barra mostra quello che il
 * server ha davvero, che è anche quello che il modello si vede iniettare nel
 * contesto — una barra che anticipa lo stato mentirebbe proprio sul dato per
 * cui esiste.
 */

import { useCallback, useEffect, useState } from 'react';
import type { TopicGoal, WSMessage } from '../types';
import { goalApi } from '../lib/api';

export function useGoal(
  topicId: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
  // L'obiettivo si tiene INSIEME alla topic da cui è arrivato, e si legge solo
  // se le due combaciano. La chat non si rimonta al cambio di topic: una GET
  // lenta su A che risolve dopo lo switch a B pianterebbe l'obiettivo di A
  // sotto l'intestazione di B. Etichettarlo risolve la cosa alla radice —
  // niente ref di guardia, e niente azzeramento in un effetto solo per evitare
  // il lampo dell'obiettivo sbagliato.
  const [entry, setEntry] = useState<{ topicId: string | null; goal: TopicGoal | null }>(
    { topicId: null, goal: null },
  );
  const goal = entry.topicId === topicId ? entry.goal : null;

  const reload = useCallback(async () => {
    // Niente topic, niente da azzerare: l'etichetta rende `goal` già nullo.
    if (!topicId) return;
    const id = topicId;
    try {
      const data = await goalApi.get(id);
      setEntry({ topicId: id, goal: data.goal });
    } catch {
      // Una topic senza goal non è un errore da mostrare: la barra sparisce.
      setEntry({ topicId: id, goal: null });
    }
  }, [topicId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincronizzazione con un sistema esterno (il server): `reload` non tocca lo stato in modo sincrono, ogni `setEntry` sta DOPO l'await della GET. Nessuna cascata: l'effetto riparte solo quando cambia `topicId`.
    reload();
  }, [reload]);

  useEffect(() => {
    if (!onMessage || !topicId) return;
    return onMessage((msg: WSMessage) => {
      if (msg.type === 'goal:updated' && msg.topicId === topicId) {
        setEntry({ topicId, goal: msg.goal });
      }
    });
  }, [onMessage, topicId]);

  const declare = useCallback(
    async (content: string) => {
      if (!topicId) return;
      await goalApi.set(topicId, content);
    },
    [topicId],
  );

  const close = useCallback(
    async (status: 'achieved' | 'abandoned') => {
      if (!topicId) return;
      await goalApi.close(topicId, status);
    },
    [topicId],
  );

  return { goal, declare, close, reload };
}
