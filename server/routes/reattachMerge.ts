/**
 * Una riadozione non può SOTTRARRE.
 *
 * Quando il server riparte e si riattacca a un turno sopravvissuto, la route
 * riusa la riga che quel turno stava scrivendo — e per riusarla la SVUOTA
 * (`reuseOrCreatePartialForReattach`), perché nel caso normale il replay
 * ri-emette tutto da capo e riempirla due volte darebbe testo doppio.
 *
 * Il caso normale però non è l'unico. `ClaudeCodeProvider.reattach` ha tre
 * uscite, e solo la prima ri-emette:
 *   • coda APERTA  → replay completo (testo + tool + domande in sospeso);
 *   • coda CHIUSA con un risultato → ri-consegna SOLO il testo finale;
 *   • niente da adottare → non ri-emette niente.
 * Nelle ultime due lo svuotamento è una perdita secca: la riga aveva un turno
 * intero di tool — magari un `ask_user_question` ancora a schermo — e dopo il
 * riattacco ha solo del testo, o niente. È così che il 4 agosto un pannello
 * domande è sparito sei volte di fila, una per ricarica del server, lasciando
 * ogni volta una copia dello stesso messaggio.
 *
 * Qui la regola, pura: si tiene quello che il riattacco ha PRODOTTO, e per ogni
 * cosa che non ha prodotto si rimette quella di prima. Se non ha prodotto
 * niente di nuovo, la riga torna esattamente com'era — riattaccarsi non è un
 * evento che merita una bolla.
 */

/** La riga com'era un attimo prima di svuotarla per il riattacco. */
export interface RowSnapshot {
  content: string;
  thinking: string | null;
  /** Colonna `tool_calls` grezza (JSON array) o null. */
  toolCallsJson: string | null;
  /** Colonna `blocks` grezza (JSON array) o null. */
  blocksJson: string | null;
}

/** Quello che il turno riadottato ha messo insieme prima di finalizzare. */
export interface ReattachProduced {
  content: string;
  thinking?: string;
  /** Quanti tool ha visto QUESTO handler (0 = replay muto o niente da adottare). */
  trackedTools: number;
  /** I blocchi accumulati da questo handler. */
  blocks: unknown[];
}

export interface ReattachMerge {
  content: string;
  thinking: string | undefined;
  /** `undefined` = non toccare la colonna (tiene quella che c'è). */
  toolCallsJson: string | undefined;
  blocks: unknown[] | undefined;
  /**
   * Il riattacco non ha aggiunto NIENTE: stesso testo di prima e nessun tool
   * nuovo. La riga va rimessa com'era e basta — nessun broadcast, nessuna
   * bolla nuova. È il caso che generava i doppioni.
   */
  nothingNew: boolean;
}

function countTools(json: string | null): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    // Illeggibile ma presente: c'è QUALCOSA lì dentro, e la regola è non
    // sottrarre. Contarlo come uno basta a farlo conservare.
    return 1;
  }
}

function countToolBlocks(blocks: unknown[]): number {
  return blocks.filter((b) => (b as { kind?: string } | null)?.kind === "tool").length;
}

/**
 * Cosa scrivere sulla riga alla fine di un turno RIADOTTATO.
 *
 * Il testo prodotto vince se c'è; se il riattacco è tornato a mani vuote resta
 * quello di prima. I tool si tengono se questo handler non ne ha visti — cioè
 * se il replay era muto — perché in quel caso l'unica copia che esiste è quella
 * già in riga. Stessa logica per i blocchi, ma misurata sui tool che portano:
 * una timeline nuova che ha perso per strada le righe dei tool non è un
 * aggiornamento, è una perdita.
 */
export function mergeReattachedRow(snapshot: RowSnapshot, produced: ReattachProduced): ReattachMerge {
  const producedText = produced.content.trim();
  const previousText = snapshot.content.trim();
  const snapshotTools = countTools(snapshot.toolCallsJson);

  const keepOldTools = produced.trackedTools === 0 && snapshotTools > 0;
  const producedToolBlocks = countToolBlocks(produced.blocks);
  const snapshotBlocks = (() => {
    if (!snapshot.blocksJson) return null;
    try {
      const parsed = JSON.parse(snapshot.blocksJson);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  })();
  const keepOldBlocks =
    !!snapshotBlocks && producedToolBlocks < countToolBlocks(snapshotBlocks);

  return {
    content: producedText ? produced.content : snapshot.content,
    thinking: produced.thinking || snapshot.thinking || undefined,
    toolCallsJson: keepOldTools ? (snapshot.toolCallsJson ?? undefined) : undefined,
    blocks: keepOldBlocks ? snapshotBlocks : (produced.blocks.length > 0 ? produced.blocks : undefined),
    // Niente di nuovo: nessun tool visto e il testo è quello che c'era già
    // (compreso il caso «il riattacco non ha prodotto una riga»).
    nothingNew: produced.trackedTools === 0 && (producedText === "" || producedText === previousText),
  };
}
