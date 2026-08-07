/**
 * Cosa scrivere nella bolla quando il turno muore DENTRO di noi.
 *
 * Un'eccezione nella gamba WS di `/api/chat` (fuori da qualunque handler dello
 * stream: risoluzione del provider, montaggio del turno, un import rimasto a
 * metà dopo un hot-reload) usciva dal `catch` con un 502 e lasciava sul campo:
 *   • la riga assistente APERTA (`partial = 1`), che è il perno letto dal
 *     setaccio di boot e dalla riadozione;
 *   • lo stream registrato in memoria, quindi la chat che gira per sempre;
 *   • nessuna traccia del PERCHÉ.
 * Al riavvio dopo, uno spazzino etichettava quella riga «No response received.
 * The AI service may be temporarily unavailable» — generico, e per giunta
 * falso: il 3 agosto alle 22:26 su topic:ed2070df il guasto era nostro
 * (`createHumanWaitLedger is not defined`, un export che il watcher aveva
 * ricaricato a metà). Chi legge cerca il guasto dalla parte sbagliata.
 *
 * Qui si decide, in puro, il testo che chiude quella riga — e soprattutto
 * QUANDO non toccarla: se il turno aveva già prodotto qualcosa, quel qualcosa
 * vale più di qualunque messaggio d'errore.
 */

/** La riga assistente come sta in DB nel momento dello schianto. */
export interface CrashedTurnRow {
  content: string;
  /** La colonna `tool_calls` grezza: JSON array, o niente. */
  toolCallsJson: string | null;
  /** La colonna `blocks` grezza: JSON array, o niente.
   *
   *  Non è un doppione di `content`. La prosa di un turno viene persistita in
   *  DUE colonne (`chat.ts`, ogni 10 chunk) e il client, quando `blocks` c'è,
   *  rende SOLO quelli — `content` non lo stampa nemmeno. Una guardia che
   *  guardasse il solo `content` giudicherebbe «vuota» una riga che a schermo è
   *  un turno intero: succede su ogni via che azzera `content` senza azzerare
   *  `blocks`. */
  blocksJson?: string | null;
}

/** Quanto testo dell'errore vero finisce sotto gli occhi di chi legge. */
const MAX_DETAIL_CHARS = 200;

/**
 * La prima riga dell'errore, senza il code-frame che Bun ci attacca dietro.
 * `err.message` di un ReferenceError sollevato da un modulo transpilato arriva
 * con dentro l'intero frammento di sorgente: incollarlo in chat è rumore.
 */
export function shortErrorDetail(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const firstMeaningful = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^\d+\s*\|/.test(l) && !/^\^+$/.test(l));
  const line = (firstMeaningful ?? text.trim()).replace(/\s+/g, " ");
  if (!line) return "errore senza messaggio";
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
}

/**
 * Il testo con cui chiudere la bolla, o `null` se la bolla NON va toccata.
 *
 * Comincia con ⚠️ apposta: il client aggancia lì il bottone «Riprova», che
 * rimanda il messaggio dell'utente (`ChatPane.handleRetry`). Il messaggio non
 * si perde mai — ed è quello che il testo dice, invece di lasciarlo indovinare.
 */
export function crashedTurnNotice(row: CrashedTurnRow | null, error: unknown): string | null {
  if (!row) return null;
  if (rowCarriesWork(row)) return null;
  return `⚠️ Errore interno di Topics: ${shortErrorDetail(error)} — il turno è morto prima di rispondere, non è il servizio AI. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.`;
}

/**
 * Il gemello per il turno che non si è potuto GUIDARE: `sendChat` ha rigettato,
 * o il montaggio del turno è morto prima di partire.
 *
 * Stessa guardia, testo diverso — lì la colpa è di un guasto dentro Topics, qui
 * il turno non è mai arrivato al modello. E una differenza che conta: se la riga
 * non si è potuta leggere, il cartello si scrive. Là il `null` significa «non
 * c'è una riga da toccare»; qui significa «non so cosa c'è dentro», e non
 * dirlo lascerebbe la bolla vuota e senza spiegazione.
 */
export function sendFailureNotice(row: CrashedTurnRow | null, error: unknown): string | null {
  if (row && rowCarriesWork(row)) return null;
  return `⚠️ Non sono riuscito ad avviare il turno: ${shortErrorDetail(error)} — il tuo messaggio è ancora qui: «Riprova» lo rimanda.`;
}

/**
 * La riga porta già del lavoro che vale più di qualunque cartello?
 *
 * Le tre colonne vanno guardate TUTTE e TRE. Il 6 agosto una via d'errore
 * guardava solo `content` e ci scriveva sopra: le tool call sopravvivevano per
 * via del COALESCE e `blocks` pure, così a schermo restava un turno intero
 * incorniciato di giallo — con dentro zero parole che dicessero perché, perché
 * il testo del cartello era sepolto in una colonna che il client non stampa.
 * Sono 45 righe così nel DB di produzione.
 */
export function rowCarriesWork(row: CrashedTurnRow | null): boolean {
  if (!row) return false;
  if (row.content.trim().length > 0) return true;
  if (hasJsonEntries(row.toolCallsJson)) return true;
  return hasJsonEntries(row.blocksJson ?? null);
}

function hasJsonEntries(json: string | null): boolean {
  if (!json) return false;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // JSON illeggibile: c'è comunque QUALCOSA in quella colonna. Meglio non
    // sovrascrivere una riga che potrebbe portare un turno intero di tool.
    return true;
  }
}
