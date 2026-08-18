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

/** Cosa si riceve. Le due entità che hanno una riga a cui appendere il permesso. */
export type ResourceType = 'task' | 'topic' | 'project';

/*
 * IL SOGGETTO E IL LIVELLO NON STANNO QUI, e l'assenza è deliberata.
 *
 * Fino alla 084 questo file dichiarava anche `SubjectType = 'device'`,
 * `GrantLevel = 'read'` e la riga intera (`interface Grant`). La 084 ha
 * RICOSTRUITO la tabella allargando entrambi i CHECK — il soggetto ammette ora
 * device, person e org; il livello, read e deny — e ha messo le union nuove
 * accanto a chi legge e scrive davvero le righe:
 * `SubjectKind`, `GrantLevel` e `GrantRow` in `grants-query.ts`, l'unica porta
 * da cui si interroga `grants`.
 *
 * Le tre dichiarazioni rimaste qui non erano quindi soltanto inutilizzate: erano
 * la copia VECCHIA di un'union che il DB aveva già superato, cioè esattamente la
 * deriva CHECK↔TypeScript che il commento della 083 raccomanda di non ripetere.
 * Tiparci sopra un grant avrebbe RIFIUTATO le righe `person`/`org` e `deny` che
 * esistono davvero. La forma viva è `GrantRow` (lettura) e `putGrant` (scrittura),
 * entrambe in `grants-query.ts`; nessun grant viaggia come oggetto non tipizzato.
 *
 * `ResourceType` resta qui perché è la sola delle tre che non è cambiata, ed è
 * quella che questo modulo usa per decidere (`isResourceType`, `frameResource`).
 *
 * I CHECK sopra sono descritti a parole e non copiati come SQL di proposito:
 * `tests/unit/single-door.test.ts` tratta il nome della colonna del soggetto
 * come sentinella — se compare in un file che non sia `grants-query.ts`,
 * qualcuno sta interrogando `grants` da una seconda porta. La sentinella non
 * sa distinguere un commento da una query, e ha ragione a non provarci: il
 * costo è riscrivere una riga come questa, il ricavo è che la porta resta una.
 */

/**
 * `project` è entrato con 20260816230500: condividerne uno apre i suoi task
 * senza scrivere una riga per ciascuno (espansione in lettura, vedi
 * `grants-query.ts`).
 *
 * NON allarga cosa un ospite può TOCCARE: `isGuestAllowedPath` è un'allowlist
 * di percorsi, e non esiste `/api/projects/`. Un progetto condiviso si vede
 * attraverso i suoi task, che passano dai percorsi già aperti e dal loro
 * controllo per id. Il giorno che una rotta di progetto esistesse, questo
 * commento è il posto in cui accorgersene.
 */
export const RESOURCE_TYPES: readonly ResourceType[] = ['task', 'topic', 'project'] as const;

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
 * Un ospite può usare QUESTO metodo su questo percorso?
 *
 * L'allowlist dei percorsi apre la strada, il controllo sull'entità dice quale
 * stanza — e mancava il terzo: cosa ci si può FARE dentro. Senza, `level='read'`
 * era una parola nello schema e nel tipo che nessuno faceva valere: un ospite a
 * cui avevi condiviso una scheda poteva modificarla (`PATCH /api/tasks/:id`),
 * commentarla o cancellarla, perché il gate autorizzava il sostantivo e mai il
 * verbo. La vista dell'ospite dichiara «sola lettura» in fondo alla pagina; da
 * qui in poi è vero anche fuori dalla pagina.
 *
 * L'unica eccezione è uscire. È una POST, e negarla vorrebbe dire che l'unico
 * modo per un ospite di andarsene è che qualcun altro lo revochi.
 */
export function isGuestAllowedMethod(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  return pathname === '/api/auth/logout';
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
  // Il recupero a metà turno. Manca**va**, ed è la mancanza che pesava di più:
  // il catch-up porta `content` e `blocks`, cioè il TESTO, non un id. Senza
  // questo nome nella lista un ospite non lo riceve nemmeno per una chat che
  // gli è stata condivisa — e prima che la raffica di apertura passasse dal
  // filtro lo riceveva per TUTTE.
  'stream:catchup',
  'message',
  'message:new',
]);

export function isGuestSafeFrameType(type: string): boolean {
  return GUEST_SAFE_FRAMES.has(type);
}

/**
 * I frame della STRETTA DI MANO: quelli che una socket riceve appena si apre,
 * prima di essere qualcuno, e che non portano dati di nessuno.
 *
 * Esistono perché il filtro dei broadcast, applicato alla raffica iniziale, la
 * scarterebbe TUTTA — `welcome` compreso, e senza `welcome` il client non sa
 * nemmeno con che protocollo sta parlando. Ma la lista dev'essere questa e
 * restare corta: il criterio non è «serve al client», è «non contiene niente
 * di nessuno». Un frame che porta dati e finisce qui esce dal confinamento
 * dalla porta di servizio, ed è esattamente il buco che questa lista è nata
 * per chiudere — la raffica di apertura consegnava a un ospite il pane-store
 * del proprietario, i conteggi di non-letto di ogni chat, e il contenuto vivo
 * di qualunque stream in corso.
 */
const GUEST_HANDSHAKE_FRAMES = new Set<string>([
  'connected',
  'welcome',
  // Solo una revisione di bundle: una stringa di nomi di file, uguale per
  // tutti, che dice alla finestra di ricaricarsi dopo un deploy.
  'ui:bundle-rev',
]);

export function isGuestHandshakeFrame(type: string): boolean {
  return GUEST_HANDSHAKE_FRAMES.has(type);
}

/**
 * Questa socket va confinata? Si guarda il RUOLO, non la presenza di un id.
 *
 * La distinzione ha prodotto un guasto vero, ed è il motivo per cui la regola
 * vive qui invece che scritta a mano dentro il ciclo di ogni fan-out.
 * L'upgrade timbra `deviceId` su OGNI dispositivo appaiato — proprietari
 * compresi — quindi «ha un id» era diventato sinonimo di «è un ospite». Il
 * telefono del proprietario è `owner` e non ha nessuna concessione, perché non
 * gliene serve nessuna: il filtro gli faceva quindi cadere ogni frame. A
 * scamparla era solo il loopback, e per il motivo sbagliato — id nullo, non
 * ruolo.
 *
 * Un ruolo che non riconosciamo vale OSPITE: il verso prudente è quello che
 * consegna meno, perché l'altro consegna tutto.
 */
export function isGuestSocketData(data: {
  deviceId?: string | null;
  deviceRole?: 'owner' | 'guest' | null;
}): boolean {
  if (!data.deviceId) return false;
  return data.deviceRole !== 'owner';
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
