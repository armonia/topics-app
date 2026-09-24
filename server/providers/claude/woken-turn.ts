/**
 * IL TURNO CHE LA CLI APRE DA SOLA — la decisione, staccata dal provider.
 *
 * Un `Monitor` armato («avvisami quando il build finisce») non consegna il suo
 * evento dentro il turno che l'ha armato: quel turno è finito da un pezzo. Lo
 * consegna aprendo un TURNO NUOVO, e siccome dopo un `result` nessuno ascolta
 * più quella sessione, quel turno cadeva riga per riga — la risposta esisteva
 * ed era invisibile. La traccia misurata (CLI 2.1.237, 20/08/2026) sta in testa
 * a `claude-code-woken-turn.test.ts`.
 *
 * Qui vive la sola parte che si può decidere SENZA il processo in mano: guardata
 * una riga, è l'inizio di un turno che nessuno ha chiesto? Sta fuori dal
 * provider perché è una regola, non uno stato: si legge in dieci righe, si prova
 * senza montare un finto `PersistentProcess`, e non fa crescere il file che
 * `check-bloat` sorveglia (3.800 righe: ogni pezzo che si può staccare, si
 * stacca).
 */

import type { StreamLineKind } from "./events";
import type { ContentBlock } from "../../types";

/**
 * Questa riga apre un turno che nessuno ha chiesto?
 *
 * Il riconoscimento è per SOTTRAZIONE, e deve restarlo: «contenuto vero, nessuno
 * in ascolto, e non stiamo rileggendo lo store». Legarlo al `system/init` che la
 * CLI emette quando riapre sarebbe legarlo alla FORMA di un evento che Anthropic
 * può cambiare senza dircelo; queste tre condizioni sono invece proprietà
 * nostre, e restano vere qualunque cosa la CLI decida di chiamare init domani.
 *
 * Le due bandiere di replay sono la guardia che conta davvero: una riadozione
 * (`reattach`, dopo un riavvio del server) ripercorre di proposito uno store che
 * contiene turni GIÀ FINITI. Senza escluderle, ogni riavvio «sveglierebbe» un
 * turno di ieri e ne riscriverebbe la risposta in chat una seconda volta.
 */
export function isWokenTurnLine(args: {
  /** C'è già qualcuno che guida questa sessione? */
  hasHandler: boolean;
  /** Siamo nella scansione muta di una riadozione? */
  replayMute: boolean;
  /** Siamo nel fold silenzioso di una riadozione? */
  replaySilent: boolean;
  /** Che cosa è questa riga (vedi `claude/events.ts`). */
  kind: StreamLineKind;
}): boolean {
  if (args.hasHandler) return false;
  if (args.replayMute || args.replaySilent) return false;
  // `content` = i blocchi veri (assistant/user), `partial` = i loro pezzi in
  // streaming. Un `result` NON conta: chiude un turno, non ne apre uno, e senza
  // handler non c'è niente da chiudere. `noise` e `compaction` non sono il
  // modello che parla.
  return args.kind === "content" || args.kind === "partial";
}

/**
 * Quanti eventi si tengono da parte mentre il server apre la riga che li
 * accoglierà (il buffer vive sul processo, `wokenBuffer`).
 *
 * 200 è largo per il caso vero e stretto per quello rotto: un risveglio è un
 * turno corto e l'adozione dura un giro di event loop più una INSERT. Oltre,
 * l'adozione non è lenta — è FALLITA — e continuare ad accumulare terrebbe in
 * RAM un turno intero da consegnare a nessuno.
 */
export const WOKEN_BUFFER_MAX = 200;

/**
 * Prende in consegna gli eventi tenuti da parte e li ripiega, NELL'ORDINE.
 *
 * L'ordine non è un dettaglio: gli `assistant` sono cumulativi, `tool_use` e
 * `tool_result` si deducono a vicenda, e consegnarli mescolati darebbe una riga
 * di chat plausibile e sbagliata.
 *
 * Il buffer si azzera PRIMA di ripiegare: chi consuma rientra nello stesso
 * gestore per ognuno di quegli eventi, e trovarlo ancora aperto lo farebbe
 * rimettere in coda ciò che sta consumando.
 *
 * Sta qui e non nel provider per la stessa ragione della regola qui sopra: è
 * una decisione pura sopra una lista, si prova senza montare un processo finto,
 * e `claude-code.ts` è già al suo tetto di righe.
 */
export function drainWoken(
  slot: { wokenBuffer?: unknown[] | null; sessionKey: string },
  consegna: (ev: unknown) => void,
): void {
  const pending = slot.wokenBuffer;
  slot.wokenBuffer = null;
  (slot as WokenSlot).bufferedTurnEnded = false;
  if (!pending || pending.length === 0) return;
  for (const ev of pending) {
    try { consegna(ev); }
    catch (err) { console.warn(`[claude-code] evento del risveglio non consegnato su ${slot.sessionKey}:`, err); }
  }
}

/** Lo slot del processo che questo modulo tocca. */
export interface WokenSlot {
  sessionKey: string;
  wokenBuffer?: unknown[] | null;
  streamHandler: unknown;
  /** La `description` dell'ultimo Monitor armato: viaggia con la sveglia
   *  perché è la sola cosa che risponde a «arrivato COSA». */
  ultimoMonitor?: string;
  /** The spontaneous turn in flight was declined: its content is dropped
   *  until its own `result`, so it can neither wake twice nor reach the next
   *  turn somebody asks for. */
  declinedTurn?: boolean;
  /** The buffered turn already produced its `result`: it is a finished turn
   *  waiting for its adopter, not one a new sender can merge into. */
  bufferedTurnEnded?: boolean;
}

/**
 * The server's answer to a wake. `false` = declined (no chat to write it in).
 * Anything else = an adoption is on its way; if it fails later, `abandon`
 * turns the held turn into a declined one.
 */
export type WakeObserver = (sessionKey: string, label: string | undefined, abandon: () => void) => boolean | void;

/**
 * A wake that will never be adopted: drop what is held, and drop the rest of
 * that turn as it arrives. The held lines used to stay in the buffer, and the
 * next `registerStreamHandler`, from a turn somebody else asked for, poured
 * them into its own row (topic 2d0c1101, 23/09).
 *
 * A turn that already ended leaves nothing more to drop, so the flag is set
 * only while it still runs. With a handler installed the remaining lines
 * already belong to that turn (the CLI merges a message sent mid-turn).
 */
export function abandonHeldTurn(slot: WokenSlot): void {
  const ended = slot.bufferedTurnEnded === true;
  slot.wokenBuffer = null;
  slot.bufferedTurnEnded = false;
  if (!ended && !slot.streamHandler) slot.declinedTurn = true;
}

/**
 * What to do with a line outside replay, BEFORE the ordinary processing.
 *
 * `drop`: content of a declined turn. `hold`: the `result` of a turn waiting
 * for its adopter, which must reach it or the adopted row never closes.
 * `pass`: everything else, unchanged.
 *
 * Any real `result` ends the declined turn, handler or not: the CLI answers a
 * message sent during a spontaneous turn with ONE merged result (measured on
 * CLI 2.1.280, 24/09), and the next spontaneous turn must be able to wake.
 */
export function unattendedLineFate(
  slot: WokenSlot,
  event: unknown,
  kind: StreamLineKind,
): "drop" | "hold" | "pass" {
  const closes = kind === "result" && (event as { result?: unknown })?.result !== "waiting for message";
  if (slot.streamHandler) {
    if (closes) slot.declinedTurn = false;
    return "pass";
  }
  if (slot.declinedTurn) {
    if (closes) { slot.declinedTurn = false; return "pass"; }
    return kind === "content" || kind === "partial" ? "drop" : "pass";
  }
  if (closes && slot.wokenBuffer != null) {
    slot.wokenBuffer.push(event);
    slot.bufferedTurnEnded = true;
    return "hold";
  }
  return "pass";
}

/**
 * Il primo evento di un turno spontaneo: apre il buffer, chiama la sveglia, e
 * dice al chiamante se deve FERMARSI (nessuno ha ancora adottato) o proseguire.
 *
 * Il buffer si apre PRIMA della sveglia, non dopo: chi ascolta può registrare
 * un handler in modo sincrono, e in quel caso questo stesso evento deve già
 * trovare dove appoggiarsi.
 *
 * `true` = tenuto da parte, il chiamante non lo processi. `false` = qualcuno ha
 * adottato in modo sincrono, si prosegue col nuovo handler.
 *
 * A declined wake (the observer answers `false`, or nobody observes) drops the
 * turn on the spot instead of holding it for an adopter that will never come.
 * The `abandon` handed to the observer is bound to THIS buffer: called late,
 * after the turn was adopted or a newer wake opened its own buffer, it does
 * nothing.
 */
export function bufferWoken(
  slot: WokenSlot,
  event: unknown,
  sveglia: WakeObserver | null,
): boolean {
  if (slot.wokenBuffer == null) {
    const held: unknown[] = [];
    slot.wokenBuffer = held;
    slot.bufferedTurnEnded = false;
    let answer: boolean | void = sveglia ? undefined : false;
    try {
      if (sveglia) answer = sveglia(slot.sessionKey, slot.ultimoMonitor, () => {
        if (slot.wokenBuffer === held) abandonHeldTurn(slot);
      });
    } catch (err) {
      // An observer that throws adopts nothing: holding the turn for it would
      // only leave it for the next sender to inherit.
      answer = false;
      console.warn(`[claude-code] la sveglia del turno spontaneo su ${slot.sessionKey} ha rigettato:`, err);
    }
    if (answer === false && slot.wokenBuffer === held) {
      abandonHeldTurn(slot);
      return true;
    }
  }
  // La sveglia può aver adottato sul posto: allora il buffer è già stato
  // svuotato da `drainWoken` e non c'è niente da tenere.
  if (slot.streamHandler) return false;
  const buf = slot.wokenBuffer ?? (slot.wokenBuffer = []);
  if (buf.length < WOKEN_BUFFER_MAX) buf.push(event);
  else if (buf.length === WOKEN_BUFFER_MAX) {
    console.warn(`[claude-code] turno spontaneo su ${slot.sessionKey}: nessuno l'ha adottato entro ${WOKEN_BUFFER_MAX} eventi, smetto di tenerli`);
    buf.push(event); // supera il tetto: il ramo sopra non ripete il log
  }
  return true;
}

/**
 * Si ricorda COSA sorveglia un `Monitor` appena armato.
 *
 * La sua `description` è l'unica cosa che risponde a «arrivato COSA» quando il
 * risveglio consegna — minuti dopo, sotto un messaggio che non c'entra, quando
 * il `tool_use` che l'ha armato è passato da un pezzo. Si tiene ORA, che è
 * l'unico momento in cui la si vede.
 *
 * L'ultimo vince: fra due Monitor armati, il più recente è quasi sempre quello
 * che sveglierà per primo, e una descrizione plausibile vale più di nessuna.
 */
export function ricordaMonitor(
  slot: { ultimoMonitor?: string },
  toolName: string,
  input: unknown,
): void {
  if (toolName !== "Monitor") return;
  const d = (input as Record<string, unknown> | undefined)?.description;
  if (typeof d === "string" && d.trim()) slot.ultimoMonitor = d.trim();
}

/**
 * Il CARTELLO in cima a una risposta nata da un risveglio.
 *
 * Una risposta così arriva minuti dopo, sotto un messaggio che non c'entra, e
 * senza niente che dica da dove viene: in chat era indistinguibile da una
 * risposta qualunque. Il blocco porta la `description` che l'agente aveva dato
 * al Monitor — «arrivato COSA» — e il client la rende come intestazione.
 *
 * Un'etichetta vuota o assente lascia il cartello senza `label`: meglio muto
 * che con un'etichetta inventata.
 */
export function cartelloRisveglio(isWoken: boolean, label: unknown): ContentBlock[] {
  if (!isWoken) return [];
  const l = typeof label === "string" ? label.trim() : "";
  return [{ kind: "woken", ...(l ? { label: l } : {}) }];
}
