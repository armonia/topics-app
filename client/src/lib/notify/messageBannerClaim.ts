/**
 * Una consegna per MESSAGGIO, non una per finestra.
 *
 * Il banner di `message:new` nasce da un frame che il server manda in BROADCAST:
 * ogni finestra connessa lo riceve. Finché la decisione di bannerizzare era
 * locale, un messaggio solo produceva tanti banner quante erano le finestre —
 * e con i gruppi staccati (una finestra per gruppo) è la normalità, non il caso
 * limite. Nessun gate poteva risolverlo: sono tutti veri contemporaneamente in
 * tutte le finestre.
 *
 * Serve un fatto CONDIVISO: chi arriva primo su un dato `messageId` si prende la
 * consegna, gli altri tacciono. Il registro sta in `localStorage`, che nel
 * guscio è unico per origine e quindi visto da tutte le finestre (è lo stesso
 * canale su cui già viaggia il pane-store, vedi state/pane/middleware).
 *
 * ── Perché una lettura di ritorno, e perché basta ──────────────────────────
 * `localStorage` non offre un compare-and-swap: due finestre possono leggere
 * "libero" e scrivere entrambe. La sequenza cattiva è però auto-risolvente se
 * dopo aver scritto si RILEGGE:
 *
 *     A legge []            B legge []
 *     A scrive [X:A]        B scrive [X:B]      ← l'ultima scrittura vince
 *     A rilegge → X:B  ✗    B rilegge → X:B  ✓
 *
 * Un vincitore solo, chiunque scriva per ultimo. La rilettura non è una
 * pignoleria: senza, entrambe crederebbero di aver vinto.
 *
 * Resta scoperta una sola forma: una TERZA finestra che scrive per un messaggio
 * DIVERSO esattamente tra la nostra scrittura e la nostra rilettura, cancellando
 * la nostra riga da uno snapshot più vecchio. Lì la rilettura non trova nessuno
 * sulla chiave, e allora si consegna (vedi sotto: in dubbio si suona). Per
 * chiuderla del tutto la claim gira dentro un lock esclusivo `navigator.locks`
 * quando c'è — cioè in ogni WebView moderna, WKWebView compresa.
 *
 * ── In dubbio si suona ─────────────────────────────────────────────────────
 * Ogni fallimento dello storage (private mode, quota, JSON rotto) restituisce
 * `true`: un banner in più è un fastidio, un banner perso è un messaggio che non
 * hai visto. È la stessa dottrina di `muteGate.ts`.
 */

/** La chiave del registro in localStorage. Esportata per i test e per chi
 *  dovesse ripulirla a mano. */
export const BANNER_CLAIM_KEY = 'topics:msg-banner-claims-v1';

/** Il nome del lock esclusivo (Web Locks) che serializza le claim. */
export const BANNER_CLAIM_LOCK = 'topics:msg-banner-claim';

/**
 * Quanto resta memoria di un messaggio già consegnato. Non è una cooldown: è la
 * finestra entro cui un frame ri-annunciato (riconnessione, bootstrap che
 * rigioca lo snapshot) non deve poter ri-bannerizzare. Cinque minuti coprono
 * abbondantemente una riconnessione senza tenere in vita un registro infinito.
 */
const TTL_MS = 5 * 60_000;

/** Tetto di righe: il registro è un anello, le più vecchie cadono. */
const MAX_ENTRIES = 200;

/** Una consegna già assegnata: `k` chiave del messaggio, `c` chi l'ha presa,
 *  `t` quando. Nomi corti di proposito — questo oggetto viene serializzato
 *  centinaia di volte in un registro che vive in localStorage. */
export interface ClaimEntry {
  k: string;
  c: string;
  t: number;
}

/** La sola parte di `Storage` che ci serve — così i test la possono falsificare
 *  senza inventarsi un `localStorage` intero. */
export interface ClaimStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Legge il registro e butta via ciò che è scaduto. Tollera qualunque schifezza
 * (JSON rotto, forma sbagliata, righe senza campi) restituendo un registro
 * vuoto: un registro illeggibile è un registro senza claim, non un errore da
 * propagare.
 */
export function parseLedger(raw: string | null, now: number): ClaimEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClaimEntry[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const e = row as Partial<ClaimEntry>;
    if (typeof e.k !== 'string' || typeof e.c !== 'string' || typeof e.t !== 'number') continue;
    // Scaduta. `now - e.t` negativo (orologio spostato all'indietro) NON è
    // scaduta: si tiene, così un salto d'ora non riapre le consegne già fatte.
    if (now - e.t > TTL_MS) continue;
    out.push({ k: e.k, c: e.c, t: e.t });
  }
  return out;
}

/**
 * Prova a prendersi la consegna di `key`. `true` = tocca a te bannerizzare.
 *
 * Sincrona e senza dipendenze globali: è il cuore testabile. Il chiamante vero è
 * `claimMessageBanner`, che ci mette attorno il `localStorage` e il lock.
 */
export function claimBannerIn(
  storage: ClaimStorage,
  key: string,
  claimant: string,
  now: number,
): boolean {
  let entries: ClaimEntry[];
  try {
    entries = parseLedger(storage.getItem(BANNER_CLAIM_KEY), now);
  } catch {
    return true; // storage illeggibile → in dubbio si suona
  }

  // Già assegnata. Che sia a noi o ad altri non cambia la risposta: la seconda
  // consegna dello stesso messaggio è esattamente ciò che stiamo togliendo.
  if (entries.some((e) => e.k === key)) return false;

  const next = [...entries, { k: key, c: claimant, t: now }].slice(-MAX_ENTRIES);
  try {
    storage.setItem(BANNER_CLAIM_KEY, JSON.stringify(next));
  } catch {
    return true; // quota / private mode → in dubbio si suona
  }

  // La lettura di ritorno: vedi il commento in testa al file. Se sulla chiave
  // c'è il nome di un altro, ha vinto lui. Se non c'è NESSUNO, la nostra riga è
  // stata cancellata da uno scrittore che stava reclamando un messaggio diverso
  // — cioè su QUESTA chiave non c'è concorrenza, e si consegna.
  let after: ClaimEntry[];
  try {
    after = parseLedger(storage.getItem(BANNER_CLAIM_KEY), now);
  } catch {
    return true;
  }
  const winner = after.find((e) => e.k === key);
  return winner ? winner.c === claimant : true;
}

/**
 * La chiave su cui si claima un `message:new`.
 *
 * `messageId` è il nome giusto e il server lo manda; il ripiego serve alle
 * emissioni vecchie che non ce l'hanno (il campo è opzionale sul filo, vedi
 * `WSMessageNewMessage`). Senza ripiego una finestra che riceve un frame legacy
 * non claimerebbe niente e tornerebbero N banner — cioè il bug, ma solo contro i
 * server vecchi: il posto peggiore in cui lasciarlo, perché non si vede in
 * sviluppo. Corpo tagliato a 120 caratteri: abbastanza da distinguere due
 * messaggi diversi, poco abbastanza da non gonfiare il registro.
 */
export function bannerClaimKey(msg: {
  messageId?: string;
  topicId: string;
  role: string;
  content?: string;
  preview?: string;
}): string {
  if (msg.messageId) return msg.messageId;
  return `${msg.topicId}:${msg.role}:${(msg.content ?? msg.preview ?? '').slice(0, 120)}`;
}

/**
 * Chi sta claimando: l'id di QUESTA finestra.
 *
 * È lo stesso `topics-window-id` che la presenza cross-finestra usa come
 * identità (`state/windowPresence.ts`), e sta in `sessionStorage` — che a
 * differenza di `localStorage` è per-finestra, cioè esattamente la granularità
 * che serve qui. Il ripiego casuale copre la finestra che claima prima che
 * `useSidebarAndLayout` abbia allocato l'id: un nome purché sia UNICO, che è
 * l'unica proprietà che una claim gli chiede.
 */
let fallbackClaimant = '';
export function bannerClaimant(): string {
  try {
    const id = sessionStorage.getItem('topics-window-id');
    if (id) return id;
  } catch {
    /* sessionStorage negato — si scende sul ripiego */
  }
  if (!fallbackClaimant) {
    fallbackClaimant = `win-${Math.random().toString(36).slice(2, 10)}`;
  }
  return fallbackClaimant;
}

/** Il `localStorage` vero, o null dove non c'è (SSR, test, storage bloccato). */
function sharedStorage(): ClaimStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // accesso allo storage negato dalle impostazioni del browser
  }
}

/** `navigator.locks`, se questa piattaforma ce l'ha. Tipizzato in stretto:
 *  `lib.dom` non porta `LockManager` in ogni versione di TS che compila questo
 *  client, e allargare la firma qui è meno invasivo di un'ambient global. */
type LockRequest = (
  name: string,
  options: { mode: 'exclusive' },
  cb: () => boolean,
) => Promise<boolean>;

function lockRequest(): LockRequest | null {
  try {
    const locks = (navigator as unknown as { locks?: { request?: unknown } }).locks;
    if (locks && typeof locks.request === 'function') return locks.request.bind(locks) as LockRequest;
  } catch {
    /* navigator assente o inaccessibile */
  }
  return null;
}

/**
 * Prova a prendersi la consegna del banner per questo messaggio, davanti a tutte
 * le altre finestre. `true` = bannerizza tu.
 *
 * Asincrona perché il lock lo è; il chiamante valuta PRIMA tutti i suoi gate
 * sincroni e claima per ultimo, così una finestra che comunque tacerebbe non si
 * mangia la consegna di una che invece parlerebbe.
 *
 * Senza storage condiviso (web in private mode, ambiente di test) risponde
 * sempre `true`: senza un fatto condiviso non c'è dedup possibile, e il peggio
 * che può capitare è il comportamento di prima.
 */
export async function claimMessageBanner(
  key: string,
  claimant: string,
  now: number = Date.now(),
): Promise<boolean> {
  const storage = sharedStorage();
  if (!storage) return true;
  const run = (): boolean => claimBannerIn(storage, key, claimant, now);

  const request = lockRequest();
  if (request) {
    try {
      return await request(BANNER_CLAIM_LOCK, { mode: 'exclusive' }, run);
    } catch {
      // Lock non concedibile (contesto senza permessi, implementazione
      // parziale): si ricade sulla claim nuda, che è comunque corretta a due
      // finestre — vedi la lettura di ritorno.
    }
  }
  return run();
}

/** Solo per i test: svuota il registro condiviso. */
export function __resetBannerClaimsForTests(): void {
  const storage = sharedStorage();
  if (!storage) return;
  try {
    storage.setItem(BANNER_CLAIM_KEY, '[]');
  } catch {
    /* niente da azzerare */
  }
}
