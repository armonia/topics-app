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

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TopicGoal, WSMessage } from '../types';
import { ApiError, goalApi } from '../lib/api';

/**
 * The goal this device last saw for a topic. The bar it feeds sits INSIDE the
 * composer block, so a goal that arrives with the GET (300 ms after the first
 * paint) grows the composer by its 32 px and pushes the whole conversation
 * up — measured on a reload, 2026-09-03. Read synchronously at mount, so the
 * first frame already has the bar; the GET still decides, and a goal closed
 * elsewhere disappears when it answers.
 */
const GOAL_CACHE_PREFIX = 'topics-goal-cache:';
function readCachedGoal(topicId: string | null): TopicGoal | null {
  if (!topicId) return null;
  try {
    const raw = localStorage.getItem(GOAL_CACHE_PREFIX + topicId);
    return raw ? (JSON.parse(raw) as TopicGoal) : null;
  } catch {
    return null;
  }
}
function rememberGoal(topicId: string, goal: TopicGoal | null): void {
  try {
    if (goal) localStorage.setItem(GOAL_CACHE_PREFIX + topicId, JSON.stringify(goal));
    else localStorage.removeItem(GOAL_CACHE_PREFIX + topicId);
  } catch { /* storage denied: the bar simply arrives with the GET */ }
}

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
    () => ({ topicId, goal: readCachedGoal(topicId) }),
  );
  // On a topic switch the entry still belongs to the previous topic: until the
  // GET answers, the new topic's last known goal fills in for the same reason
  // as at mount.
  const cached = useMemo(() => readCachedGoal(topicId), [topicId]);
  const goal = entry.topicId === topicId ? entry.goal : cached;

  const reload = useCallback(async () => {
    // Niente topic, niente da azzerare: l'etichetta rende `goal` già nullo.
    if (!topicId) return;
    const id = topicId;
    try {
      const data = await goalApi.get(id);
      rememberGoal(id, data.goal);
      setEntry({ topicId: id, goal: data.goal });
    } catch (err) {
      // "THERE IS NO GOAL" IS NOT "I COULD NOT ASK FOR IT".
      //
      // There was one branch, and it wiped the cache on any failure at all: a
      // hiccup of the network made the bar disappear from the composer and,
      // worse, took the SEED with it - the seed that exists precisely so the
      // composer's height does not jump on the NEXT boot, when the GET lands
      // 300 ms after the first paint (measured 2026-09-03). A transient error
      // destroyed the defence against transients.
      //
      // The precedent is in this house: `lib/auth/session.ts`, "network down
      // is not unpaired". Same shape here. A server RESPONSE, whatever its
      // status, is authoritative on the fact that this chat has no goal to
      // show: the 404 of a topic that is gone, and the 403 of
      // `orchestrator_topic_invariant` on the global coordinator, which by
      // invariant has no goals. That branch is byte for byte what it was.
      // The silence of the transport is not: there nothing is known, so
      // nothing is touched and the bar keeps what it had, until a later GET
      // actually says something.
      if (err instanceof ApiError) {
        rememberGoal(id, null);
        setEntry({ topicId: id, goal: null });
      }
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
        rememberGoal(topicId, msg.goal);
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

  /** Stop the auto-continuation loop, leaving the objective alive. */
  const stopLoop = useCallback(async () => {
    if (!topicId) return;
    await goalApi.setLoop(topicId, 'stopped');
  }, [topicId]);

  /** The person adopts the goal the agent proposed. */
  const promote = useCallback(async () => {
    if (!goal) return;
    await goalApi.promote(goal.id);
  }, [goal]);

  return { goal, declare, close, promote, reload, stopLoop };
}
