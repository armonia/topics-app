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
// ogni altro caso si scrive PERCHÉ. Il prefisso ⚠️ è quello che il client già
// riconosce (`turnError.ts`): banner ambra, senza toccare una riga di client.
//
// COSA PUÒ FARCI CHI LEGGE non sta qui, e non è una dimenticanza. Il testo
// prometteva sempre «"Riprova" rimanda il tuo messaggio», ma quel bottone lo
// mostra `turnIsOnlyError` solo se il turno NON ha prodotto niente — regola
// giusta, perché rimandare un messaggio già risposto a metà ne farebbe un
// SECONDO, a pagamento, sopra uno che è già lì. Siccome il caso frequente è
// proprio il turno morto a METÀ lavoro, la promessa era quasi sempre falsa:
// «non vedo dall'app nessun riprova» (20/08). La coda giusta la sceglie
// `avvisoPerTurno`, in fondo a questo file.
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
        "⚠️ Turno interrotto: il server si è riavviato mentre la risposta era in corso."
      );
    case "watchdog":
      return (
        "⚠️ Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa."
      );
    case "wall-clock":
      return (
        "⚠️ Turno interrotto: ha superato il limite di tempo concesso."
      );
    // Un annullamento senza causa dichiarata. NON si tace: il silenzio è
    // riservato ai casi che sappiamo innocui, e questo non è tra quelli — è
    // esattamente la forma che aveva il difetto del 20/08, un `cancelled` di
    // provenienza ignota trattato come se l'avesse chiesto l'utente.
    default:
      return (
        "⚠️ Turno interrotto prima della fine."
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

/**
 * Il cartello COMPLETO: il perché, più l'unica cosa che chi legge può fare.
 *
 * Sono due frasi diverse a seconda che il turno abbia prodotto qualcosa, perché
 * è esattamente quello che decide se il bottone «Riprova» compare. Prometterlo
 * a chi non ce l'ha è peggio che tacere: lo manda a cercare un bottone che non
 * esiste.
 *
 * `riprendeDaSolo` vince su tutto: se il server si riprenderà il turno da sé
 * (`lib/ripresa-boot.ts`), chiedere all'utente un gesto è rumore — e rischia di
 * fargli spendere un turno in più per una cosa che stava già succedendo.
 */
export function avvisoPerTurno(
  info: TurnEndInfo,
  opts: { haProdotto: boolean; riprendeDaSolo?: boolean },
): string | null {
  const perche = cancelledNotice(info);
  if (!perche) return null;
  if (opts.riprendeDaSolo) return `${perche} Riprendo da solo: non serve che tu faccia niente.`;
  return opts.haProdotto
    ? `${perche} Quello che era già arrivato resta qui sotto: se ti serve il resto, chiedilo con un nuovo messaggio.`
    : `${perche} «Riprova» rimanda il tuo messaggio.`;
}

/**
 * Questo testo è un CARTELLO DI INTERRUZIONE scritto da noi?
 *
 * Serve a chi deve decidere se un turno merita una ripresa automatica leggendo
 * la riga già salvata, cioè quando la `StopCause` non c'è più: nel database
 * resta il blocco `error` col testo, non la causa che l'ha prodotto.
 *
 * PERCHÉ NON BASTA `kind === "error"`, ed è un difetto misurato. In quel blocco
 * ci finisce OGNI verdetto di guasto, e sul database vivo gli ultimi messaggi
 * con un blocco `error` erano: 25 «ai-bridge: ack timeout», 4 «Process exited
 * with code», 1 «API 400». Nessuno di questi è un'interruzione nostra: sono
 * guasti deterministici, e rimandare il messaggio ricompra lo stesso
 * fallimento — su un turno lungo, riaprendo tutti i giri di tool che aveva già
 * fatto.
 *
 * I testi sono quelli di `cancelledNotice` qui sopra e stanno nello stesso
 * file APPOSTA: chi cambia una frase vede subito chi la legge. La regola
 * autorevole resta `meritaRipresaAutomatica` (`ripresa-automatica.ts`), che
 * gira sulla `StopCause`; questa è la lettura di ripiego per le righe già
 * scritte, ed è volutamente STRETTA — un falso negativo lascia un cartello con
 * il bottone «Riprova», che è reversibile; un falso positivo brucia un turno.
 */
export function eCartelloDiInterruzione(testo: string | null | undefined): boolean {
  const t = (testo ?? "").trim().replace(/^⚠️\s*/, "");
  if (!t) return false;
  return CARTELLI_RIPRENDIBILI.some((c) => t.startsWith(c));
}

/**
 * Gli incipit dei cartelli che nascono da un'interruzione NOSTRA — le stesse
 * tre cause che `CAUSE_DA_RIPRENDERE` ammette. Il caso `default` di
 * `cancelledNotice` (annullamento senza causa dichiarata) resta FUORI, per la
 * stessa ragione per cui `meritaRipresaAutomatica` lo esclude: non si indovina
 * chi ha annullato.
 */
const CARTELLI_RIPRENDIBILI = [
  "Turno interrotto: il server si è riavviato",
  "Turno interrotto: il processo dell'agente non dava più segni di vita",
  "Turno interrotto: ha superato il limite di tempo",
] as const;
