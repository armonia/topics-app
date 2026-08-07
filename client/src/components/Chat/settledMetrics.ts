/**
 * Quando si vedono i numeri di un'azione FINITA.
 *
 * Vive in un modulo suo, non dentro `ToolCallRow`: un file di componenti che
 * esporta anche altro spegne il fast refresh di Vite — ogni salvataggio su
 * quel file rimonterebbe l'albero invece di aggiornarlo in posto
 * (`react-refresh/only-export-components`). Il posto giusto di una regola
 * condivisa fra due componenti è fuori da entrambi.
 */

import { useHoverReveal } from '../../hooks/useHoverReveal';

/**
 * I NUMERI A CONSUNTIVO si mostrano quando li cerchi.
 *
 * Durata e costo di un'azione FINITA non sono il contenuto della riga: sono
 * una nota a margine che, ripetuta su ogni riga di ogni turno, disegna una
 * colonna di cifre lungo tutta la chat e toglie peso all'unica cosa che si
 * legge davvero — che cosa ha fatto l'agente. Restano al loro posto (lo spazio
 * è riservato: niente riga che salta al passaggio del mouse) e compaiono
 * sull'hover della riga, o quando ci arrivi da tastiera.
 *
 * Vale solo per il CONSUNTIVO. Ciò che è vivo — il cronometro mentre l'azione
 * gira, la rotella, il cerchietto ambra dell'attesa — non si nasconde mai: è
 * segnale, non archivio.
 *
 * Senza puntatore niente hover: lì i numeri restano come sono sempre stati
 * (`touch: 'shown'`) — sono TESTO, non un comando, e non c'è niente da
 * raggiungere in un altro modo.
 *
 * Erano due COSTANTI di modulo calcolate una volta sola su `ontouchstart`.
 * Due errori in uno: la domanda giusta è `hasHover` (un portatile touch ha
 * anche il mouse, e lì i numeri restavano stampati per sempre), e una costante
 * di modulo non si accorge del puntatore che va e viene — una Magic Keyboard
 * tolta da un iPad non manda nessun `resize`. Adesso è un hook, quindi risponde.
 *
 * I due gruppi sono distinti — `/tool` per la riga, `/toolgroup` per il
 * riepilogo — perché con un nome solo il mouse su una riga interna
 * accenderebbe anche i numeri del riepilogo sopra.
 */
export function useSettledMetricClass(scope: 'tool' | 'toolgroup' = 'tool'): string {
  return useHoverReveal(scope, { touch: 'shown' });
}
