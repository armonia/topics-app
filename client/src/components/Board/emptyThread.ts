import type { TaskStatus } from '../../lib/board';

/**
 * COSA DICE UN THREAD VUOTO.
 *
 * Prima diceva «Nessun commento.», che constata un'assenza gia' visibile: sotto
 * al titolo non c'era niente, e la riga lo ripeteva. Il vuoto di un task e'
 * invece l'unico posto in cui dire DOVE arriveranno la consegna e le domande
 * dell'agente, e soprattutto A CHI TOCCA la mossa.
 *
 * Cambia con lo stato perche' gli stati aspettano cose diverse, e una sola
 * frase per tutti mentirebbe a meta' dei casi:
 *  - `backlog` aspetta TE (nessuno lo prende finche' non lo sposti);
 *  - `todo` aspetta la macchina (parte quando c'e' posto);
 *  - `in_progress` sta gia' lavorando, e il thread e' dove chiedera';
 *  - `done` chiuso senza che nessuno abbia scritto: e' un fatto, non un invito.
 *
 * Fuori da questi quattro si torna alla frase neutra: inventare un invito per
 * uno stato che non si conosce e' peggio che constatare.
 */
export function emptyThreadKey(status: TaskStatus | string): string {
  switch (status) {
    case 'backlog': return 'board.task.emptyBacklog';
    case 'todo': return 'board.task.emptyTodo';
    case 'in_progress': return 'board.task.emptyProgress';
    case 'done': return 'board.task.emptyDone';
    default: return 'board.task.noComments';
  }
}
