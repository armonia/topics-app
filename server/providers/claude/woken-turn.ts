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
