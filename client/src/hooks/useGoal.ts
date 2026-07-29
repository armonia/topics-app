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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TopicGoal, WSMessage } from '../types';
import { goalApi } from '../lib/api';

export function useGoal(
  topicId: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
  const [goal, setGoal] = useState<TopicGoal | null>(null);

  // Guardia anti-stale, come in useMemory: la chat non si rimonta al cambio di
  // topic, quindi una GET lenta su A che risolve dopo lo switch a B pianterebbe
  // l'obiettivo di A sotto l'intestazione di B.
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  const reload = useCallback(async () => {
    if (!topicId) {
      setGoal(null);
      return;
    }
    const id = topicId;
    try {
      const data = await goalApi.get(id);
      if (topicIdRef.current !== id) return;
      setGoal(data.goal);
    } catch {
      // Una topic senza goal non è un errore da mostrare: la barra sparisce.
      if (topicIdRef.current === id) setGoal(null);
    }
  }, [topicId]);

  useEffect(() => {
    setGoal(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!onMessage || !topicId) return;
    return onMessage((msg: WSMessage) => {
      if (msg.type === 'goal:updated' && msg.topicId === topicId) setGoal(msg.goal);
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
