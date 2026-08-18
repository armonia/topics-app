/**
 * CHI ALTRO C'È, della tua organizzazione.
 *
 * La barra sopra la status bar diceva chi sei tu e quanti ferri hai. «Con chi
 * sto lavorando» non aveva risposta da nessuna parte — né lì, né col tasto
 * destro su un progetto — e il dato per darla esisteva già: `org_members`
 * popolata, e `lastSeenAt` per persona dalla rotta dei membri.
 *
 * LA SOGLIA STA QUI, non nel server, ed è una scelta. Il server manda i
 * millisecondi grezzi: se dichiarasse lui «online: true» congelerebbe una
 * finestra temporale che il client non può più cambiare, e due schermate con
 * due soglie diverse direbbero due verità sullo stesso membro.
 */

/** Visto negli ultimi cinque minuti = c'è. */
export const PRESENZA_MS = 5 * 60_000;

export interface MembroPresenza {
  id: string;
  lastSeenAt: number | null;
}

/**
 * Quanti membri sono online ADESSO, escluso te.
 *
 * Te stesso non conti: sei la riga sopra, e sommarti direbbe «2 online» a chi è
 * da solo con la propria seconda macchina. È la differenza fra «chi altro c'è»
 * e «quante sessioni ci sono», e questa riga risponde alla prima.
 */
export function presentiOra(
  membri: readonly MembroPresenza[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): number {
  // NON SAPERE CHI SEI NON E' «SEI NESSUNO».
  //
  // Con `io` a null il filtro `m.id !== io` non esclude piu' niente, e chi e'
  // da solo si vede contare 1: se stesso, presentato come «chi altro c'e'». Il
  // caso non e' teorico — l'identita' arriva da `/api/people`, una fetch
  // separata da quella dei membri, e finche' non risponde (o se fallisce, che
  // il chiamante ingoia di proposito) `io` E' null mentre i membri ci sono gia'.
  //
  // Zero, quindi, e la riga non compare: «non lo so» si dice tacendo, non
  // sparando un numero che nel caso piu' comune - una persona sola - e' anche
  // quello sbagliato.
  if (io === null) return 0;
  return membri.filter(
    (m) =>
      m.id !== io &&
      m.lastSeenAt !== null &&
      Number.isFinite(m.lastSeenAt) &&
      // Un `lastSeenAt` nel FUTURO (orologi che non concordano fra due
      // macchine) conta come presente: è il verso giusto in cui sbagliare,
      // perché l'errore opposto nasconderebbe qualcuno che c'è davvero.
      adesso - (m.lastSeenAt as number) < sogliaMs,
  ).length;
}
