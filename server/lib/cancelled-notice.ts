// cancelled-notice.ts — che cosa resta scritto in chat quando un turno viene
// ANNULLATO, e da chi dipende.
//
// PERCHÉ ESISTE. `finalizeStream` trattava «annullato» come una cosa sola, e
// per una ragione buona: chi preme Ferma sa già di aver premuto, quindi
// scrivergli «turno interrotto» sarebbe rumore, e la riga vuota che quel turno
// lascia viene giustamente buttata (`shared/empty-turn.ts`).
//
// Solo che l'utente non è l'unico che annulla. Il 20/08, su topic:9f9e9629, ad
// annullare è stato lo SPEGNIMENTO del server: fswatch ha visto un salvataggio
// in `server/`, `restart-when-idle` ha atteso i suoi 60 secondi di cap per le
// chat, poi SIGTERM → `stopAllProviders()` → `abort()` su ogni turno vivo. Il
// turno è morto a metà di un tool, la bolla si è chiusa così com'era — l'ultima
// frase scritta, nessuna spiegazione, nessun bottone — e nel log è rimasta la
// riga «stream aborted by user», che è la stessa bugia scritta altrove.
//
// Chi guardava ha visto una risposta che si interrompe e non riprende più.
//
// LA REGOLA. Se ad annullare è stato l'umano non si scrive niente: lo sa. In
// ogni altro caso si scrive PERCHÉ, e si dice che il messaggio si può rimandare
// — perché il turno non tornerà da solo. Il testo usa il prefisso ⚠️ che il
// client già riconosce (`turnError.ts`): banner ambra e bottone «Riprova»,
// senza toccare una riga di client.
//
// È una funzione pura perché è una DECISIONE, e le decisioni si provano senza
// avviare un server: `finalizeStream` è dentro una route di 3000 righe con un
// provider vero attaccato, e una regola che vive solo lì dentro è una regola
// che nessuno rimette in discussione.

import type { TurnEndInfo } from "../providers/stop-reason";

/**
 * Il cartello da lasciare su un turno annullato, o `null` se il silenzio è la
 * risposta giusta.
 *
 * `null` significa DUE cose insieme, ed è voluto: niente da scrivere, e niente
 * che impedisca di buttare la riga se è rimasta vuota. Un turno fermato a mano
 * prima di qualsiasi output non deve lasciare traccia; ogni altro deve.
 */
export function cancelledNotice(info: TurnEndInfo): string | null {
  if (info.end !== "cancelled") return null;
  switch (info.cause) {
    // L'ha fermato lui. Dirglielo sarebbe raccontargli cos'ha appena fatto.
    case "user":
      return null;
    // La sessione `--resume` era sparita e il provider rispawna da solo
    // rimandando lo stesso turno: non è una fine, è una ripartenza. Un cartello
    // qui annuncerebbe un guasto a chi sta per ricevere la risposta.
    case "session-reset":
      return null;
    // Non abbiamo guidato nessun turno: la front-door ha respinto perché la
    // sessione stava già rispondendo. Non c'è niente di interrotto da spiegare.
    case "turn-in-flight":
      return null;
    case "server-shutdown":
      return (
        "⚠️ Turno interrotto: il server si è riavviato mentre la risposta era in corso. " +
        "Quello che era già arrivato resta qui sotto; «Riprova» rimanda il tuo messaggio."
      );
    case "watchdog":
      return (
        "⚠️ Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta " +
        "è stata chiusa. «Riprova» rimanda il tuo messaggio."
      );
    case "wall-clock":
      return (
        "⚠️ Turno interrotto: ha superato il limite di tempo concesso. " +
        "«Riprova» rimanda il tuo messaggio."
      );
    // Un annullamento senza causa dichiarata. NON si tace: il silenzio è
    // riservato ai casi che sappiamo innocui, e questo non è tra quelli — è
    // esattamente la forma che aveva il difetto del 20/08, un `cancelled` di
    // provenienza ignota trattato come se l'avesse chiesto l'utente.
    default:
      return (
        "⚠️ Turno interrotto prima della fine. " +
        "Quello che era già arrivato resta qui sotto; «Riprova» rimanda il tuo messaggio."
      );
  }
}

/**
 * La frase corta per il registro (`activity_log`), che prima diceva sempre
 * «stream aborted by user».
 *
 * Un registro che attribuisce a una persona ciò che ha fatto una macchina non
 * è impreciso: è la ragione per cui, cercando quel turno, si guarda dalla parte
 * sbagliata. Rimane volutamente in inglese come le altre voci di categoria.
 */
export function abortLogTitle(info: TurnEndInfo): string {
  if (info.end !== "cancelled") return "stream aborted";
  switch (info.cause) {
    case "user": return "stream aborted by user";
    case "watchdog": return "stream aborted by watchdog";
    case "wall-clock": return "stream aborted by wall-clock cap";
    case "server-shutdown": return "stream aborted by server shutdown";
    case "session-reset": return "stream aborted by session reset";
    case "turn-in-flight": return "stream not started (turn already in flight)";
    default: return "stream aborted";
  }
}
