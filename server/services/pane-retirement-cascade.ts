/**
 * Chiudere una tab E' il ritiro di cio' che contiene — deciso lato SERVER.
 *
 * PERCHE' NON BASTA IL CLIENT. Il client gia' fa la cosa giusta quando e' lui a
 * chiudere: `handleClosePanel` archivia la chat, `handleCloseTerminal` fa la
 * DELETE della sessione. Il guasto non e' li'. Il guasto e' in tutte le volte
 * che quelle chiamate non partono o non arrivano: la tab chiusa su un altro
 * dispositivo (il tombstone si propaga, la DELETE no — e' stata fatta li'), la
 * `keepalive` persa in un `pagehide`, la finestra chiusa mentre la fetch era in
 * volo, il percorso di progetto che passa da `useProjectLayout`. In tutti
 * questi casi il tombstone — che E' sincronizzato — arriva al server, e la
 * conseguenza no. Da qui: 11 sessioni vive per tab chiuse a luglio.
 *
 * QUINDI: il tombstone e' il segnale, e il server ne trae le conseguenze.
 *
 * PERCHE' IL TOMBSTONE E NON «la pane non c'e' piu'». Lo snapshot di un
 * dispositivo non e' l'insieme di tutte le pane: l'idratazione e' un'UNIONE, e
 * un telefono che non ha mai saputo di una pane la manda assente senza che
 * nessuno l'abbia chiusa. Assenza non e' chiusura. Un tombstone e' un gesto:
 * qualcuno ha chiuso quella tab, con una data. E' la stessa regola con cui il
 * client decide di togliere una pane in idratazione, applicata dallo stesso
 * lato del filo del fatto.
 *
 * PURO. Qui non si tocca il database: si legge il prima e il dopo e si dice
 * COSA va ritirato. La decisione e' la parte che va provata; applicarla e' una
 * riga di SQL.
 */

/** Cosa conteneva una tab chiusa. Tutti opzionali: una pane utility non contiene niente. */
export interface PaneContents {
  topicId?: string;
  terminalSessionId?: string;
}

export interface PaneRetirement extends PaneContents {
  paneId: string;
  /** ms-epoch del tombstone (`at`), gia' normalizzato dal client. */
  closedAt: number;
}

export interface CascadeInput {
  /** Il valore di `pane-store-v2` come il server lo aveva (o null: prima scrittura). */
  prev: unknown;
  /** Il valore in arrivo. */
  next: unknown;
  /** Le pane per cui il fatto ha gia' una riga: non si riprocessano. */
  alreadyRetired: ReadonlySet<string>;
}

export interface PaneReopen extends PaneContents {
  paneId: string;
}

export interface CascadeResult {
  /** Da ritirare adesso, contenuto incluso. */
  retire: PaneRetirement[];
  /** Pane il cui ritiro va ritrattato: sono tornate vive e senza tombstone. */
  reopen: PaneReopen[];
}

interface RawPane {
  id?: unknown;
  topicId?: unknown;
  terminalSessionId?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `{at, seq}` oppure il numero nudo della forma legacy. Vedi `TombstoneMark`. */
function tombstoneAt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const o = asRecord(raw);
  if (o && typeof o.at === "number" && Number.isFinite(o.at)) return o.at;
  return null;
}

function paneContents(raw: unknown): PaneContents {
  const p = asRecord(raw) as RawPane | null;
  if (!p) return {};
  const out: PaneContents = {};
  if (typeof p.topicId === "string" && p.topicId) out.topicId = p.topicId;
  if (typeof p.terminalSessionId === "string" && p.terminalSessionId) out.terminalSessionId = p.terminalSessionId;
  return out;
}

/**
 * Cosa conteneva la pane `id`, cercandolo dove puo' essere sopravvissuto.
 *
 * L'ordine non e' indifferente. Il record di `closedStack` e' il verbale della
 * chiusura — porta il contenuto COME ERA nell'istante in cui e' stata chiusa, e
 * in piu' i metadati del terminale (`terminal.sessionId`) che la pane nuda non
 * ha sempre. Lo snapshot precedente e' il ripiego: `closedStack` e' limitato a
 * 50 voci, quindi dopo cinquanta chiusure il verbale piu' vecchio non c'e' piu'
 * mentre il tombstone (che e' capato molto piu' in alto) resta. Cercare in un
 * posto solo avrebbe perso una delle due meta'.
 */
function findContents(id: string, next: Record<string, unknown> | null, prev: Record<string, unknown> | null): PaneContents {
  const stack = next && Array.isArray(next.closedStack) ? (next.closedStack as unknown[]) : [];
  for (const rec of stack) {
    const r = asRecord(rec);
    if (!r || r.id !== id) continue;
    const out: PaneContents = { ...paneContents(r.pane) };
    if (!out.topicId && typeof r.topicId === "string" && r.topicId) out.topicId = r.topicId;
    const term = asRecord(r.terminal);
    if (!out.terminalSessionId && term && typeof term.sessionId === "string" && term.sessionId) {
      out.terminalSessionId = term.sessionId;
    }
    return out;
  }
  const prevPanes = prev ? asRecord(prev.panes) : null;
  if (prevPanes && id in prevPanes) return paneContents(prevPanes[id]);
  return {};
}

/**
 * Le conseguenze di uno snapshot in arrivo.
 *
 * La ritrattazione (`reopen`) guarda due cose insieme: la pane e' VIVA nello
 * snapshot in arrivo E non porta piu' un tombstone. Sono le due condizioni con
 * cui il client stesso decide che una pane e' aperta (l'annulla-chiusura
 * cancella il marcatore), quindi qui non si sta indovinando: si sta leggendo la
 * sua decisione. Serve perche' senza, la riga di ritiro resterebbe come una
 * lapide e la chiusura SUCCESSIVA della stessa pane non avrebbe conseguenze —
 * la guardia di idempotenza si mangerebbe il gesto vero.
 *
 * Il rientro RIPORTA il contenuto, e non e' un lusso: senza, il ritiro del
 * TOPIC resterebbe timbrato mentre la sua chat e' di nuovo sullo schermo, e il
 * riconcilio al riavvio successivo la richiuderebbe con l'utente dentro. Il
 * contenuto qui non si indovina — si legge dalla pane VIVA, che e' la stessa
 * autorita' con cui la si era ritirata.
 *
 * Ritrattare NON rianima niente: dice solo «questo non risulta piu' chiuso».
 * Una chat riaperta si disarchivia per la sua strada, una tab di terminale
 * riaperta nasce con una sessione nuova.
 */
export function computeCascade(input: CascadeInput): CascadeResult {
  const next = asRecord(input.next);
  const prev = asRecord(input.prev);
  if (!next) return { retire: [], reopen: [] };

  const tombs = asRecord(next.tombstones) ?? {};
  const panes = asRecord(next.panes) ?? {};

  const retire: PaneRetirement[] = [];
  for (const [id, mark] of Object.entries(tombs)) {
    if (input.alreadyRetired.has(id)) continue;
    const at = tombstoneAt(mark);
    if (at === null) continue;
    // Un tombstone su una pane che lo snapshot mostra ancora VIVA e' uno stato
    // di transito (il client sta per applicare la sua stessa strip, o due
    // dispositivi si stanno ancora accordando): non e' il momento di uccidere
    // niente. Lo si vedra' al PUT successivo, quando la pane sara' sparita.
    if (id in panes) continue;
    retire.push({ paneId: id, closedAt: at, ...findContents(id, next, prev) });
  }

  const reopen: PaneReopen[] = [];
  for (const id of input.alreadyRetired) {
    if (!(id in panes)) continue;
    if (tombstoneAt(tombs[id]) !== null) continue;
    reopen.push({ paneId: id, ...paneContents(panes[id]) });
  }

  return { retire, reopen };
}
