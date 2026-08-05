// Il RESOLVER client dei permalink alle tab: UNA porta per «apri/focussa questo
// target». La grammatica sta in `shared/tab-link` (pura, la leggono anche server
// e agente); qui c'è tutto e solo ciò che è del CLIENT — l'origine su cui il
// link è apribile, il riconoscimento self-origin, e l'instradamento sul bus di
// eventi che l'app usa già.
//
// ── Perché una porta sola ────────────────────────────────────────────────────
// Aprire una tab, oggi, si fa in sei modi diversi a seconda del tipo: la chat
// passa da `topics:open-topic`, il terminale da `topics:open-terminal-pane`, il
// browser da un evento con guardia di proprietà, il file da DUE eventi in
// sequenza, i panel da `topics:open-utility`, il task dal drawer della board.
// Chi vuole «aprire un permalink» non può conoscerli tutti: li conosce questo
// modulo, e chi chiama passa un `TabTarget`.
//
// ── Cosa questo modulo NON fa ────────────────────────────────────────────────
// • Non SCRIVE nella history. L'unico scrittore resta il drawer della board
//   (`reflectTaskOpen`/`reflectTaskClose`): due riflessioni si peserebbero
//   addosso, e la seconda vincerebbe a caso. Il permalink si COPIA su richiesta
//   e si LEGGE al boot; l'unica scrittura qui è il `replaceState('/')` che
//   CONSUMA la rotta `/tab/…`, e riguarda solo quella.
// • Non INVENTA il soggetto. I rami che possono far NASCERE una pane da una
//   chiave presa dalla URL (chat, project, e il progetto ospite di file/diff)
//   chiedono prima al resolver del server se quel soggetto esiste — vedi
//   «La verifica di esistenza» più sotto. Gli altri hanno già una guardia
//   locale, e ogni ramo che non può instradare NON crea niente: avvisa e basta.
// • Non mette mai lo Spazio nella URL: `activeSpaceId` è device-local per
//   scelta. Una tab in uno Spazio non attivo si raggiunge FOCALIZZANDOLA e
//   lasciando fare all'effetto focus-follows-space (usePanelLifecycle), che fa
//   già FOCUS_PANE e poi SET_ACTIVE_SPACE nell'ordine giusto.

import {
  TAB_PANELS,
  TAB_PATH_PREFIX,
  buildTabLink,
  buildTabPath,
  parseTabPath,
  type TabTarget,
} from '../../../shared/tab-link';
import { PROJECT_PANES_PREFIX, projectPanesKey } from '../../../shared/project-keys';
import { serverHttpBase } from './shell/net';
import { isSelfOrigin, openTaskInApp, selfTaskLinkTarget, type TaskTarget } from './openTaskLink';
import { usePaneStore } from '../state/pane/store';
import { createPaneId } from '../state/pane/adapters/paneConfig';
import { utilityPanelId, type UtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import { useProjectFocusStore } from '../state/projectFocus';
import { onServerHydrated } from '../state/pane/middleware/serverHydrated';
import { isDetachedWindow } from './windowRole';

/** Il messaggio dell'unico esito negativo possibile. Uno solo, perché
 *  all'utente la differenza fra «il progetto non si è montato» e «nessuna
 *  superficie possiede questa pane» non dice nulla: in entrambi i casi il link
 *  che ha in mano non porta da nessuna parte. */
export const DEAD_TAB_MESSAGE = 'Questa tab non esiste più';

/** Detto quando la verifica non è riuscita e si apre lo stesso.
 *
 *  Perché avvisare anche qui: il caso benigno (`missing`) parlava all'utente,
 *  mentre quello che può lasciare una pane FANTASMA persistita e sincronizzata
 *  su ogni device produceva solo un `console.warn` — cioè niente, per chi usa
 *  l'app. L'asimmetria era al contrario di come dovrebbe essere. */
export const UNVERIFIED_TAB_MESSAGE =
  'Non ho potuto verificare questa tab: la apro lo stesso';

/** Quanto si aspetta prima del SECONDO tentativo di verifica.
 *
 *  La finestra tipica di indisponibilità è il ricarico del server — su questa
 *  macchina `TOPICS_SERVER_WATCH=1` lo fa a ogni salvataggio in `server/`, con
 *  2s di debounce. Un solo ritentativo dopo ~1,5s trasforma quasi tutti gli
 *  `unavailable` in una risposta VERA, senza trasformare un server davvero giù
 *  in un'attesa lunga: il tentativo è uno, non una catena. */
const VERIFY_RETRY_DELAY_MS = 1500;
let verifyRetryDelayMs = VERIFY_RETRY_DELAY_MS;

/** Solo per i test: accorcia l'attesa fra i due tentativi. */
export function __setTabLinkRetryDelayForTests(ms: number): void {
  verifyRetryDelayMs = ms;
}

/** Quanti giri di retry, e a che passo, per i target che hanno bisogno che una
 *  finestra di progetto si monti prima di poterli ricevere. ~2s complessivi:
 *  abbastanza per un mount, poco abbastanza da non inseguire l'utente che nel
 *  frattempo ha cliccato altrove. */
const RETRY_ATTEMPTS = 10;
const RETRY_INTERVAL_MS = 200;

/**
 * Entro quanto un'apertura riuscita si dichiara comunque CONCLUSA, anche se non
 * siamo riusciti a osservarla. Vedi `scheduleOpenAck`: l'ack che non arriva mai
 * è ciò che teneva accesa per 8s la ri-asserzione di boot di App.tsx, e una
 * ri-asserzione accesa RUBA il focus al primo click dell'utente.
 */
const ACK_SETTLE_MS = 2500;

/**
 * Entro quanto si instrada COMUNQUE un permalink che l'idratazione non è
 * arrivata a sbloccare (vedi `openTabInAppWhenHydrated`). Dimensionato sul
 * percorso di boot del pane-store: il fallback GET di `state/pane/bootstrap.ts`
 * parte a 500ms e, se risponde, marca idratato — questo margine gli lascia un
 * secondo intero. Oltre, vuol dire che il server non c'è (offline, primo
 * avvio): un link appeso per sempre sarebbe l'esito peggiore, quindi si apre
 * lo stesso e si accetta la corsa che c'era prima.
 */
const HYDRATE_FALLBACK_MS = 1500;

/** Lettore minimo sul canale localStorage dei layout di progetto. Iniettabile
 *  perché i pane INTERNI a un progetto non stanno nel pane-store (sono stato
 *  React device-local, persistito in `topics-project-panes-<hash>`): quello è
 *  l'unico posto leggibile sincronicamente da fuori, e nei test è una Map. */
export interface ProjectPanesReader {
  keys(): string[];
  getItem(key: string): string | null;
}

export interface OpenTabOptions {
  /**
   * Come dirlo all'utente quando il target non è instradabile. I call-site
   * React passano `useToast().warning`: questo modulo è puro e il toast è un
   * hook, quindi la notifica entra da qui invece di essere reimplementata.
   * Senza, il fallimento è muto (che è comunque meglio di una pane fantasma).
   */
  notify?: (message: string) => void;
  /**
   * Chiamato NON APPENA qualcosa è stato instradato in-app, prima di sapere se
   * l'apertura andrà a buon fine fino in fondo.
   *
   * Serve a distinguere «non ho aperto niente» da «ho aperto a metà», perché i
   * due esiti vogliono ripieghi opposti. Il ramo `file`/`diff` è l'esempio: apre
   * la finestra di progetto (primo hop, in-app) e POI ripete il secondo hop
   * finché quella finestra non è montata; se il retry si esaurisce chiama
   * `notify`. Un chiamante che usa `notify` come «allora aprilo fuori» — è il
   * caso di ChatMarkdown — si ritroverebbe la finestra di progetto aperta in-app
   * E il browser di sistema su una SECONDA copia completa di Topics, connessa
   * allo stesso WS e allo stesso pane-store. Con questo segnale il ripiego si
   * disarma appena qualcosa è partito davvero.
   */
  onRouted?: () => void;
  /** Solo per i test: accorcia il retry di mount della finestra di progetto. */
  retry?: { attempts?: number; intervalMs?: number };
  /** Solo per i test: sostituisce il lettore dei layout di progetto. */
  projectPanes?: ProjectPanesReader;
  /** Solo per i test: accorcia l'attesa dell'ack di apertura (`ACK_SETTLE_MS`). */
  settleMs?: number;
  /** Solo per i test: accorcia l'attesa dell'idratazione (`HYDRATE_FALLBACK_MS`). */
  hydrateTimeoutMs?: number;
}

// ── L'ACK: `topics:tab-opened` ───────────────────────────────────────────────

/**
 * Il `detail` di `topics:tab-opened`. Un evento solo, DUE consumatori con
 * bisogni diversi — ed è per questo che porta un campo invece di essere nudo:
 *
 * • `App.tsx` ci spegne la ri-asserzione di boot. Gli basta sapere che la corsa
 *   è finita, comunque sia finita: il vicolo cieco e il successo valgono
 *   uguale, e senza NESSUNO dei due la finestra da 8s resta accesa e ributta
 *   l'utente sul permalink a ogni click (era il caso di TUTTE le aperture
 *   riuscite: l'ack lo emetteva solo il wrapper dei fallimenti).
 * • `usePanelLifecycle` ci rilascia l'intento di focus. Qui i due casi NON
 *   valgono uguale: su un vicolo cieco l'intento va rilasciato subito (non c'è
 *   niente da tenere a fuoco), mentre su un'apertura RIUSCITA l'intento è
 *   l'unica cosa che tiene la tab a fuoco sotto la tempesta di hydrate del
 *   boot — va lasciato scadere da sé (`TAB_INTENT_TTL_MS`), non spento.
 */
export interface TabOpenedDetail {
  /** La pane su cui il target atterra (o sarebbe atterrato). Informativo. */
  paneId?: string | null;
  /** `true` = VICOLO CIECO: non c'era niente da aprire. */
  dead?: boolean;
}

/**
 * Un ack rilascia l'intento di focus? Solo se è un vicolo cieco (vedi sopra).
 * Il default prudente è SÌ: un detail vecchio o malformato vale come «morto» —
 * rilasciare un intento di troppo costa un focus non ri-asserito, tenerne uno
 * di troppo costa una tab che strattona l'utente.
 */
export function tabAckReleasesIntent(detail: unknown): boolean {
  return (detail as TabOpenedDetail | null | undefined)?.dead !== false;
}

// ── Costruzione del link ─────────────────────────────────────────────────────

/**
 * Il permalink assoluto di un target, o `null` se il target è incoerente.
 *
 * `base` è normalmente l'origine su cui il link è APRIBILE davvero:
 * `serverHttpBase() || window.location.origin`. Stessa scelta — e stesso limite
 * same-machine — di `buildTaskLink`: sul guscio Tauri la UI vive su
 * `tauri://localhost`, un'origine che non si può né aprire né incollare a
 * nessuno; `serverHttpBase()` dà il data server (`http://127.0.0.1:13333`),
 * mentre su web è `''` e si ricade sull'origine della pagina (il server vero /
 * il tunnel). Il parametro esplicito serve a chi il link lo costruisce PER un
 * altro host (e ai test, che non possono cambiare `isTauri` dopo l'import).
 */
export function buildTabLinkForTarget(target: TabTarget, base?: string): string | null {
  const origin = base ?? (serverHttpBase() || window.location.origin);
  return buildTabLink(target, origin);
}

// ── Lettura ──────────────────────────────────────────────────────────────────

/**
 * Se `url` è un permalink SELF-origin, il target che ci sta dentro; `null`
 * altrimenti — e allora chi chiama apre la URL nel browser esterno, come fa già
 * per i link dei task.
 *
 * Riconosce anche gli alias storici `/task/<id>` e `/topic/<id>` (li legge
 * `parseTabPath`), quindi è un SOVRAINSIEME di `selfTaskLinkTarget` /
 * `selfTopicLinkTarget`: chi intercetta i link può provare prima questo e
 * gestire `kind: 'task'` / `kind: 'chat'` con lo stesso ramo di sempre.
 */
export function selfTabLinkTarget(url: string): TabTarget | null {
  try {
    const u = new URL(url, window.location.origin);
    if (!isSelfOrigin(u.origin)) return null;
    return parseTabPath(u.pathname, u.search);
  } catch {
    return null;
  }
}

/** Il target codificato nella location CORRENTE, o `null`. */
export function currentTabTarget(): TabTarget | null {
  try {
    return parseTabPath(window.location.pathname, window.location.search);
  } catch {
    return null;
  }
}

// ── Apertura in-app ──────────────────────────────────────────────────────────

/** `window.dispatchEvent` che non può far saltare il chiamante. */
function emit(type: string, detail: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    /* niente DOM (test, SSR): l'instradamento semplicemente non avviene */
  }
}

/**
 * Il pane id DETERMINISTICO su cui il target atterra A LIVELLO APP, o `null` se
 * non ne ha uno.
 *
 * Serve a UNA cosa sola: armare l'intento di focus di `usePanelLifecycle`
 * (evento `topics:open-tab`, gemello di `topics:open-task`). A freddo l'ordine
 * dei fatti è impietoso — la tab si apre, poi arriva il primo hydrate del
 * pane-store e il reconcile del focus restituisce la scena alla pane che aveva
 * il focus PRIMA del reload. Con l'intento armato, quel reconcile sceglie
 * questo id finché il boot non si è calmato.
 *
 * Casi che non hanno un id, e perché va bene:
 * • una CHAT che si apre dentro una finestra di progetto atterra sulla pane del
 *   PROGETTO, e quale sia dipende dal record del topic (che qui non abbiamo):
 *   l'intento resta semplicemente senza riscontro nell'ordine dello store e non
 *   fa nulla — nessuna pane inventata;
 * • un panel fuori da TAB_PANELS non è indirizzabile, e un file senza progetto non è
 *   risolvibile: entrambi non armano niente (e non emettono niente).
 *
 * File/diff: la pane del file ha un id sorteggiato a ogni apertura, ma ciò che
 * deve restare a fuoco è la FINESTRA DI PROGETTO che la ospita — quella sì ha
 * un id deterministico.
 */
function appPaneIdForTarget(target: TabTarget): string | null {
  switch (target.kind) {
    // Il topicId NUDO: è l'id della pane a livello App (`chat:<id>` è la forma
    // interna a un progetto). Stessa regola del resolver.
    case 'chat': return target.key;
    case 'terminal': return createPaneId('terminal', target.key);
    case 'browser': return createPaneId('browser', target.key);
    case 'project': return createPaneId('project', target.key);
    case 'file':
    case 'diff': return target.projectPath ? createPaneId('project', target.projectPath) : null;
    case 'panel':
      return (TAB_PANELS as readonly string[]).includes(target.key)
        ? utilityPanelId(target.key as UtilityPanelType)
        : null;
    // Un task vive nel drawer della BOARD: la pane da tenere a fuoco è quella.
    case 'task': return utilityPanelId('board');
    default: return null;
  }
}

// ── La verifica di ESISTENZA ─────────────────────────────────────────────────
//
// Il buco che questa sezione chiude: `topics:open-topic` e `topics:open-project`
// sono eventi CREATIVI. I loro ascoltatori (usePanelLifecycle) fanno
// `ensurePaneRegistered` + `setOpenPanels` senza chiedere niente a nessuno, e da
// lì la pane finisce in `pane-store-v2`, viene PUTtata sul server e si propaga a
// TUTTI i dispositivi. L'effetto di validazione non la ripulisce: un id con
// prefisso noto (`project:`) è tenuto per definizione, e un id UUID senza record
// è tenuto OTTIMISTICAMENTE (potrebbe essere un topic ancora in caricamento) —
// e un topicId È un UUID. Risultato: una chiave inventata dentro un link (un
// `/topic/<uuid>` allucinato dal modello, il path di progetto di un'altra
// macchina) diventava una tab fantasma PERMANENTE su ogni dispositivo.
//
// ── Perché il SERVER e non una guardia locale ────────────────────────────────
// Una guardia su ciò che il client già sa non regge, in nessuna delle due
// direzioni:
//   • troppo PERMISSIVA: i topic stanno in un context React (non leggibile da un
//     modulo puro) e sono ancora in caricamento nell'istante esatto in cui un
//     permalink si apre a freddo — cioè nel caso principale passerebbe sempre;
//   • troppo SEVERA: `projectHostsPane()` / `projectFocus` sanno solo dei
//     progetti già aperti SU QUESTO DISPOSITIVO. Ma il senso di un permalink è
//     arrivare da fuori: un link a un progetto mai aperto qui è il caso
//     LEGITTIMO più comune, e una guardia locale lo rifiuterebbe.
// `GET /api/tabs/resolve` non ha né l'uno né l'altro difetto: legge le fonti
// autorevoli (topics, projects, worktrees) sul DB. Costo: una GET in sola
// lettura verso il data server, che è la STESSA macchina (loopback, SQLite
// sincrono, nessun I/O di rete) — il click non diventa lento in nessun senso
// percepibile, e l'attesa cade dopo la decisione dell'utente, non dentro
// un'animazione. È anche ciò che l'header di questo modulo prometteva già.
//
// Il ramo NEGATIVO è quello che conta: `state: 'unknown'` significa «non
// l'abbiamo trovato da nessuna parte E la fonte autorevole non risponde», che è
// esattamente il caso della chiave inventata. Limite noto e accettato: un
// soggetto cancellato che ha lasciato una pane STANTIA in `ui_state` risponde
// con lo stato di quella pane e passa la guardia — ma lì la tab fantasma
// esiste già, non ne stiamo creando una nuova.
//
// ── «Non ho potuto chiedere» ≠ «so che non esiste» ──────────────────────────
// La guardia rifiuta il NOTO-CATTIVO; non pretende la prova del buono. Un
// errore di TRASPORTO non è una risposta, e trattarlo come un no rendeva la
// guardia una lotteria: su questa macchina il server si ricarica a ogni
// salvataggio in `server/` (`TOPICS_SERVER_WATCH=1`), e per ~2s un click su un
// `/tab/chat/<id>` perfettamente valido non apriva niente e non diceva niente.
// Quindi l'esito è a TRE valori: solo un `state: 'unknown'` esplicito rifiuta,
// tutto il resto (rete giù, timeout, 5xx, corpo illeggibile) instrada come si
// faceva prima che questa verifica esistesse — al massimo si torna al rischio
// noto, invece di introdurne uno nuovo su ogni link valido.

/** L'esito della domanda al server. `unavailable` NON è un no: è l'assenza di
 *  una risposta, e come tale non decide niente. */
type SubjectCheck = 'exists' | 'missing' | 'unavailable';

/**
 * I ref già verificati ESISTENTI, per non ripetere la GET a ogni giro: la
 * ri-asserzione di boot richiama `openTabInApp` a ogni assestamento del
 * pane-store, e un doppio click ne fa due. Solo i SÌ CONFERMATI restano in
 * cache — un «no» non è per sempre (il topic può arrivare un istante dopo da un
 * peer), e un `unavailable` non è nemmeno un sì: memorizzarlo cristallizzerebbe
 * un blackout di due secondi in un permesso valido per tutta la sessione.
 */
const knownSubjects = new Map<string, Promise<SubjectCheck>>();

/** Gli ack ancora in attesa (vedi `scheduleOpenAck`). In produzione ognuno
 *  scade da sé; l'insieme serve al reset dei test, dove un watcher sopravvive
 *  al test che l'ha armato e sparerebbe il suo ack dentro le asserzioni di
 *  quello dopo — un rosso che non parla del codice. */
const pendingAcks = new Set<() => void>();

/** Solo per i test: dimentica le verifiche fatte e annulla gli ack in volo. */
export function __resetTabLinkStateForTests(): void {
  knownSubjects.clear();
  for (const cancel of [...pendingAcks]) cancel();
  pendingAcks.clear();
}

async function askServerIfSubjectExists(ref: string): Promise<SubjectCheck> {
  // Path relativo di proposito: sotto Tauri lo shim globale di `fetch`
  // (lib/shell/net) lo riscrive sull'origine del data server e ci attacca il
  // token di pairing. Rifarlo qui vorrebbe dire avere due porte che divergono.
  const res = await fetch(`/api/tabs/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/json' },
  });
  // Uno status non-2xx non dice niente sul SOGGETTO: 5xx è il server in
  // difficoltà, 401/403 è il gate di pairing, e un 400 («non è un permalink»)
  // significherebbe che la nostra grammatica e la sua divergono — un guasto
  // nostro, non una chiave inventata dall'utente. Nessuno di questi è un «non
  // esiste».
  if (!res.ok) return 'unavailable';
  const body = (await res.json()) as { state?: string } | null;
  if (!body || typeof body.state !== 'string') return 'unavailable';
  return body.state === 'unknown' ? 'missing' : 'exists';
}

/**
 * Chiede al server, e se la risposta non dice niente sul soggetto RIPROVA una
 * volta sola.
 *
 * Un `unavailable` quasi sempre non parla del link: parla del server che si sta
 * ricaricando in quel secondo. Riprovare una volta lo distingue da un server
 * davvero giù, e costa 1,5s solo nel caso in cui prima si sarebbe sbagliato.
 * Un `missing` NON si riprova: è una risposta, e ripeterla non la cambia.
 */
async function askOnceThenRetry(ref: string): Promise<SubjectCheck> {
  const first = await askServerIfSubjectExists(ref).catch(() => 'unavailable' as const);
  if (first !== 'unavailable') return first;
  await new Promise((r) => setTimeout(r, verifyRetryDelayMs));
  return askServerIfSubjectExists(ref).catch(() => 'unavailable' as const);
}

/** Il soggetto di questo target esiste, secondo il server? */
function subjectExists(subject: TabTarget): Promise<SubjectCheck> {
  const ref = buildTabPath(subject);
  // Un target che non produce nemmeno un ref è incoerente per la GRAMMATICA
  // (un file senza progetto, una chiave vuota): quello sì è un no secco, e non
  // c'è nessuno a cui chiederlo.
  if (!ref) return Promise.resolve<SubjectCheck>('missing');
  const cached = knownSubjects.get(ref);
  if (cached) return cached;
  const pending = askOnceThenRetry(ref)
    .then((outcome) => {
      // In cache resta SOLO un sì confermato: vedi `knownSubjects`.
      if (outcome !== 'exists') knownSubjects.delete(ref);
      return outcome;
    });
  knownSubjects.set(ref, pending);
  return pending;
}

/**
 * Instrada `route` a meno che il server non dica ESPLICITAMENTE che il soggetto
 * non esiste.
 *
 * I tre esiti, e perché sono tre:
 *  · `exists`      → si apre, ovviamente;
 *  · `missing`     → vicolo cieco: si avvisa e non si crea niente (è il buco
 *                    della pane fantasma, ed è l'unico caso che deve fermare);
 *  · `unavailable` → non abbiamo chiesto a nessuno. Si apre lo stesso e si
 *                    ANNOTA: il rischio è quello che c'era prima della
 *                    verifica (una pane fantasma se per caso quel ref era
 *                    inventato), mentre rifiutare qui rompe i link BUONI ogni
 *                    volta che il server si riavvia — cioè, su questa macchina,
 *                    a ogni salvataggio in `server/`.
 */
function routeIfSubjectExists(
  subject: TabTarget,
  route: () => void,
  opts?: OpenTabOptions,
): void {
  void subjectExists(subject).then((outcome) => {
    if (outcome === 'missing') {
      opts?.notify?.(DEAD_TAB_MESSAGE);
      return;
    }
    if (outcome === 'unavailable') {
      // Si apre lo stesso (rifiutare romperebbe i link BUONI a ogni ricarico del
      // server), ma ora l'utente lo SA: se compare una pane che non si aspettava,
      // ha già in mano il motivo invece di trovarselo solo in console.
      opts?.notify?.(UNVERIFIED_TAB_MESSAGE);
      console.warn('[tabLink] verifica di esistenza non disponibile, instrado comunque:', buildTabPath(subject));
    }
    route();
  });
}

// ── L'ack di un'apertura RIUSCITA ────────────────────────────────────────────

/** La pane è comparsa nell'ordine di una superficie di primo livello? È lo
 *  stesso criterio con cui l'intento di focus diventa efficace in Effect A di
 *  usePanelLifecycle (`storeOrder.includes(intent)`): prima di quel momento
 *  l'intento è inerte, dopo è lui a tenere il punto. */
function paneIsInStore(paneId: string): boolean {
  const { groups } = usePaneStore.getState();
  return Object.values(groups).some((g) => g.paneIds.includes(paneId));
}

/**
 * Dichiara CONCLUSA l'apertura quando la pane deterministica del target compare
 * nello store — e comunque entro `ACK_SETTLE_MS`.
 *
 * Il timeout non è una resa: per un ramo che atterra DENTRO una finestra di
 * progetto (una chat di progetto, un terminale già aperto lì) la pane non
 * comparirà MAI a livello App, quindi un ack «solo su prova» non arriverebbe
 * mai — ed è precisamente il caso in cui la ri-asserzione di boot resterebbe
 * accesa tutti gli 8 secondi. Un permalink che non ri-asserisce è molto meglio
 * di uno che ruba il focus a ogni click.
 *
 * Restituisce l'annullatore: se dopo aver instradato il ramo scopre di essere
 * finito in un vicolo cieco (il retry di mount che si esaurisce), l'ack di
 * successo non deve partire alle sue spalle.
 */
function scheduleOpenAck(paneId: string, opts?: OpenTabOptions): () => void {
  let done = false;
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    done = true;
    unsub?.();
    if (timer !== null) clearTimeout(timer);
    pendingAcks.delete(cancel);
  };
  const finish = () => {
    if (done) return;
    cancel();
    emit('topics:tab-opened', { paneId, dead: false } satisfies TabOpenedDetail);
  };
  pendingAcks.add(cancel);
  unsub = usePaneStore.subscribe(
    (s) => s.lastSeq,
    () => { if (paneIsInStore(paneId)) finish(); },
  );
  timer = setTimeout(finish, Math.max(0, opts?.settleMs ?? ACK_SETTLE_MS));
  // La pane può esserci GIÀ (un «portamela davanti» su una tab aperta): allora
  // l'ack è immediato e la ri-asserzione di boot non parte nemmeno.
  if (paneIsInStore(paneId)) finish();
  return cancel;
}

/**
 * Apri (o porta a fuoco) la tab indicata dal target, IN-APP.
 *
 * Instrada SOLO su eventi del bus che l'app già gestisce — non registra pane,
 * non tocca `ui_state`, non scrive nella history. Ogni ramo che non può
 * instradare avvisa via `opts.notify` e NON materializza niente: una pane
 * fantasma sopravvive al reload e non si chiude più (il precedente è
 * `chat:__agents__`).
 */
export function openTabInApp(target: TabTarget, opts?: OpenTabOptions): void {
  // Una finestra STACCATA (`?topics=`) non instrada NIENTE. Lì la persistenza
  // del pane-store è spenta di proposito (state/pane/bootstrap): un OPEN_PANE
  // dispatchato in quella finestra è una pane che nessuno salva e che nessuno
  // rivedrà — e nel frattempo l'utente non vede aprirsi un bel niente. Chi
  // chiama deve accorgersene PRIMA (vedi `deepLinkClickRoute`) per ricadere sul
  // browser esterno invece di lasciare il click muto; questa è la rete di
  // sicurezza per chiunque non lo faccia.
  if (isDetachedWindow()) return;

  // Il pane id deterministico del target: serve sia ad armare l'intento di
  // focus, sia — dopo — a riconoscere che l'apertura è avvenuta davvero.
  const intentPaneId = target && target.key ? appPaneIdForTarget(target) : null;

  let cancelAck: (() => void) | null = null;

  // Il VICOLO CIECO, in un posto solo. Emette SEMPRE l'ack (`dead: true`), anche
  // quando non c'era nessun intento da rilasciare: l'ack ha due consumatori
  // (vedi `TabOpenedDetail`) e ad App.tsx serve comunque, o la ri-asserzione di
  // boot continua per 8s a inseguire un target che si è già dichiarato morto.
  // Prima il wrapper era montato solo `if (intentPaneId)`, cioè saltava proprio
  // i vicoli ciechi più secchi: un `file` senza progetto, un `panel` fuori da
  // TAB_PANELS, una chiave vuota.
  const deadEnd = (message: string = DEAD_TAB_MESSAGE) => {
    cancelAck?.();
    cancelAck = null;
    emit('topics:tab-opened', { paneId: intentPaneId, dead: true } satisfies TabOpenedDetail);
    opts?.notify?.(message);
  };
  // I rami che notificano da dentro (il retry di mount) passano di qui.
  const routeOpts: OpenTabOptions = { ...opts, notify: deadEnd };
  /** Instradato: da qui in poi l'apertura si OSSERVA, non si spera. */
  const routed = () => {
    // `onRouted` PRIMA dell'ack, e fuori dal `if`: vale anche per i rami che non
    // hanno un pane id deterministico da osservare (file/diff), che sono proprio
    // quelli che possono aprire a metà e poi dichiarare il vicolo cieco.
    opts?.onRouted?.();
    if (intentPaneId) cancelAck = scheduleOpenAck(intentPaneId, opts);
  };

  if (!target || !target.key) {
    deadEnd();
    return;
  }

  // ARMA l'intento di focus PRIMA di instradare: il ramo che instrada può
  // focalizzare subito e l'hydrate che ruba il focus può arrivare nello stesso
  // battito. `topics:open-tab` / `topics:tab-opened` sono i gemelli esatti di
  // `topics:open-task` / `topics:task-opened` — li ascolta usePanelLifecycle.
  if (intentPaneId) emit('topics:open-tab', { paneId: intentPaneId });

  switch (target.kind) {
    case 'chat':
      // Il soggetto è il TOPIC, mai l'id della pane: `openPanel` decide da sé la
      // superficie (chat sciolta o dentro la finestra del progetto) e disarchivia.
      // `permanent` perché un permalink è una destinazione voluta, non un'anteprima.
      // VERIFICATO prima di instradare: `openPanel` registra la pane anche per un
      // topicId che non esiste più, e un UUID orfano l'effetto di validazione lo
      // tiene per sempre (`isUUIDLike` ⇒ ottimismo) — tab di chat vuota, ovunque.
      routeIfSubjectExists(target, () => {
        emit('topics:open-topic', { topicId: target.key, mode: 'permanent' });
        routed();
      }, routeOpts);
      return;

    case 'terminal':
      // `handleTerminalClick` è l'unica porta che guarda ENTRAMBE le superfici
      // (tab di primo livello + layout di ogni progetto) prima di decidere,
      // quindi non conia un secondo pane per una sessione già aperta altrove.
      //
      // Ciò che NON fa — e che qui c'era scritto che facesse — è guardare se la
      // sessione esiste. Con un id ignoto `terminalSessions.find` dà
      // `undefined`, il locator non trova niente, e il ramo finale
      // (usePanelLifecycle: `setOpenPanels([… 'terminal:<id>'])` +
      // `setFocusedPanelId`) conia comunque la tab e le porta via il fuoco. È
      // lo stesso evento CREATIVO di chat e project, e sta sotto la stessa
      // guardia: il resolver risponde `unknown` solo quando la sessione non è
      // né in `ui_state` né nel roster — cioè il caso legittimo (tab già
      // aperta, o sessione viva) continua a passare.
      routeIfSubjectExists(target, () => {
        emit('topics:open-terminal-pane', { sessionId: target.key, name: '' });
        routed();
      }, routeOpts);
      return;

    case 'project':
      // Stessa verifica della chat, per la stessa ragione: il listener di
      // `topics:open-project` registra la finestra INCONDIZIONATAMENTE, e
      // `project:` è un prefisso noto — quella pane non la ripulisce nessuno.
      routeIfSubjectExists(target, () => {
        emit('topics:open-project', { projectPath: target.key });
        routed();
      }, routeOpts);
      return;

    case 'panel': {
      // Fuori da TAB_PANELS non c'è niente da aprire: `handleOpenAsPage`
      // conosce solo quei panel, e il resto sarebbe un evento a vuoto.
      if (!(TAB_PANELS as readonly string[]).includes(target.key)) {
        deadEnd();
        return;
      }
      emit('topics:open-utility', { type: target.key });
      routed();
      return;
    }

    case 'task':
      // Il drawer della board è già l'unico proprietario di questa rotta —
      // riflessione nella history inclusa. Non duplichiamo niente, ACK COMPRESO:
      // il suo è `topics:task-opened`, che il drawer emette quando è davvero
      // aperto. Un ack nostro «la board è comparsa» arriverebbe PRIMA e
      // spegnerebbe la ri-asserzione proprio a chi ne ha bisogno.
      openTaskInApp({ taskId: target.key });
      return;

    case 'browser':
      openBrowserTab(target, routeOpts, routed);
      return;

    case 'file':
    case 'diff':
      openFileTab(target, routeOpts, routed);
      return;

    default:
      deadEnd();
  }
}

// ── Il click su un link, deciso in un posto solo ─────────────────────────────

/** L'esito di `deepLinkClickRoute`. */
export type DeepLinkClickRoute =
  | { via: 'task'; target: TaskTarget }
  | { via: 'tab'; target: TabTarget }
  | { via: 'external' };

/**
 * Come va gestito il click su `href` in una superficie markdown (ChatMarkdown).
 * Tre esiti, in quest'ordine di precedenza:
 *   • `task` — un `/task/<id>` self-origin: lo possiede il drawer della board,
 *     che riflette anche la history. Non gli togliamo il volante.
 *   • `tab` — tutto il resto della grammatica `/tab/…`, alias `/topic/<id>`
 *     compreso.
 *   • `external` — non è roba nostra… OPPURE questa finestra non può
 *     instradarlo. È il caso delle STACCATE: lì App.tsx si rifiuta di risolvere
 *     deep-link e la persistenza del pane-store è spenta, quindi un
 *     `openTabInApp` non aprirebbe niente e non direbbe niente — click muto.
 *     Prima che i link self-origin fossero intercettati, quello stesso link
 *     apriva il browser di sistema e il contenuto si VEDEVA: il ripiego giusto
 *     è tornare esattamente lì.
 *
 * È una funzione e non tre `if` dentro il componente perché la decisione è
 * testabile e il componente no.
 */
export function deepLinkClickRoute(href: string): DeepLinkClickRoute {
  if (!href) return { via: 'external' };
  if (isDetachedWindow()) return { via: 'external' };
  const task = selfTaskLinkTarget(href);
  if (task) return { via: 'task', target: task };
  const tab = selfTabLinkTarget(href);
  if (tab) return { via: 'tab', target: tab };
  return { via: 'external' };
}

/**
 * Al boot: se la location porta un permalink `/tab/…`, aprilo e poi CONSUMALO
 * (`replaceState('/')`).
 *
 * Perché consumare, al contrario di `/task/<id>` che invece resta: `/task/<id>`
 * è la riflessione VIVA del drawer, quindi la URL è la fonte di verità e un
 * refresh deve ritrovarci il drawer. `/tab/…` non riflette niente — è un
 * indirizzo che qualcuno ci ha passato: una volta aperto, lasciarlo lì
 * significherebbe ri-aprire quella tab a ogni reload, per sempre, anche dopo che
 * l'utente l'ha chiusa. `replaceState` (non `push`) perché non è una tappa di
 * navigazione: non deve esserci un «indietro» che ci riporta sul permalink.
 *
 * Gli alias `/task/<id>` e `/topic/<id>` NON passano di qui: li possiede
 * `openTaskFromUrl`, che di proposito non li strippa.
 *
 * Restituisce l'ANNULLATORE dell'apertura armata, oppure `null` se non c'era
 * niente da armare (finestra staccata, rotta non `/tab/`, target illeggibile).
 * La differenza conta per chi chiama: `null` vuol dire «il colpo garantito
 * devi darlo tu». In dev StrictMode il primo mount consuma la URL e il suo
 * cleanup annulla l'apertura; al secondo mount la URL è già pulita e questa
 * funzione non ha più niente da fare — se restituisse comunque un annullatore
 * inerte, App.tsx lo prenderebbe per un colpo già armato e il permalink non si
 * aprirebbe mai (lì il target sopravvive nella costante di modulo `BOOT_DEEP_LINK`).
 */
export function consumeTabLinkFromUrl(opts?: OpenTabOptions): (() => void) | null {
  // Una finestra STACCATA non consuma NIENTE, e soprattutto non tocca la sua
  // URL. La query `?topics=` È l'identità della finestra: `u.search = ''` la
  // trasformerebbe in una main al primo reload — la pop-out riaprirebbe l'intero
  // workspace invece delle sue chat. App.tsx si protegge già con
  // `if (isDetached) return`, ma l'invariante è di QUESTO modulo: chi aggiunge
  // domani un secondo chiamante non deve doverla riscoprire. (Anche
  // `openTabInApp` ha la stessa rete di sicurezza, ma quella non copre lo
  // strip: è il `finally` qui sotto a farlo, e gira comunque.)
  if (isDetachedWindow()) return null;

  let isTabRoute = false;
  try {
    isTabRoute = window.location.pathname.startsWith(TAB_PATH_PREFIX);
  } catch {
    return null;
  }
  if (!isTabRoute) return null;

  let cancel: (() => void) | null = null;
  try {
    const target = currentTabTarget();
    // L'apertura aspetta l'idratazione (vedi `openTabInAppWhenHydrated`); la
    // pulizia della URL qui sotto no — è indipendente, e rimandarla vorrebbe
    // dire lasciare per un secondo una URL che un reload riaprirebbe.
    if (target) cancel = openTabInAppWhenHydrated(target, opts);
    else opts?.notify?.(DEAD_TAB_MESSAGE);
  } finally {
    // Consuma SEMPRE, anche quando il target è illeggibile: una rotta `/tab/`
    // che non apre niente non deve restare a ripresentarsi a ogni reload.
    try {
      const u = new URL(window.location.href);
      u.pathname = '/';
      // `?space=` sopravvive allo strip: in una finestra-GRUPPO quella query è
      // l'identità della finestra (chi è il gruppo che disegna), non un
      // parametro di navigazione. Cancellarla la trasformerebbe in una
      // finestra principale al primo reload — lo stesso guasto che `?topics=`
      // evita uscendo prima da questa funzione.
      const pinnedSpace = u.searchParams.get('space');
      u.search = '';
      if (pinnedSpace) u.searchParams.set('space', pinnedSpace);
      window.history.replaceState(null, '', u.toString());
    } catch {
      /* history non disponibile: la tab è comunque aperta */
    }
  }
  return cancel;
}

// ── L'attesa dell'IDRATAZIONE ────────────────────────────────────────────────
//
// Il difetto che questa sezione chiude (TABLINK-06): un permalink verso una
// chat GIÀ APERTA la faceva SPARIRE dalla barra. Cronologia misurata: a 300ms
// entrambe le tab ci sono, fra 800 e 1300ms il target è correttamente ATTIVO,
// da ~1800ms la tab del target NON C'È PIÙ — mentre nello store PERSISTITO
// (`GET /api/ui-state/pane-store-v2`) c'è ancora, e la topic non è archiviata.
// A perderla è l'ordine VISIBILE del client.
//
// ── Qual è la variabile, misurata e non dedotta ─────────────────────────────
// Cinque configurazioni, stesso test, stessa macchina (E2E_PORT=13877):
//
//   apertura instradata…                                   TABLINK-06
//   ────────────────────────────────────────────────────── ───────────
//   sincrona nell'effetto di mount (com'era)                ROSSO
//   sincrona al mount + una seconda dopo l'idratazione      ROSSO
//   una sola, rinviata di un tick (`setTimeout(0)`)         verde
//   DUE, entrambe dopo l'idratazione                        verde
//   una sola, dopo l'idratazione (questo codice)            verde
//
// Le due righe centrali sono la coppia che decide: a parità di NUMERO di
// aperture (due), spostare la prima dal mount al dopo-idratazione ribalta
// rosso→verde. Non è quindi «una apertura di troppo»: è un'apertura che parte
// mentre l'app non è ancora in grado di riceverla — al mount gli ascoltatori
// del bus (usePanelLifecycle) non sono ancora registrati, quindi l'intento di
// focus `topics:open-tab` cade nel vuoto e la pane nasce senza niente che la
// tenga, in mezzo all'onda di idratazione.
//
// È la stessa classe di corsa da cui `state/pane/middleware/syncServer.ts` già
// si difende con `hasReceivedServerHydrate()` (là il guasto era un PUT
// pre-idratazione che cancellava le tab dell'utente sul SERVER; qui l'effetto
// è sul client), ed è il motivo per cui la correzione riusa QUEL segnale.
//
// La correzione è strutturale, non un rinvio a caso: un permalink dice
// «portami su questa tab», e per sapere se la tab c'è già bisogna aver
// ricevuto lo stato. Quindi si instrada DOPO la prima idratazione.

/**
 * Instrada `target` dopo la PRIMA idratazione del pane-store — o, se
 * l'idratazione non arriva, allo scadere di `HYDRATE_FALLBACK_MS`. Restituisce
 * l'annullatore (App.tsx lo chiama quando la corsa di boot finisce prima).
 *
 * Il segnale è `onServerHydrated` di `state/pane/middleware/serverHydrated` —
 * quello che il client possiede già e che `bootstrap.ts` usa per decidere se il
 * fallback GET serve ancora. NON un timer nudo: un timer indovina, questo
 * SA. Il fallback a tempo copre solo il caso in cui il segnale non arriverà mai
 * (offline, primo avvio, server irraggiungibile), perché un link che resta
 * appeso per sempre sarebbe peggio della corsa che stiamo chiudendo.
 */
export function openTabInAppWhenHydrated(target: TabTarget, opts?: OpenTabOptions): () => void {
  let done = false;
  let off: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (done) return;
    done = true;
    off();
    if (timer !== null) clearTimeout(timer);
    openTabInApp(target, opts);
  };
  off = onServerHydrated(fire);
  timer = setTimeout(fire, Math.max(0, opts?.hydrateTimeoutMs ?? HYDRATE_FALLBACK_MS));
  return () => {
    done = true;
    off();
    if (timer !== null) clearTimeout(timer);
  };
}

// ── Browser: la pane esiste già da qualche parte, va solo trovata ────────────

function openBrowserTab(target: TabTarget, opts: OpenTabOptions, routed: () => void): void {
  const contextId = target.key;
  const paneId = createPaneId('browser', contextId);

  // Va emesso SEMPRE e per primo: `browser:request-focus` ha una guardia di
  // proprietà su ogni superficie (una finestra di progetto reagisce solo se il
  // suo layout contiene la pane), quindi al massimo una risponde e le altre
  // sono no-op. Farlo prima di qualunque controllo è ciò che ci salva dal
  // ritardo dello snapshot in localStorage, che è scritto con debounce: una tab
  // aperta un attimo fa può non risultarci ancora da nessuna parte.
  emit('browser:request-focus', { contextId });

  // Livello App: qui NESSUNO ascolta quell'evento (il gemello via WS fa il
  // lavoro inline in usePanelLifecycle), quindi il focus lo diamo noi sul
  // pane-store. Da lì Effect A lo porta in `openPanels` e l'effetto
  // focus-follows-space sposta la finestra sullo Spazio giusto: nessuna delle
  // due cose va reimplementata qui.
  const store = usePaneStore.getState();
  const atAppLevel = Object.values(store.groups).some((g) => g.paneIds.includes(paneId));
  if (atAppLevel) {
    store.dispatch({ type: 'FOCUS_PANE', payload: { id: paneId } });
    routed();
    return;
  }

  const reader = opts.projectPanes ?? browserProjectPanesReader();

  // Hint di proprietà `?in=<progetto>`: se quel progetto la ospita davvero,
  // apri la sua finestra e ripeti il focus finché non è montata. La guardia
  // `projectHostsPane` è il motivo per cui QUESTO ramo non ha mai coniato una
  // finestra fantasma — è la stessa idea che ora chat/project prendono dal
  // server, perché lì una guardia locale non basterebbe.
  if (target.projectPath && projectHostsPane(reader, target.projectPath, paneId)) {
    const projectPath = target.projectPath;
    emit('topics:open-project', { projectPath });
    // Prima l'ack, poi il retry: quest'ultimo può dichiarare il vicolo cieco già
    // al primo giro sincrono, e deve poter annullare l'ack (vedi openFileTab).
    routed();
    runUntilProjectMounted(projectPath, () => emit('browser:request-focus', { contextId }), opts);
    return;
  }

  // Nessun hint, ma un layout persistito la contiene: la chiave di quel canale è
  // un hash del path, quindi sappiamo CHE esiste ma non in quale progetto. Se
  // quella finestra è montata, il `request-focus` di sopra l'ha già trovata.
  if (anyProjectHostsPane(reader, paneId)) {
    routed();
    return;
  }

  // Le tab browser di un TASK non stanno né nel pane-store né nei layout di
  // progetto: vivono nel drawer del task (`taskBrowserLayout`). Aprire il task è
  // il modo giusto di «andare dove quella tab vive».
  if (target.taskId) {
    openTaskInApp({ taskId: target.taskId });
    routed();
    return;
  }

  opts.notify?.(DEAD_TAB_MESSAGE);
}

// ── File / diff: due hop, e il secondo ha bisogno di un ascoltatore ──────────

/**
 * Un file non è una pane indirizzabile: il suo id (`file:<uuid>`) è sorteggiato
 * a ogni apertura. Si indirizza il CONTENUTO, e per aprirlo servono DUE hop:
 *   1. `topics:open-project` — il listener del file vive DENTRO useProjectLayout,
 *      cioè non esiste finché la finestra di progetto non è montata;
 *   2. `open-file` / `open-file-diff` — ripetuto finché quella finestra c'è.
 *
 * Ripetere è sicuro perché il secondo hop è IDEMPOTENTE: `handleOpenFile`
 * deduplica per `filePath` e `handleOpenDiff` per l'id deterministico
 * `diff:<filePath>`; trovando il pane già aperto si limitano a focalizzarlo. È
 * anche l'unico modo onesto: quei pane non stanno nel pane-store, quindi non
 * esiste un ack da aspettare.
 */
function openFileTab(target: TabTarget, opts: OpenTabOptions, routed: () => void): void {
  const projectPath = target.projectPath;
  if (!projectPath) {
    opts.notify?.(DEAD_TAB_MESSAGE);
    return;
  }
  // `topicId` qui NON è un topic: è il TARGET del routing (shouldHandleOpenFile),
  // cioè il pane id della finestra di progetto che deve aprire il file. Senza,
  // l'evento cade su quella che ha il focus — e in split view apre il file nella
  // finestra sbagliata.
  const wrapperPaneId = createPaneId('project', projectPath);

  const dispatchFile =
    target.kind === 'diff'
      ? () =>
          emit('open-file-diff', {
            // `handleOpenDiff` ricompone il path pieno come
            // `${projectPath}/${filePath}`: vuole il RELATIVO. Il pane però porta
            // `filePath` già pieno (è così che il diff lo salva), quindi il
            // permalink trasporta il pieno e qui lo si riporta relativo.
            filePath: relativeToProject(projectPath, target.key),
            projectPath,
          })
      : () => emit('open-file', { path: target.key, topicId: wrapperPaneId });

  // Il primo hop APRE UNA FINESTRA DI PROGETTO: è lo stesso evento creativo del
  // ramo `project`, quindi la stessa verifica. Il soggetto da confermare è il
  // PROGETTO, non il file — il resolver non tocca il filesystem di proposito, e
  // la pane del file non sta comunque nel pane-store (nessun fantasma da lì).
  // Senza questa guardia bastava un `/tab/file/<progetto inesistente>/<x>` in
  // chat per far nascere, e PERSISTERE ovunque, una finestra su una cartella che
  // non c'è — con il toast «questa tab non esiste più» due secondi dopo, e la
  // tab fantasma comunque lì.
  routeIfSubjectExists({ kind: 'project', key: projectPath }, () => {
    emit('topics:open-project', { projectPath });
    // `routed()` PRIMA del retry: il retry può esaurirsi già al primo giro
    // (sincrono) e dichiarare il vicolo cieco, e quel vicolo cieco deve poter
    // annullare l'ack di successo — se l'ack fosse armato dopo, resterebbe
    // acceso alle sue spalle e prometterebbe un'apertura che non c'è stata.
    routed();
    runUntilProjectMounted(projectPath, dispatchFile, opts);
  }, opts);
}

/** Il path relativo al progetto, se `filePath` è pieno; altrimenti invariato. */
function relativeToProject(projectPath: string, filePath: string): string {
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

// ── Il retry «finché la finestra di progetto non è montata» ──────────────────

/**
 * La ProjectWindow di `projectPath` è montata?
 *
 * Segnale: `useProjectChatSync` scrive la chiave del progetto in
 * `projectFocus.activePaneByProject` da un effetto che gira a ogni mount, anche
 * quando il pane attivo è `null`. È l'UNICO segnale osservabile da fuori — i
 * pane interni a un progetto non stanno nel pane-store.
 *
 * Limite noto: la chiave non viene rimossa allo smontaggio, quindi un progetto
 * aperto e poi chiuso resta «montato» per questa funzione. Non è un problema
 * per come la usiamo — serve a decidere quando SMETTERE di ripetere un dispatch
 * idempotente, e l'attesa minima di due giri (400ms) copre comunque il mount.
 */
function isProjectWindowMounted(projectPath: string): boolean {
  return projectPath in useProjectFocusStore.getState().activePaneByProject;
}

function runUntilProjectMounted(
  projectPath: string,
  tick: () => void,
  opts?: OpenTabOptions,
): void {
  let left = Math.max(1, opts?.retry?.attempts ?? RETRY_ATTEMPTS);
  const intervalMs = opts?.retry?.intervalMs ?? RETRY_INTERVAL_MS;
  let confirmed = 0;

  const run = () => {
    tick();
    if (isProjectWindowMounted(projectPath)) confirmed++;
    // Due giri con la finestra montata, non uno: il primo può cadere nello
    // stesso commit in cui il listener si sta registrando, il secondo lo trova
    // di sicuro.
    if (confirmed >= 2) return;
    if (--left <= 0) {
      opts?.notify?.(DEAD_TAB_MESSAGE);
      return;
    }
    setTimeout(run, intervalMs);
  };
  run();
}

// ── Il canale localStorage dei layout di progetto ────────────────────────────

/** Adatta il vero localStorage al lettore. Vuoto (mai in errore) dove non c'è. */
function browserProjectPanesReader(): ProjectPanesReader {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { keys: () => [], getItem: () => null };
  }
  const ls = window.localStorage;
  return {
    keys() {
      const out: string[] = [];
      try {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k && k.startsWith(PROJECT_PANES_PREFIX)) out.push(k);
        }
      } catch {
        /* accesso negato: come se fosse vuoto */
      }
      return out;
    },
    getItem(key) {
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    },
  };
}

/** Il record persistito di un progetto elenca `paneId` fra i suoi nonChatPanes? */
function recordHostsPane(raw: string | null, paneId: string): boolean {
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const panes = (parsed as { nonChatPanes?: unknown } | null)?.nonChatPanes;
  if (!Array.isArray(panes)) return false;
  return panes.some((p) => !!p && typeof p === 'object' && (p as { id?: unknown }).id === paneId);
}

function projectHostsPane(reader: ProjectPanesReader, projectPath: string, paneId: string): boolean {
  return recordHostsPane(reader.getItem(projectPanesKey(projectPath)), paneId);
}

function anyProjectHostsPane(reader: ProjectPanesReader, paneId: string): boolean {
  return reader.keys().some((k) => recordHostsPane(reader.getItem(k), paneId));
}
