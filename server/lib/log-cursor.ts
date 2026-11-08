/**
 * Il buffer di log di un processo, e il cursore con cui lo si legge.
 *
 * ── Il bug che questo modulo esiste per chiudere ────────────────────────────
 * Il buffer è circolare: sopra una soglia le righe più vecchie vengono buttate
 * da SOTTO. Il cursore del client, però, era un indice dentro quell'array —
 * quindi dopo un'eviction lo stesso numero indicava un'altra riga. Effetto
 * misurato eseguendo le funzioni vere: una riga sparisce in silenzio;
 * nell'altro verso si rivedono blocchi già visti. Su un build verboso i 500KB
 * si raggiungono in minuti, e vale anche per l'agente che legge via
 * `read_process_output`.
 *
 * Qui il cursore è ASSOLUTO: conta le righe dall'inizio del processo, e
 * `dropped` fa da origine. Chi resta indietro oltre la finestra non riceve
 * silenzio, riceve `truncatedLines`.
 *
 * ── L'altro bug: l'interlinea doppia ────────────────────────────────────────
 * `"hello\n".split("\n")` dà `["hello", ""]`. Quell'elemento vuoto finiva nel
 * buffer, e due chunk consecutivi producevano `hello\n\nworld`: il log a
 * interlinea doppia che si vedeva aprendo qualsiasi processo. Simmetricamente
 * un chunk tagliato a metà riga diventava due righe. Qui l'ultima riga senza
 * `\n` resta in sospeso finché non arriva il suo terminatore.
 */

export interface LogBuffer {
  /** Righe TERMINATE, dalla più vecchia sopravvissuta. */
  output: string[];
  /** Somma delle lunghezze in `output` (senza i newline). */
  outputBytes: number;
  /** Quante righe sono già state buttate: è l'origine del cursore assoluto. */
  droppedLines: number;
  /** L'ultima riga non ancora terminata da `\n`. */
  pendingLine: string;
}

export function emptyLogBuffer(): LogBuffer {
  return { output: [], outputBytes: 0, droppedLines: 0, pendingLine: "" };
}

/**
 * Aggiunge testo al buffer, potando ciò che sfora `maxBytes`.
 *
 * @param whole `true` quando `text` è un blocco COMPLETO e non un frammento di
 *   stream: i chunk di `proc.stdout` arrivano tagliati dove capita e l'ultima
 *   riga va tenuta in sospeso, mentre un `BashOutput` di un agente è una
 *   fotografia intera e trattenerne l'ultima riga la renderebbe invisibile fino
 *   al blocco successivo — che può non arrivare mai.
 */
export function appendToLogBuffer(buf: LogBuffer, text: string, maxBytes: number, whole = false): void {
  if (!text) return;
  const chunk = buf.pendingLine + text;
  const parts = chunk.split("\n");
  const tail = parts.pop() ?? "";
  if (whole && tail) parts.push(tail);
  buf.pendingLine = whole ? "" : tail;
  if (parts.length > 0) {
    for (const line of parts) buf.outputBytes += line.length;
    buf.output.push(...parts);
  }
  if (buf.outputBytes <= maxBytes) return;
  // Potatura in blocco: la vecchia `shift()` per riga era O(n) a ogni riga
  // buttata, sul percorso caldo di ogni chunk di ogni processo tracciato.
  let drop = 0;
  let freed = 0;
  while (drop < buf.output.length - 1 && buf.outputBytes - freed > maxBytes) {
    freed += buf.output[drop].length;
    drop++;
  }
  if (drop > 0) {
    buf.output.splice(0, drop);
    buf.outputBytes -= freed;
    buf.droppedLines += drop;
  }
}

/** Chiude la riga in sospeso: un processo può morire senza l'ultimo `\n`. */
export function flushLogBuffer(buf: LogBuffer): void {
  if (!buf.pendingLine) return;
  buf.output.push(buf.pendingLine);
  buf.outputBytes += buf.pendingLine.length;
  buf.pendingLine = "";
}

export interface LogSlice {
  output: string;
  /** Il nuovo cursore assoluto del chiamante. */
  offset: number;
  /** L'ultima riga non terminata: si MOSTRA, non si accumula. */
  pending: string;
  /** Righe buttate che questo chiamante non vedrà mai. */
  truncatedLines: number;
}

/** Il pezzo di log che chi è fermo a `offset` non ha ancora visto. */
export function sliceFromCursor(buf: LogBuffer, offset: number): LogSlice {
  const start = Math.max(0, offset - buf.droppedLines);
  return {
    output: buf.output.slice(start).join("\n"),
    offset: buf.droppedLines + buf.output.length,
    pending: buf.pendingLine,
    truncatedLines: Math.max(0, buf.droppedLines - offset),
  };
}
