/**
 * boardTasksStore — le righe della board di TUTTI i progetti, tenute UNA volta
 * per documento e lette da chiunque le mostri.
 *
 * Perché uno store e non un hook con lo stato dentro. Il feed globale
 * (`GET /api/all-boards/tasks`) lo carica `useGlobalBoard`, montato in App, e
 * lo riaggiorna a ogni evento `task:*` del WebSocket. Finché quello stato
 * viveva dentro l'hook, ogni superficie che volesse gli stessi numeri doveva
 * montare l'hook — cioè una SECONDA fetch e una seconda sottoscrizione, con la
 * possibilità concreta di due risposte diverse nello stesso istante. Le tab
 * della board sono N (una per barra, e le barre sono una per gruppo di split),
 * quindi il conto non è due: è N.
 *
 * Qui la fetch resta una sola, dov'era — `useGlobalBoard` SCRIVE — e chi legge
 * si limita a sottoscrivere. Nessun lettore fa partire richieste: se il
 * proprietario non è montato, i lettori vedono la lista vuota, che è anche la
 * verità («non lo so ancora») per una superficie che al massimo non disegna un
 * numero.
 */
import { useSyncExternalStore } from 'react';
import type { BoardTask } from './board';

let tasks: readonly BoardTask[] = [];
const listeners = new Set<() => void>();

/** La lista, o quella vuota finché la prima lettura non è tornata. */
export function getBoardTasks(): readonly BoardTask[] {
  return tasks;
}

/**
 * Il proprietario del feed pubblica qui. Identità nuova a ogni scrittura (la
 * lista arriva già nuova dalla fetch), quindi `useSyncExternalStore` non ha
 * bisogno di nessun confronto profondo: chi legge deriva i suoi numeri con un
 * `useMemo` sulla stessa referenza.
 */
export function setBoardTasks(next: readonly BoardTask[]): void {
  tasks = next;
  listeners.forEach((cb) => cb());
}

export function subscribeBoardTasks(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Le righe della board, reattive. */
export function useBoardTasks(): readonly BoardTask[] {
  return useSyncExternalStore(subscribeBoardTasks, getBoardTasks, getBoardTasks);
}
