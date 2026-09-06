/**
 * La BOZZA del pannello di risposta, per non perderla a un ricaricamento.
 *
 * Il pannello («l'agente attende la tua risposta») teneva tutto in stato React:
 * opzioni selezionate, testo scritto nel campo libero, a che domanda eri
 * arrivato. Un ⌘R — o la chiusura della pane, o l'app che riparte — e tutto
 * spariva, mentre l'agente dall'altra parte è ancora fermo lì ad aspettare la
 * stessa domanda. Rispondere è un lavoro dell'umano: buttarlo via perché la
 * finestra si è ricaricata è la stessa classe di difetto di una chat che perde
 * il testo non inviato.
 *
 * Chiave: il `toolCallId`, cioè LA domanda specifica. Non la sessione: nella
 * stessa sessione possono susseguirsi domande diverse, e la bozza dell'una non
 * deve ricomparire sotto l'altra.
 *
 * Portata: questo dispositivo. La bozza vive in `localStorage`, quindi non
 * segue su un altro computer — è un compromesso voluto: sincronizzarla vorrebbe
 * dire scrivere sul server a ogni carattere per una cosa che si risponde da un
 * posto solo. Ciò che DEVE essere condiviso — la domanda, e la risposta una
 * volta inviata — passa già dal server.
 */

const PREFIX = 'topics:ask-draft:';
/** Oltre questa età una bozza non interessa più a nessuno: la domanda è morta
 *  con la sessione che l'aveva posta. Serve a non far crescere lo storage
 *  all'infinito con risposte mai inviate. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AskDraft {
  /** Etichette scelte per domanda (chiave = testo della domanda). */
  selections?: Record<string, string[]>;
  /** Testo scritto nel campo «Altro», per domanda. */
  otherText?: Record<string, string>;
  /** A che domanda eri arrivato, nel pannello a passi. */
  step?: number;
  /** Il campo libero dei pannelli senza opzioni. */
  text?: string;
  /** I valori di un modulo di elicitation MCP. */
  values?: Record<string, unknown>;
  /** Il JSON grezzo, quando lo schema è troppo ricco per il modulo. */
  jsonText?: string;
  /**
   * The plan as the human is rewriting it, on a plan approval panel. Written
   * only when it DIFFERS from what the model proposed, so an untouched panel
   * leaves no draft behind and approving it sends the usual message.
   */
  planText?: string;
}

interface Stored extends AskDraft {
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Safari in modalità privata, o un contesto senza storage: la bozza non si
    // salva, ma il pannello deve funzionare lo stesso.
    return null;
  }
}

const keyOf = (toolCallId: string) => `${PREFIX}${toolCallId}`;

/** La bozza di questa domanda, o `null` se non ce n'è (o è scaduta). */
export function readAskDraft(toolCallId: string, now = Date.now()): AskDraft | null {
  const s = storage();
  if (!s || !toolCallId) return null;
  const raw = s.getItem(keyOf(toolCallId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt === 'number' && now - parsed.savedAt > MAX_AGE_MS) {
      s.removeItem(keyOf(toolCallId));
      return null;
    }
    const { savedAt: _savedAt, ...draft } = parsed;
    return draft;
  } catch {
    // Contenuto corrotto: si butta invece di rompere il pannello.
    s.removeItem(keyOf(toolCallId));
    return null;
  }
}

/**
 * Salva la bozza. Una bozza VUOTA cancella invece di scrivere: deselezionare
 * tutto e svuotare il campo è un modo di dire «lascia perdere», e ritrovarsi
 * comunque un record a occupare storage sarebbe rumore.
 */
export function writeAskDraft(toolCallId: string, draft: AskDraft, now = Date.now()): void {
  const s = storage();
  if (!s || !toolCallId) return;
  if (isEmptyDraft(draft)) { s.removeItem(keyOf(toolCallId)); return; }
  try {
    s.setItem(keyOf(toolCallId), JSON.stringify({ ...draft, savedAt: now } satisfies Stored));
  } catch {
    // Quota piena: si passa oltre. Perdere la bozza è meglio che far esplodere
    // il pannello mentre l'umano ci sta scrivendo dentro.
  }
}

/** La domanda ha avuto risposta: la bozza non serve più. */
export function clearAskDraft(toolCallId: string): void {
  const s = storage();
  if (!s || !toolCallId) return;
  s.removeItem(keyOf(toolCallId));
}

/** Niente di scelto e niente di scritto: `step` da solo non è una bozza. */
export function isEmptyDraft(d: AskDraft): boolean {
  const hasSelections = !!d.selections && Object.values(d.selections).some((v) => v.length > 0);
  const hasOther = !!d.otherText && Object.values(d.otherText).some((v) => v.trim().length > 0);
  const hasValues = !!d.values && Object.keys(d.values).length > 0;
  return !hasSelections && !hasOther && !hasValues && !d.text?.trim() && !d.jsonText?.trim()
    && !d.planText?.trim();
}

/**
 * Toglie le bozze scadute. Chiamata all'avvio: le domande a cui non si è mai
 * risposto non hanno nessun altro momento in cui essere ripulite.
 */
export function sweepAskDrafts(now = Date.now()): number {
  const s = storage();
  if (!s) return 0;
  const dead: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(s.getItem(k) ?? 'null') as Stored | null;
      if (!parsed || typeof parsed.savedAt !== 'number' || now - parsed.savedAt > MAX_AGE_MS) dead.push(k);
    } catch {
      dead.push(k);
    }
  }
  for (const k of dead) s.removeItem(k);
  return dead.length;
}
