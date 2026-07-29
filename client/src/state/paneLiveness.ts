import { createContext, useContext } from 'react';
import { useWindowAwake } from './windowAwake';

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

/**
 * La domanda che serve davvero a un poll: **qualcuno può vedere il risultato?**
 *
 * Una pane visibile in una finestra che sta dietro a un'altra app non è
 * guardata da nessuno, e un poll che gira lì compra niente pagando l'intera
 * pipeline `updateRendering` a ogni raffica.
 *
 * Da usare al posto del solo `isVisible` per tutto ciò che è periodico e
 * RECUPERABILE: contatori monotoni, sincronizzazioni di stato, misure. NON per
 * ciò che deve girare comunque in background (il drenaggio degli errori di
 * navigazione di un agente: l'agente lavora anche mentre guardi altrove).
 */
export function usePaneWatched(): boolean {
  const alive = usePaneAlive();
  const awake = useWindowAwake();
  return alive && awake;
}
