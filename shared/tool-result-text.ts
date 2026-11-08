/**
 * Il testo di un `tool_result`, che sul filo non è sempre testo.
 *
 * La CLI manda il contenuto di un risultato o come stringa o come ARRAY di
 * blocchi (`[{type:"text",text:…}]`) — la seconda forma la usano quasi tutti i
 * tool MCP e `ToolSearch`, cioè proprio quelli il cui risultato è testo e basta.
 * L'adapter faceva `JSON.stringify` su quel caso, e nella card del tool si
 * leggeva l'array serializzato, virgolette scappate comprese, al posto del
 * contenuto. Sul DB di questa macchina: 4.735 risultati su 32.492, il 14,6%.
 *
 * Vive in `shared/` perché serve a due tempi diversi e deve dire la stessa cosa:
 * il server la usa quando il risultato ARRIVA (`toolResultText`), il client
 * quando ne rilegge uno GIÀ SALVATO nella vecchia forma
 * (`unwrapStoredToolResult`) — i messaggi vecchi non si riscrivono.
 */

/** Blocco di contenuto dentro un `tool_result`, come lo manda la CLI. */
type ResultBlock = { type?: string; text?: string; tool_name?: string; [k: string]: unknown };

/**
 * Il testo di un `tool_result`, qualunque forma abbia il contenuto.
 *
 * Stringa → se stessa. Array di blocchi → i pezzi leggibili uno per riga:
 * `text` per il testo, il nome per i `tool_reference` (li produce ToolSearch),
 * un segnaposto per le immagini — che in un corpo di card sarebbero comunque
 * illeggibili, e in base64 sarebbero megabyte di rumore.
 *
 * Il `JSON.stringify` resta solo come ultima spiaggia, per una forma che non
 * conosciamo: mostrarla grezza è meglio che farla sparire.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let unknownBlocks = 0;
    for (const raw of content) {
      if (typeof raw === 'string') {
        if (raw) parts.push(raw);
        continue;
      }
      if (!raw || typeof raw !== 'object') {
        unknownBlocks++;
        continue;
      }
      const b = raw as ResultBlock;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text) parts.push(b.text);
      } else if (b.type === 'tool_reference' && typeof b.tool_name === 'string') {
        parts.push(b.tool_name);
      } else if (b.type === 'image') {
        parts.push('[immagine]');
      } else if (typeof b.text === 'string' && b.text) {
        // Forma sconosciuta ma con un campo `text`: quello è il contenuto.
        parts.push(b.text);
      } else {
        unknownBlocks++;
      }
    }
    if (parts.length === 0) return unknownBlocks > 0 ? JSON.stringify(content) : '';
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    const b = content as ResultBlock;
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return JSON.stringify(content);
}

/**
 * Un risultato GIÀ SALVATO che è la serializzazione di un array di blocchi.
 *
 * Serve solo alla lettura dei messaggi vecchi: quelli sono stati scritti prima
 * che l'adapter sapesse leggere gli array, e nel DB restano com'erano. Riscrivere
 * il DB per un difetto di sola resa sarebbe la cura peggiore della malattia.
 *
 * Prudente per costruzione: tocca la stringa solo se comincia per `[` e se il
 * parse dà un array in cui almeno un elemento è un blocco riconoscibile. Ogni
 * altro testo — compreso un output di shell che per caso è JSON — torna
 * identico.
 */
export function unwrapStoredToolResult(text: string): string {
  if (typeof text !== 'string') return text;
  const t = text.trimStart();
  if (!t.startsWith('[{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return text;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return text;
  const looksLikeBlocks = parsed.some(
    (b) => b && typeof b === 'object' && typeof (b as ResultBlock).type === 'string',
  );
  if (!looksLikeBlocks) return text;
  const out = toolResultText(parsed);
  return out || text;
}
