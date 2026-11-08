/**
 * GLI ALLEGATI DI UNA BOZZA SOPRAVVIVONO A UN RICARICAMENTO.
 *
 * IL DIFETTO CHE CHIUDE. Il testo non spedito di una chat sta in
 * `localStorage` (`draft:<topicId>`, vedi `ChatPane`), e torna dopo un F5. Gli
 * allegati no: `pendingFiles` e `pendingImages` erano due `useState`, cioe'
 * memoria e basta. Il risultato non assomiglia a una perdita, ed e' la ragione
 * per cui e' rimasto: dopo il ricaricamento la frase c'e' ancora, quindi si
 * preme Invio e si spedisce «guarda questo screenshot» senza screenshot.
 *
 * Che perderli fosse un danno il progetto lo diceva gia': `usePaneHold` tiene
 * montata la pane finche' ci sono allegati in attesa, proprio per non buttarli
 * quando il tetto di residenza sfratta le pane. Mancava solo la stessa
 * protezione contro il ricaricamento.
 *
 * PERCHE' IndexedDB E NON localStorage. Un allegato e' un blob: un file scelto
 * col dito puo' pesare decine di MB, e `localStorage` ha ~5 MB PER ORIGINE
 * condivisi con le bozze, la cache dei messaggi, le preferenze e il pane-store.
 * Riempirlo con un allegato non avrebbe salvato l'allegato: avrebbe rotto tutto
 * il resto, e in silenzio (`QuotaExceededError` dentro un `catch {}`).
 * IndexedDB e' fatto per i blob e ha una quota di un altro ordine.
 *
 * PERCHE' IL PERCORSO DI INVIO NON CAMBIA. Al ritorno i file vengono
 * ricostruiti come veri `File`, quindi `handleSendMessage` riceve esattamente
 * cio' che riceveva prima e non sa che c'e' stato un ricaricamento in mezzo.
 * L'alternativa (caricare sul server al momento dell'aggancio e tenere il
 * percorso) avrebbe toccato il cammino piu' delicato dell'app per un difetto
 * che non sta li'.
 *
 * FALLISCE MORBIDO, SEMPRE. Senza IndexedDB (Safari in privata, contesti
 * ristretti) ogni funzione qui e' un no-op e il comportamento torna quello di
 * prima: un allegato perso e' brutto, una chat che non si apre e' rotta.
 */

const DB = 'topics-drafts';
const STORE = 'attachments';
const VERSION = 1;

/** Il tetto oltre il quale non si tiene: vedi `saveDraftAttachments`. */
export const DRAFT_ATTACHMENT_CAP_BYTES = 32 * 1024 * 1024;

export interface DraftImage {
  dataUrl: string;
  mimeType: string;
}

interface StoredFile {
  name: string;
  type: string;
  lastModified: number;
  buf: ArrayBuffer;
}

interface StoredDraft {
  images: DraftImage[];
  files: StoredFile[];
}

export interface DraftAttachments {
  images: DraftImage[];
  files: File[];
}

const EMPTY: DraftAttachments = { images: [], files: [] };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Un altro tab che tiene aperta una versione vecchia bloccherebbe qui per
      // sempre: meglio rispondere «non disponibile» e comportarsi come prima.
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(STORE, mode);
          const req = fn(t.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          t.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/** La chiave: la stessa identita' con cui `ChatPane` conserva il testo. */
export function draftAttachmentsKey(topicId: string): string {
  return `draft-attachments:${topicId}`;
}

/**
 * Scrive gli allegati in attesa. Un elenco vuoto CANCELLA la riga invece di
 * scriverne una vuota: cosi' il deposito non accumula una voce per ogni chat
 * mai usata, e `loadDraftAttachments` non deve distinguere «vuoto» da «assente».
 *
 * Oltre `DRAFT_ATTACHMENT_CAP_BYTES` non si salva NIENTE per quella bozza, e la
 * funzione lo DICE al chiamante (`false`) invece di troncare in silenzio: un
 * allegato tenuto a meta' e' peggio di uno dichiarato assente.
 */
export async function saveDraftAttachments(
  topicId: string,
  images: DraftImage[],
  files: File[],
): Promise<boolean> {
  const key = draftAttachmentsKey(topicId);
  if (images.length === 0 && files.length === 0) {
    await tx('readwrite', (s) => s.delete(key));
    return true;
  }
  const peso =
    images.reduce((n, i) => n + i.dataUrl.length, 0) + files.reduce((n, f) => n + f.size, 0);
  if (peso > DRAFT_ATTACHMENT_CAP_BYTES) {
    await tx('readwrite', (s) => s.delete(key));
    return false;
  }
  const stored: StoredFile[] = [];
  for (const f of files) {
    try {
      stored.push({ name: f.name, type: f.type, lastModified: f.lastModified, buf: await f.arrayBuffer() });
    } catch {
      // Un file il cui handle non e' piu' leggibile (spostato, permesso
      // revocato): si tengono gli altri.
    }
  }
  const payload: StoredDraft = { images, files: stored };
  const ok = await tx('readwrite', (s) => s.put(payload, key));
  return ok !== null;
}

/**
 * Rilegge gli allegati di una bozza. `File` veri, non surrogati.
 *
 * Non c'e' una `clear...()` esplicita, e non e' una dimenticanza: dopo l'invio
 * `ChatPane` svuota `pendingFiles`/`pendingImages`, l'effetto di salvataggio
 * riparte con due elenchi vuoti e `saveDraftAttachments` cancella la riga. Un
 * secondo cammino per la stessa cosa vorrebbe dire due posti in cui
 * dimenticarsi di chiamarlo.
 */
export async function loadDraftAttachments(topicId: string): Promise<DraftAttachments> {
  const raw = (await tx<StoredDraft>('readonly', (s) => s.get(draftAttachmentsKey(topicId)))) as
    | StoredDraft
    | null
    | undefined;
  if (!raw) return EMPTY;
  const files: File[] = [];
  for (const f of raw.files ?? []) {
    try {
      files.push(new File([f.buf], f.name, { type: f.type, lastModified: f.lastModified }));
    } catch {
      // ignora la singola voce illeggibile
    }
  }
  return { images: raw.images ?? [], files };
}
