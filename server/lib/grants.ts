/**
 * grants — soggetto → concessione → risorsa. La parte pura.
 *
 * UN modello, non uno per tipo di cosa condivisa. Aggiungere le chat non deve
 * voler dire aggiungere una tabella, e aggiungere le persone non deve voler dire
 * raddoppiarle tutte: cinque tabelle che divergono sono il modo in cui
 * «condivisione ovunque» diventa cinque comportamenti diversi.
 *
 * COSA È CONDIVISIBILE, e perché non è una scelta di gusto. Una risorsa deve
 * avere una riga vera a cui appendere il permesso. `task` e `topic` ce l'hanno.
 * Spazi e tab NO: vivono dentro un blob JSON da ~56 KB in una riga sola di
 * `ui_state`, che si riscrive tutto intero con un CAS su `server_seq`. Non c'è
 * un «questo» da indicare, non c'è una FK per la cascata, e non è filtrabile né
 * in lettura né in scrittura — si può solo consegnare o negare tutto. Condividere
 * un gruppo oggi non sarebbe un permesso, sarebbe un export. Vanno promossi a
 * righe PRIMA, ed è lavoro di fondamenta, non una voce in un enum.
 */

/** Chi riceve. Oggi uno solo: è l'unica identità che esiste. */
export type SubjectType = 'device';

/** Cosa si riceve. Le due entità che hanno una riga a cui appendere il permesso. */
export type ResourceType = 'task' | 'topic';

/**
 * Cosa può fare. Solo lettura, e non per prudenza generica: un ospite che scrive
 * in un thread o dispaccia un agente tocca terminali, file e chiavi — è una
 * superficie diversa, e va progettata quando il caso esisterà davvero.
 */
export type GrantLevel = 'read';

export interface Grant {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
  /** Da dove viene: `null` = concessa a mano, valorizzata = derivata da un
   *  contenitore. È ciò che rende rispondibile «perché costui vede questa cosa?»
   *  e che permette di togliere in blocco ciò che un contenitore aveva dato
   *  senza toccare le concessioni esplicite. */
  viaType: string | null;
  viaId: string | null;
  grantedAt: number;
}

export const RESOURCE_TYPES: readonly ResourceType[] = ['task', 'topic'] as const;

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * I percorsi HTTP che un OSPITE può toccare, dedotti dalle risorse concesse.
 *
 * Allowlist e non lista di divieti: un elenco di cose vietate sopra un default
 * permissivo è la forma in cui i buchi si nascondono. Misurato mentre costruivo
 * la 082 — col filtro messo nel router dei task, un ospite leggeva `/api/topics`
 * per intero. Il router giusto non era uno: era il gate.
 */
export function isGuestAllowedPath(pathname: string): boolean {
  return (
    pathname === '/api/all-boards/tasks' ||
    pathname.startsWith('/api/tasks/') ||
    // Le chat condivise, SOLO per id: il gate confronta l'id nel percorso con le
    // concessioni. La LISTA `/api/topics` NON è qui, ed è la correzione di un
    // buco che avevo appena aperto: un endpoint che restituisce un INSIEME non è
    // filtrabile da un gate, che vede il percorso e non il corpo — misurato,
    // rispondeva 200 con tutte le chat. Un ospite scopre cosa ha da
    // `/api/auth/shared`, che per costruzione può restituire solo ciò che gli è
    // stato concesso.
    pathname.startsWith('/api/topics/') ||
    pathname.startsWith('/api/messages/') ||
    pathname === '/api/auth/shared' ||
    pathname === '/api/auth/session' ||
    pathname === '/api/auth/logout' ||
    pathname.startsWith('/media/') ||
    // Gli aggiornamenti dal vivo. Il socket è concesso, ma ciò che ci viaggia
    // dentro è filtrato per TIPO di frame — vedi `isGuestSafeFrame`.
    pathname === '/ws'
  );
}

/**
 * I tipi di frame WebSocket che un ospite può ricevere.
 *
 * Perché un'allowlist per TIPO e non un filtro per contenuto: `broadcastToAll`
 * (server/utils.ts) manda a ogni socket connessa, e dei ~91 tipi di frame del
 * registro solo 39 portano un id di entità. Un filtro che si affida all'id
 * lascerebbe passare i 52 che non ne hanno — stato dei progetti, git, presenza,
 * capacità di dispatch — cioè esattamente ciò che un ospite non deve vedere.
 *
 * Quindi: si nomina ciò che serve, e tutto il resto non parte. Il costo è che un
 * frame nuovo non arriva agli ospiti finché qualcuno non lo aggiunge qui — ed è
 * il verso giusto in cui sbagliare: un aggiornamento mancante si nota e si
 * corregge, una fuga no.
 *
 * Chi passa di qui è comunque soggetto al controllo sull'ENTITÀ: questa funzione
 * dice «di questo tipo di frame ci si può fidare SE l'entità è concessa», non
 * «questo frame si può mandare».
 */
const GUEST_SAFE_FRAMES = new Set<string>([
  // Le schede. Tutti e cinque portano `taskId`, verificato contro il registro —
  // e non è un dettaglio: due nomi che avevo scritto a memoria (`task:comment`,
  // `stream:delta`) NON esistono, e un tipo inventato qui non è un errore
  // rumoroso, è un aggiornamento che non arriva mai e nessuno capisce perché.
  'task:created',
  'task:updated',
  'task:deleted',
  'task:review-ready',
  'task:parked',
  // Le chat condivise: apertura, testo che scorre, chiusura, e i messaggi
  // interi. Tutti portano `topicId`.
  'stream:start',
  'stream:content_chunk',
  'stream:end',
  'message',
  'message:new',
]);

export function isGuestSafeFrameType(type: string): boolean {
  return GUEST_SAFE_FRAMES.has(type);
}

/**
 * L'entità a cui un frame appartiene, se dichiarata. `null` = il frame non parla
 * di una risorsa condivisibile, e per un ospite quindi non parte affatto.
 *
 * Legge i campi che il registro usa già (`taskId`, `topicId`), senza aggiungere
 * un campo nuovo a 91 schemi: un campo obbligatorio su tutti sarebbe una
 * migrazione del protocollo per un caso che riguarda pochi tipi.
 */
export function frameResource(frame: unknown): { type: ResourceType; id: string } | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  if (typeof f.taskId === 'string' && f.taskId) return { type: 'task', id: f.taskId };
  if (typeof f.topicId === 'string' && f.topicId) return { type: 'topic', id: f.topicId };
  return null;
}
