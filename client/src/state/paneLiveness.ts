import { createContext, useContext } from 'react';

/**
 * "Questa pane ha un box nel layout?" — cioè: è visibile, e lo è anche ogni
 * guscio che la contiene.
 *
 * Il valore lo pubblica `PaneKeepAlive` come `parentAlive && isVisible`, e la
 * moltiplicazione col padre gestisce GRATIS i gusci annidati: una pane dentro
 * una pane `project` nascosta è viva solo se lo sono entrambe. Fuori da ogni
 * guscio il default è `true`, così un componente montato altrove (un modale, la
 * sidebar) non si spegne per sbaglio.
 *
 * PERCHÉ UN CONTEXT E NON UNA PROP. `PaneKeepAlive` congela l'ELEMENTO React del
 * sottoalbero per ottenere il bailout, quindi una prop nuova non arriverebbe mai
 * a una pane nascosta — che è precisamente il caso in cui serve. React invece
 * propaga i context ATTRAVERSO il bailout (lo dice la nota in `PaneKeepAlive`),
 * quindi il segnale arriva.
 *
 * REGOLA PER CHI LO CONSUMA: `false` non vuol dire SMONTARE. Vuol dire
 * SOSPENDERE — fermare poll, observer e rAF che misurano qualcosa che nessuno
 * guarda. Lo stato resta, e alla riattivazione si riprende. Chi distrugge
 * qualcosa qui riporta i bug che il keep-alive esiste per evitare.
 */
export const PaneAliveContext = createContext<boolean>(true);

/** La pane che ci ospita ha un box nel layout adesso? */
export function usePaneAlive(): boolean {
  return useContext(PaneAliveContext);
}

// Qui viveva `usePaneWatched()` = `usePaneAlive() && useWindowAwake()`, pensato
// come gate per i poll periodici. Non ha MAI avuto un chiamante: chi deve
// decidere se un ciclo gira usa il predicato sincrono `isWindowAwake()` dentro
// il timer (SingleTerminalPane, useFloatingVibrancy, fpsMonitor, useWebSocket),
// che è la forma giusta — non serve ri-renderizzare un componente per spegnere
// un `setInterval`. Un wrapper reattivo senza consumatori teneva in piedi uno
// store `useSyncExternalStore` con listener globali per nessuno.
