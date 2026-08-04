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
  if (row.content.trim().length > 0) return null;
  if (hasToolCalls(row.toolCallsJson)) return null;
  return `⚠️ Errore interno di Topics: ${shortErrorDetail(error)} — il turno è morto prima di rispondere, non è il servizio AI. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.`;
}

function hasToolCalls(json: string | null): boolean {
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
