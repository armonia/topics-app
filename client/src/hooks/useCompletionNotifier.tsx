import { useCallback, useEffect, useRef } from 'react';
import type { AppSettings, ClaudeSessionPhase, TerminalSessionInfo, Topic, WSMessage } from '../types';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import { useSignalsStore } from '../state/signals';
import { notifyNative } from '../lib/shell/app';
import { initFocusStatus, isFocusSilencing } from '../lib/shell/focus';
import { decideTerminalBanner, statusBody, isTerminalPaneSelected, isTabActivelyVisible, isRealPhaseTransition } from '../lib/notify/terminalNotify';
import { useProjectFocusStore } from '../state/projectFocus';
import { isAgentTurnNoise } from '../lib/notify/dispatchedTopic';
import { isTopicMuted as isTopicMutedPure } from '../lib/notify/muteGate';
import { bannerClaimKey, bannerClaimant, claimMessageBanner } from '../lib/notify/messageBannerClaim';
import { decideMessageBanner } from '../lib/notify/messageBanner';
import { buildNotifyActions, type NotifyAction } from '../../../shared/notify-actions';
import { questionAsksHuman } from '../../../shared/board';
import { resolveReviewQuestion } from '../lib/notify/reviewQuestion';
import { boardApi, isAgentWorking } from '../lib/board';
import { inPageBannerAllowed, type NotifyEventKind } from '../lib/notify/pushVoice';
import { isPushSubscribed } from '../state/pushDevice';
import { recordNotificationSent } from '../lib/notify/history';
import type { NotifyTarget } from '../lib/notify/notifyTarget';
import {
  chatNotificationKey,
  taskParkedNotificationKey,
  taskReviewNotificationKey,
  type NotificationKind,
} from '../../../shared/notification-log';
import type { TopicTaskResolver } from './useTaskTopicIndex';

/**
 * Il segnale → il genere con cui finisce nella CRONOLOGIA.
 *
 * Due vocabolari e non uno perché rispondono a due domande diverse:
 * `NotifyEventKind` dice CHI ha diritto di annunciare l'evento (pagina o push,
 * `lib/notify/pushVoice`), `NotificationKind` dice COS'ERA a chi legge il
 * registro un'ora dopo. Tenerli separati costa questa tabella; fonderli
 * significherebbe che aggiungere un evento al gate anti-doppia-voce cambia in
 * silenzio come le righe vecchie si leggono.
 */
const REGISTRY_KIND: Record<NotifyEventKind, NotificationKind> = {
  'task:review-ready': 'task-review',
  'task:parked': 'task-parked',
  'message:new': 'chat-message',
  'session:state': 'session',
};

interface CompletionNotifierProps {
  /** WS subscription registrar from useWebSocket().onMessage. */
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  /** Live AppSettings — reads `notificationsEnabled`, `notificationsSound`,
   *  `notifyEvenWhenFocused` to gate the toast/sound. */
  settings: AppSettings;
  /** Topic map keyed by id (the shape returned by `useTopics`). Used to
   *  resolve a friendly name for the toast body. */
  topics: Record<string, Topic>;
  /** The currently-focused panel id (e.g. `chat:<topicId>`, `agents:…`).
   *  Used to suppress the toast for the topic the user is already looking
   *  at, unless `notifyEvenWhenFocused` is on. */
  focusedPanelId: string | null;
  /** Live terminal roster — lets the pty-`finished` notifier resolve a
   *  terminal id → its claudeSessionId (cross-path cooldown dedup) + name. */
  terminalSessions: TerminalSessionInfo[];
  /** Resolve a topic id → the dispatched task it works, if any. When a
   *  completion banner is for a dispatched-task topic, the taskId rides into the
   *  notification so a click opens that task's drawer (openTaskInApp) — e il suo
   *  `dispatchState` dice se l'agente sta lavorando ADESSO, che è la condizione
   *  per zittire la fine turno (isAgentTurnNoise). */
  taskForTopic?: TopicTaskResolver;
  /** True se QUESTA finestra sta streammando quella sessione (useChat →
   *  `isOwnStream`). Il banner di `message:new` lo salta: la pane che streamma
   *  ha già il messaggio in pagina. Era un gate implicito del vecchio sito di
   *  chiamata in `usePanelLifecycle` (il `return` del bail su isOwnStream usciva
   *  dall'intero handler, banner compreso); viaggia esplicito perché una
   *  soppressione che dipende da dove sta scritto il codice non è una regola. */
  isOwnStream?: (sessionKey: string) => boolean;
}

/**
 * Internal helper — plays a short, low-volume "ding" via WebAudio.
 *
 * We deliberately avoid bundling an mp3 asset:
 *   - keeps the bundle smaller
 *   - sidesteps autoplay-policy issues (a user gesture has already happened
 *     by the time an agent completes — they typed the prompt — so resuming
 *     a brand new AudioContext is allowed)
 *   - failures are silent (some envs lock AudioContext entirely; we never
 *     throw to the caller)
 */
function playCompletionTone(): void {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    // Two-tone descending blip — short enough to not be annoying.
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(523, ctx.currentTime + 0.18);

    // Quick attack, exponential release. Peak gain stays well below 1 so
    // even users with high system volume get a discreet cue.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

    osc.start();
    osc.stop(ctx.currentTime + 0.25);

    // Closing exactly once, whatever happens. `onended` is the happy path, but it
    // is NOT guaranteed: if the context never leaves `suspended` (autoplay policy,
    // a machine with no audio device, the window backgrounded at the wrong moment)
    // the oscillator never runs and the callback never fires — and an unclosed
    // AudioContext is not garbage: WebKit keeps a live RemoteAudioDestinationProxy
    // render thread per context, forever. One ding per agent completion means a
    // long session quietly accumulates them. The timer is the backstop; whichever
    // arrives first wins and the other becomes a no-op.
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(fallback); // sempre inizializzato: `close` non parte mai sincrono
      ctx.close().catch(() => {});
    };
    const fallback = setTimeout(close, 1000);
    osc.onended = close;
  } catch {
    /* never propagate audio errors — they're cosmetic */
  }
}

/** Pull the topic id out of a panel id like `chat:abc-123`. Returns null
 *  for non-chat panels (agents pane, terminal, etc.) since those aren't
 *  bound to a specific topic. */
function topicIdFromPanel(panelId: string | null): string | null {
  if (!panelId) return null;
  // Panel ids are `<kind>:<rest>`. Only the chat kind has a 1:1 mapping
  // to a topic — every other kind shares a workspace.
  const [kind, rest] = panelId.split(':', 2);
  return kind === 'chat' && rest ? rest : null;
}

/**
 * Subscribes to `agents:sessions` and surfaces a toast (+ optional sound)
 * the moment a session flips `active → idle` (or into `error`).
 *
 * The hook is intentionally a no-op when `settings.notificationsEnabled`
 * is false — the master switch lives in Settings → Notifications. It also
 * suppresses the toast for the focused topic unless `notifyEvenWhenFocused`
 * is on, so a user actively watching a topic doesn't get a redundant cue
 * for what they can plainly see in the chat pane.
 *
 * Superficie unica: il banner nativo del sistema. La seconda via — il main
 * process di Electron, che bannerizzava per conto suo `agents:sessions` — non
 * esiste piu' (guscio archiviato in v2.0.0), e con lei il parametro che serviva
 * solo a non raddoppiare il banner.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its renderless bridge component (CompletionNotifierBridge); idiomatic and the bridge is the sole consumer
export function useCompletionNotifier({
  onWSMessage,
  settings,
  topics,
  focusedPanelId,
  terminalSessions,
  taskForTopic,
  isOwnStream,
}: CompletionNotifierProps): void {
  // Il permesso NON si chiede più al mount, ed è un cambio deliberato.
  //
  // Qui c'era un `primeWebNotificationPermission()` dentro un effetto senza
  // dipendenze: in una scheda del browser il prompt di sistema partiva
  // all'avvio, prima che l'utente avesse fatto niente. È il modo peggiore di
  // chiedere — si nega per riflesso — e il costo non è «stavolta ha detto no»:
  // un permesso NEGATO non si riapre da dentro la pagina (su iOS si va nelle
  // impostazioni di sistema), quindi quel no chiude anche la porta alle
  // notifiche ad app chiusa, per sempre, prima ancora che esistano.
  //
  // Ora lo chiede chi ha una ragione da mostrare: `PushEnrollPrompt` dopo che
  // hai mandato un messaggio (cioè dopo aver creato un'attesa) e il bottone in
  // Impostazioni → Notifiche. Restano gli unici due siti, e la porta unica
  // (`lib/shell/app`) resta quella.

  // Arm the Focus/DND gate. Installs the push hook the native watcher calls and
  // does one eager query; idempotent and a no-op off Tauri (web keeps the safe
  // "notify normally" default). See lib/shell/focus.ts.
  useEffect(() => {
    initFocusStatus();
  }, []);

  // UNICA via d'uscita per ogni segnale: banner nativo del sistema (l'unica
  // superficie — niente toast in-app, preferenza dell'utente) piu' il suono.
  //
  // Titolo e corpo arrivano SEPARATI. Prima si impacchettava tutto in
  // «Etichetta: stato» e si riseparava sul primo ": " — con un topic chiamato
  // «Fix: login rotto» il banner diventava titolo «Fix», corpo «login rotto:
  // in attesa di te». Il nome del topic tagliato a meta' e lo stato appiccicato
  // dentro il corpo. Il formato non c'e' piu', e con lui quella classe di bug.
  //
  // `silent`: il tono lo suoniamo noi in WebAudio quando l'interruttore del
  // suono e' acceso, cosi' il banner del sistema resta muto e non si sente due
  // volte. `taskId` (quando la topic lavora un task dispatchato) rende il
  // banner cliccabile → apre il drawer di quel task.
  //
  // `tag` (solo web) collassa i banner che si sostituiscono a vicenda invece di
  // impilarli: due messaggi dello stesso topic sono UNA cosa da guardare, non
  // due. Sotto Tauri non esiste — lì il compito lo fa la cooldown del
  // chiamante.
  //
  // `kind` non è decorazione: dice QUALE segnale è, e su quello si decide se la
  // pagina ha diritto di parlare. Da quando un dispositivo può essere iscritto
  // al push, gli eventi che il push copre arrivano DUE volte — una via
  // WebSocket qui, una via push al service worker — e senza questo gate ogni
  // evento diventerebbe due banner. La regola sta in `lib/notify/pushVoice.ts`,
  // e vale solo per gli eventi coperti: i segnali dei terminali, che il push non
  // manda, continuano a passare da qui. (Prima il primo parametro era `_level`,
  // che nessuno leggeva.)
  //
  // `log` è la RIGA DI REGISTRO di questa notifica (cronologia, migration 102),
  // ed è OBBLIGATORIA: `fire` è l'unica uscita dei banner, cioè l'unico punto
  // che sa per certo cosa è stato mandato. Facoltativa vorrebbe dire una
  // cronologia con buchi che nessun test può vedere. Sta prima degli opzionali
  // apposta — così nessun sito di chiamata deve imbottire di `undefined` per
  // arrivarci.
  const fire = useCallback((
    kind: NotifyEventKind,
    title: string,
    body: string,
    sound: boolean,
    log: {
      /** La stessa chiave che usa la push per lo STESSO evento: una riga sola. */
      dedupeKey: string;
      /** Il topic bersaglio quando non c'è un task (il task lo porta già
       *  `taskId`): senza un bersaglio il click nella cronologia non porta da
       *  nessuna parte, ed è metà della richiesta. */
      topicId?: string | null;
    },
    taskId?: string | null,
    tag?: string,
    actions?: NotifyAction[],
  ) => {
    if (!inPageBannerAllowed(isPushSubscribed(), kind)) return;
    // Gate su Focus/Non disturbare. Se il sistema ci dice CON CERTEZZA che c'è un
    // Focus attivo, l'app tace del tutto — banner E suono. L'informazione non si
    // perde: il badge/tab (useTabNotifications, altro hook) resta acceso, sparisce
    // solo il rumore. `isFocusSilencing()` è false su web e ovunque lo stato non
    // sia leggibile → di default si notifica normalmente (nessun falso silenzio).
    if (isFocusSilencing()) return;
    // IL BERSAGLIO, calcolato UNA volta: il TASK se c'è (il click apre il suo
    // drawer), altrimenti il TOPIC (il click apre la conversazione). Lo stesso
    // oggetto va al banner e al registro, così il click sul banner e il click
    // sulla riga di cronologia non possono atterrare in due posti diversi.
    // Prima il registro lo aveva e il banner no: ogni notifica di chat era un
    // banner che si poteva cliccare senza andare da nessuna parte.
    const target: NotifyTarget | null = taskId
      ? { kind: 'task', id: taskId }
      : log.topicId
        ? { kind: 'topic', id: log.topicId }
        : null;
    notifyNative(title, body, { silent: true, target, tag, actions });
    if (sound) playCompletionTone();
    // IL REGISTRO, dopo la consegna e mai prima: si registra ciò che è stato
    // MANDATO, non ciò che si aveva intenzione di mandare. I due `return` qui
    // sopra non lasciano riga, e in un caso è proprio il comportamento giusto —
    // quando tace perché parla il push (`inPageBannerAllowed`), la riga la
    // scrive il SERVER dal suo lato (`maybeSendPush`), con la stessa chiave.
    //
    // POST fire-and-forget: il server deduplica a finestra, quindi lo stesso
    // evento uscito da N finestre staccate — o da banner E push insieme —
    // resta una riga sola.
    recordNotificationSent({
      kind: REGISTRY_KIND[kind],
      title,
      body,
      // Lo stesso bersaglio del banner, letto dalla stessa variabile: dove
      // porta la riga di cronologia e dove porta la notifica sono un fatto
      // solo, non due `if` gemelli che prima o poi divergono.
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      dedupeKey: log.dedupeKey,
      source: 'banner',
    });
  }, []);

  // Refs let us read the latest values inside the WS handler without
  // re-subscribing on every settings change (which would drop in-flight
  // status diffs). useRefMirror is the canonical state→ref bridge.
  const settingsRef = useRefMirror(settings);
  const topicsRef = useRefMirror(topics);
  const focusedRef = useRefMirror(focusedPanelId);
  const terminalSessionsRef = useRefMirror(terminalSessions);
  const taskForTopicRef = useRefMirror(taskForTopic);
  const isOwnStreamRef = useRefMirror(isOwnStream);

  // Per-topic cooldown (10s) so two completions in quick succession on
  // the same topic don't double-banner.
  const cooldownRef = useRef<Map<string, number>>(new Map());

  // ── Mute gate ──────────────────────────────────────────────────────────
  // A topic is muted when EITHER the topic itself carries `muted` (per-topic,
  // Topic.muted / migration 073) OR its project is in `settings.mutedProjects`
  // (per-project, keyed by projectPath). A muted topic's completion produces NO
  // banner and NO sound — but it is NOT swallowed: the badge path
  // (useTabNotifications → setAppBadge) is driven by the attention rollup, which
  // is mute-blind, so the count still rises. This gate only silences the
  // interruption. Reads through refs so it's stable inside the WS handlers and
  // always sees the latest topics/settings without re-subscribing.
  const isTopicMuted = useCallback((topicId: string | null | undefined): boolean => {
    if (!topicId) return false;
    return isTopicMutedPure(topicsRef.current[topicId], settingsRef.current.mutedProjects);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads only refs (stable)
  }, []);

  // ── End-of-task notifier ───────────────────────────────────────────────
  // A board task entering review is the "the task you asked for is done" cue.
  // Unlike the session-idle inference above, this rides the task's OWN terminal
  // state (server broadcasts `task:review-ready` only on the review edge), so it
  // fires reliably for a clean self-delivery AND the system-delivered review
  // after a timeout — the case that was previously silent. Deliberately NOT
  // focus-gated: a task landing in review is actionable no matter which tab is
  // open; the 10s per-task cooldown is the only spam guard. `taskId` makes the
  // banner clickable → opens that task's drawer.
  useWSSubscription(onWSMessage, 'task:review-ready', (msg) => {
      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;
      const taskId = msg.taskId;
      if (!taskId) return;
      const key = `task-review:${taskId}`;
      const now = Date.now();
      const last = cooldownRef.current.get(key) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(key, now);
      const title = (msg.taskTitle || 'Task').slice(0, 140);
      // La consegna che È una domanda si annuncia come tale, e le sue opzioni
      // diventano i TASTI del banner: rispondere costa un click, non "apri
      // l'app, trova il task, leggi, premi".
      //
      // La domanda arriva nel fronte (server: emitReviewReadyEdge) e allora non
      // costa niente; se il fronte NON la porta è un server più vecchio di
      // questo client — caso normale, il guscio desktop si aggiorna per conto
      // suo — e allora la si chiede, invece di dedurre «nessuna domanda» e
      // offrire un "Approva" su un task che sta aspettando una risposta. Vedi
      // lib/notify/reviewQuestion.ts.
      //
      // La domanda si risolve PRIMA di sapere se questa voce parlerà: il gate
      // anti-doppia-voce vive dentro `fire`, e chiederlo qui costerebbe di
      // duplicare la regola in due posti. È una GET sola, e solo sul fronte di
      // review di un task — non è il giro caldo.
      void resolveReviewQuestion(msg, {
        fetchComments: async (projectId, id) => (await boardApi.get(projectId, id)).comments,
      }).then((resolved) => {
        // 'unknown' = non si è potuto sapere: banner senza tasti, come prima.
        const question = resolved === 'unknown' ? null : resolved;
        // WHICH of the two voices is `questionAsksHuman`, the same rule behind
        // the dispatch chip, the two review gates and the twin push, and NOT
        // "is there a question block". The kickoff envelope orders a landable
        // delivery to attach `options=["Landa su main"]`, which the service
        // wraps in that very fence: reading the fence, every finished delivery
        // announced itself as "serve una tua risposta". The OPTIONS stay whole
        // either way, because they are the banner's buttons.
        const actions = resolved === 'unknown'
          ? []
          : buildNotifyActions({ kind: 'review-ready', question });
        fire(
          'task:review-ready',
          questionAsksHuman(question) ? 'Serve una tua risposta' : 'Task pronto per la review',
          question?.text ? `${title} · ${question.text}`.slice(0, 220) : title,
          cfg.notificationsSound,
          // Stessa chiave della push gemella (server/push-triggers.ts): la
          // consegna esce da due porte e lascia UNA riga.
          { dedupeKey: taskReviewNotificationKey(taskId) },
          taskId,
          undefined,
          actions,
        );
      });
  });

  // ── Il gemello di FALLIMENTO ───────────────────────────────────────────
  // Un task parcheggiato non riparte da solo: o l'umano lo rimette in Todo, o
  // resta lì. Finora moriva in silenzio — il dispatcher emetteva il solo
  // `task:updated`, che nessun layer di notifica ascolta (è un refresh di
  // dati), quindi il fronte terminale di successo aveva banner e push e quello
  // di fallimento niente. Il server lo manda solo sul park TERMINALE (mai su
  // una rimessa in coda, vedi `releaseAndEmit` nel dispatcher).
  // Stesse regole del gemello: nessun gate di focus (un task fermo è azionabile
  // comunque), cooldown 10s sulla sua chiave, `taskId` per il click.
  useWSSubscription(onWSMessage, 'task:parked', (msg) => {
      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;
      const taskId = msg.taskId;
      if (!taskId) return;
      const key = `task-park:${taskId}`;
      const now = Date.now();
      const last = cooldownRef.current.get(key) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(key, now);
      const title = (msg.taskTitle || 'Task').slice(0, 140);
      // Tre domande diverse per l'umano: 'blocked' chiede di sistemare una
      // configurazione, 'failed' dice che l'agent non ha prodotto niente,
      // 'waited_out' dice che una condizione esterna non è arrivata.
      //
      // Il terzo non riusa nessuno degli altri due titoli, ed è il motivo per
      // cui esiste come stato a sé: l'agent ha fatto la cosa giusta (ha
      // dichiarato l'attesa invece di dormirci sopra) e non c'è niente da
      // sistemare, quindi «da sistemare» o «non consegnato» accuserebbero il
      // turno di un difetto che non ha. Il titolo non nomina neanche quanto ha
      // aspettato: il tetto sul CONTEGGIO delle attese può scattare in pochi
      // minuti, e una durata lì sarebbe una bugia (stessa cautela della nota di
      // sistema che scrive `deferForWait`).
      fire(
        'task:parked',
        msg.state === 'blocked'
          ? 'Task da sistemare'
          : msg.state === 'waited_out'
            ? 'Task in attesa, decidi tu'
            : 'Task non consegnato',
        title,
        cfg.notificationsSound,
        { dedupeKey: taskParkedNotificationKey(taskId) },
        taskId,
        undefined,
        // Un parcheggiato non riparte da solo: il tasto è la mossa che lo fa
        // ripartire, cioè rimetterlo in Todo.
        buildNotifyActions({ kind: 'parked' }),
      );
  });

  // ── Banner del messaggio a finestra nascosta ───────────────────────────
  // Un messaggio dell'assistente arrivato mentre non guardavi. Viveva in
  // `usePanelLifecycle`, dentro il cluster WS che sincronizza i messaggi, e da
  // lì chiamava `notifyNative` di suo — cioè fuori da questa porta, e quindi
  // fuori da TUTTI i suoi gate: suonava a topic silenziato, suonava con un Focus
  // attivo, suonava con l'interruttore generale delle notifiche spento. Tre
  // promesse dell'interfaccia che quel percorso non manteneva.
  //
  // I gate che quel sito aveva davvero — e che qui restano — erano due, e
  // impliciti: stavano nel `return` di un `if` PRECEDENTE dello stesso handler
  // (isOwnStream, corpo vuoto), non in una condizione del banner. Ora sono
  // scritti, perché una soppressione che dipende dall'ordine delle righe non è
  // una regola: è una coincidenza che il prossimo refactor rompe in silenzio.
  //
  // L'ordine conta: prima tutti i gate SINCRONI, la claim per ultima. Una
  // finestra che comunque tacerebbe non deve potersi mangiare la consegna di una
  // che invece parlerebbe.
  useWSSubscription(onWSMessage, 'message:new', (msg) => {
      const cfg = settingsRef.current;
      const task = taskForTopicRef.current?.(msg.topicId) ?? null;
      const decision = decideMessageBanner({
        topicId: msg.topicId,
        role: msg.role,
        visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'hidden',
        notificationsEnabled: cfg.notificationsEnabled,
        isOwnStream: isOwnStreamRef.current?.(msg.sessionKey) ?? false,
        body: msg.preview || msg.content || '',
        topicName: topicsRef.current[msg.topicId]?.name,
        muted: isTopicMuted(msg.topicId),
        agentWorking: isAgentWorking(task?.dispatchState),
        lastFiredAt: cooldownRef.current.get(`msg:${msg.topicId}`),
        now: Date.now(),
      });
      if (!decision) return;
      cooldownRef.current.set(decision.cooldownKey, Date.now());

      // Una consegna per MESSAGGIO, non una per finestra. Il frame è un
      // broadcast: con i gruppi staccati lo ricevono N finestre, e i gate qui
      // sopra sono veri in tutte contemporaneamente — nessuno di loro può
      // scegliere. Serve un fatto condiviso, ed è la claim.
      //
      // Ultima, e apposta: una finestra che comunque tacerebbe non deve potersi
      // mangiare la consegna di una che invece parlerebbe.
      void claimMessageBanner(bannerClaimKey(msg), bannerClaimant()).then((mine) => {
        if (!mine) return;
        // La chiave è quella della CHAT, condivisa con la push di fine risposta
        // (`stream:end`): nomi diversi, stesso fatto per chi la riceve — la
        // risposta è pronta. Il bersaglio è il topic, così il click apre la
        // conversazione.
        fire(
          'message:new',
          decision.title,
          decision.body,
          cfg.notificationsSound,
          { dedupeKey: chatNotificationKey(msg.topicId), topicId: msg.topicId },
          null,
          decision.tag,
        );
      });
  });

  // ── Claude Code session-state notifier ─────────────────────────────────
  // Surface a toast on the lifecycle phase transitions the user actually
  // needs to react to. The full set of phases is in client/src/types
  // (ClaudeSessionPhase); we only fire for the three that are *actionable*
  // or *terminal*:
  //   awaiting-user      → Claude finished its turn and is waiting on input
  //   awaiting-approval  → Claude wants permission to run a tool
  //   error              → the session crashed; user must intervene
  //   completed          → success ack so background work surfaces
  // Same gating rules as the agents:sessions handler above (master enable,
  // focused-pane suppression, sound toggle, 10s per-topic cooldown).
  //
  // The phase comes from claude-session-tracker (server/lib). Without this
  // bridge the WS event was being received but ignored on the client.
  const prevPhaseRef = useRef<Map<string, ClaudeSessionPhase>>(new Map());
  // Terminal-session phase tracking (sessionKey is null for these — the chat
  // handler below early-returns on them). Keyed by claudeSessionId, which is
  // STABLE across WS reconnect / roster churn (the terminal id can be reused).
  const prevTermPhaseRef = useRef<Map<string, ClaudeSessionPhase>>(new Map());
  // Fired-banner ledger for terminals, keyed by `<terminalId>:<phase>:<rev>`.
  // The dedupe guard so a reconnect bootstrap re-broadcasting the same state
  // (session:state is transition-only, but the bootstrap replays the snapshot)
  // never re-banners an event we already showed. Bounded below on each event.
  const firedTermBannersRef = useRef<Set<string>>(new Set());
  useWSSubscription(onWSMessage, 'session:state', (msg) => {
      const state = msg.state;
      if (!state) return;

      // ── Terminal Claude Code sessions (sessionKey === null) ──────────────
      // These publish state keyed off claudeSessionId; the chat resolution
      // below can't find them (it scans topics by sessionKey). Route them
      // through the terminal notifier so they get the SAME OS-banner semantics
      // as chats: "your turn"/approval/completed/error, with the tab name as
      // title and the approval question as body. All the suppression/dedupe
      // lives in the pure `decideTerminalBanner` + the ledger below.
      if (!msg.sessionKey) {
        const csid = state.claudeSessionId;
        if (!csid) return;
        const cfg = settingsRef.current;
        if (!cfg.notificationsEnabled) {
          // Keep the baseline current so re-enabling mid-session doesn't burst.
          prevTermPhaseRef.current.set(csid, state.phase);
          return;
        }

        // Resolve the roster entry for this claude session → terminal id, name,
        // owning topic. Without a roster row we can't attribute the banner (no
        // id to key focus/dedupe on, no name) — skip; the pty fallback still
        // covers a genuinely hook-less session.
        const ts = terminalSessionsRef.current.find((t) => t.claudeSessionId === csid);
        if (!ts) {
          prevTermPhaseRef.current.set(csid, state.phase);
          return;
        }

        // Per-topic / per-project mute — a silenced topic's terminal session
        // never banners. Keep the baseline current so unmuting mid-session
        // doesn't replay a stale transition as a burst.
        if (isTopicMuted(ts.topicId)) {
          prevTermPhaseRef.current.set(csid, state.phase);
          return;
        }

        const prevPhase = prevTermPhaseRef.current.get(csid);
        prevTermPhaseRef.current.set(csid, state.phase);

        // Focus suppression: `isTerminalPaneSelected` decide se questo terminale
        // è la tab davvero selezionata — confronto ESATTO (mai substring: un pane
        // diverso il cui id contiene questo id non deve poter zittire il banner
        // altrui) e consapevole dell'annidamento, perché un terminale dentro una
        // finestra progetto lascia il `focusedPanelId` di App su `project:<path>`
        // e il confronto secco era sempre falso. Il gate hasFocus() resta
        // load-bearing: `focusedPanelId` è solo "quale tab è selezionata" e non si
        // azzera quando l'app va in background, quindi senza di lui una finestra
        // sullo sfondo avrebbe ingoiato proprio il banner che serve.
        const focused = focusedRef.current;
        const isFocusedAndVisible = isTabActivelyVisible(
          isTerminalPaneSelected(ts.id, focused, useProjectFocusStore.getState().activePaneByProject),
          typeof document !== 'undefined' ? document.hasFocus() : true,
        );

        const topicName = ts.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
        const decision = decideTerminalBanner({
          terminalId: ts.id,
          phase: state.phase,
          prevPhase,
          rev: state.rev,
          pendingApproval: state.pendingApproval,
          name: ts.name,
          fallbackTitle: topicName,
          isFocusedAndVisible,
          notifyEvenWhenFocused: cfg.notifyEvenWhenFocused,
        });
        if (!decision) return;

        // Dedupe ledger — the last guard against a reconnect replay re-firing an
        // event we already showed (decideTerminalBanner suppresses same-phase
        // repeats, but a bootstrap can present the same transition afresh with a
        // reset prevPhase). Bound the set so it can't grow unboundedly on a
        // long-lived always-mounted hook.
        const ledger = firedTermBannersRef.current;
        if (ledger.has(decision.dedupeKey)) return;
        ledger.add(decision.dedupeKey);
        if (ledger.size > 500) {
          // Evict oldest ~half (insertion order) — cheap and rare.
          const keep = Array.from(ledger).slice(-250);
          ledger.clear();
          for (const k of keep) ledger.add(k);
        }

        // La chiave del registro è la STESSA del libro mastro qui sopra: se
        // quello ha già lasciato passare questo fronte una volta, la
        // cronologia non deve poterlo contare due.
        //
        // Il bersaglio è il TOPIC che ospita il terminale, quando c'è: il click
        // non può selezionare la singola tab di terminale (non esiste una rotta
        // per quello), ma atterrare nel topic giusto è la differenza fra una
        // riga viva e una riga morta. Senza topic la riga resta leggibile e non
        // cliccabile.
        fire(
          'session:state',
          decision.title,
          decision.body,
          cfg.notificationsSound,
          { dedupeKey: `terminal:${decision.dedupeKey}`, topicId: ts.topicId },
        );
        return;
      }

      const sessionKey = msg.sessionKey;
      const phase = state.phase;
      const prev = prevPhaseRef.current.get(sessionKey);
      prevPhaseRef.current.set(sessionKey, phase);
      // Transizione VERA, non lo snapshot del bootstrap che ci ripresenta il
      // passato. Qui c'era solo `if (prev === phase) return`, che sul primo
      // frame — mappa vuota, `prev` undefined — non ferma niente: a ogni avvio
      // dell'app ogni chat parcheggiata in `awaiting-user`/`completed` sparava
      // il suo banner. Sei riavvii in una sera, sei raffiche di notifiche per
      // lavoro finito giorni prima.
      //
      // Il ramo terminale qui sopra la guardia ce l'aveva, e il suo commento
      // diceva «mirrors the chat path's isFirstFrame guard» descrivendo una
      // guardia che in questo ramo non è mai esistita. Ora l'implementazione è
      // UNA sola, pura e testata (lib/notify/terminalNotify.ts).
      if (!isRealPhaseTransition(prev, phase)) return;

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;

      const isActionable =
        phase === 'awaiting-user' ||
        phase === 'awaiting-approval' ||
        phase === 'error' ||
        phase === 'completed';
      if (!isActionable) return;

      // Resolve the friendly topic name. The session-key convention for
      // Topics chats is `topic:<8-char-id>`; we scan the topics map for the
      // first one whose `sessionKey` matches. Falls back to a generic label.
      let topicId: string | null = null;
      let label = 'Claude';
      for (const t of Object.values(topicsRef.current)) {
        if (t.sessionKey === sessionKey) {
          topicId = t.id;
          label = t.name || 'Claude';
          break;
        }
      }

      // Il task che questo topic sta lavorando, se ce n'è uno. Serve due volte:
      // per zittire la fine turno di un agente di board (subito sotto) e per far
      // viaggiare il `taskId` dentro al banner (più giù), così un click apre il
      // drawer del task.
      const task = topicId ? (taskForTopicRef.current?.(topicId) ?? null) : null;

      // Un agente di board al lavoro: la fine di un suo turno non è un evento per
      // l'umano — o il dispatcher rilancia, o arriva `task:review-ready` col suo
      // banner, più informativo. Senza questo, una consegna sola ne produceva
      // due quasi identici (il nome del topic È il testo del task).
      // Il taglio sta PRIMA della cooldown di proposito: scrivere la chiave qui
      // mangerebbe il banner di review che nella consegna di sistema arriva
      // DOPO. Vedi lib/notify/dispatchedTopic.ts.
      if (isAgentTurnNoise(phase, task?.dispatchState)) return;

      const focusedTopicId = topicIdFromPanel(focusedRef.current);
      // Only suppress when the user is ACTIVELY looking at this chat — its tab is
      // selected AND the window has OS focus. focusedPanelId doesn't clear on
      // window blur, so gate on document.hasFocus() (same fix as the terminal
      // path) or a backgrounded window with this tab active would eat the banner.
      const isFocused = isTabActivelyVisible(
        topicId !== null && topicId === focusedTopicId,
        typeof document !== 'undefined' ? document.hasFocus() : true,
      );
      if (isFocused && !cfg.notifyEvenWhenFocused) return;
      // Per-topic / per-project mute — silence the banner+sound but let the
      // badge (attention rollup) still count the completion.
      if (isTopicMuted(topicId)) return;

      // 10s cooldown. Key by topicId FIRST so this phase notification and the
      // agents:sessions completion (which keys by topicId) collapse into ONE
      // toast for the same chat instead of double-firing. Fall back to
      // claudeSessionId / sessionKey when no topic resolved. (This handler only
      // runs for chats — it early-returns on a null sessionKey above — so the
      // pty `terminal:activity` path never collides here.)
      const cooldownKey = topicId || state.claudeSessionId || sessionKey;
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(cooldownKey, now);

      // Dispatched-task topic → the banner carries the taskId so a click opens it.
      const taskId = task?.taskId ?? null;

      // LA RIGA DI REGISTRO di questo banner, una per tutti e quattro i rami.
      //
      // La chiave ha due forme, e la differenza non è estetica.
      // `awaiting-user` e `completed` sono «il turno è finito», cioè lo STESSO
      // evento che la push di fine risposta annuncia sul telefono: chiave
      // condivisa (`chat:<topicId>`) e una riga sola per i due mezzi.
      // `awaiting-approval` e `error` la push non li manda affatto, e
      // collassarli con la fine turno perderebbe la notizia più importante
      // delle due — quindi chiave propria, per fase.
      const turnEnded = phase === 'awaiting-user' || phase === 'completed';
      const log = {
        dedupeKey: topicId && turnEnded
          ? chatNotificationKey(topicId)
          : `session:${topicId || state.claudeSessionId || sessionKey}:${phase}`,
        topicId,
      };
      // Il corpo lo scrive `statusBody`, la stessa funzione del ramo terminale:
      // una frase sola per due superfici.
      switch (phase) {
        case 'awaiting-user':
          fire('session:state', label, statusBody('awaiting-user'), cfg.notificationsSound, log, taskId);
          break;
        case 'awaiting-approval':
          fire('session:state', label, statusBody('awaiting-approval'), cfg.notificationsSound, log, taskId);
          break;
        case 'completed':
          fire('session:state', label, statusBody('completed'), cfg.notificationsSound, log, taskId);
          break;
        case 'error':
          fire('session:state', label, statusBody('error'), cfg.notificationsSound, log, taskId);
          break;
      }
  });

  // ── pty-`finished` notifier (the safety net) ───────────────────────────
  // The authoritative completion cue is the `session:state` awaiting-user /
  // completed path above, driven by Claude Code's hooks. This pty path is ONLY
  // a fallback for genuinely hook-less sessions: the server emits a pty-derived
  // `terminal:activity { finished:true, kind:'claude-code' }` after ~1.5s of
  // output silence, which is a CRUDE proxy — a session pauses mid-turn many
  // times (a sub-agent running quietly, the model thinking), and each lull used
  // to fire a false "lavoro completato" (the Japan-with-shells symptom).
  //
  // Guard: trust the phase machine. If it currently classes this session as
  // actively working (running/tool-running), the pty going quiet is a MID-TURN
  // pause — suppress. Only when the phase is NOT active (hook-less session stuck
  // at `starting`, or already resting) do we let the pty signal through. Dedup
  // is keyed by claudeSessionId, the SAME key the phase path uses, so a hooked
  // session that emits BOTH only notifies once.
  useWSSubscription(onWSMessage, 'terminal:activity', (msg) => {
      if (!msg.finished) return;
      if (msg.kind !== 'claude-code' && msg.kind !== 'claude-code-team') return;

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;

      // Trust the phase machine whenever it has an authoritative opinion on this
      // session — the pty path is ONLY for genuinely hook-less sessions.
      //   - active (running/tool-running): the pty quieting is a mid-turn lull
      //     (sub-agent / thinking), NOT a finished turn — the `Stop` hook drives
      //     the real notification via session:state. Suppress.
      //   - resting (awaiting-user/completed/paused/error/dormant): the turn
      //     already ended and session:state already notified (or it's a plain
      //     idle repaint) — a pty blip here is the "Japan fires a second random
      //     toast" symptom. Suppress.
      // Only a session in NEITHER set (no phase signal at all / stuck at
      // `starting`) falls through to this crude pty fallback.
      const sig = useSignalsStore.getState();
      if (sig.claudePhaseActiveTermIds.has(msg.id) || sig.claudePhaseRestingTermIds.has(msg.id)) return;

      const ts = terminalSessionsRef.current.find((t) => t.id === msg.id);
      // Per-topic / per-project mute — silence the fallback banner too.
      if (isTopicMuted(ts?.topicId)) return;
      // Focus suppression, STESSA regola del percorso phase-based sopra: qui il
      // confronto era `focused.includes(msg.id)`, cioè proprio la substring che
      // l'altro ramo si era già tolto — un pane diverso il cui id contiene questo
      // id zittiva un banner che non era suo. Ora entrambi passano dall'unico
      // predicato, che è anche l'unico a vedere i terminali dentro un progetto.
      const focused = focusedRef.current;
      const isFocused = isTabActivelyVisible(
        isTerminalPaneSelected(msg.id, focused, useProjectFocusStore.getState().activePaneByProject),
        typeof document !== 'undefined' ? document.hasFocus() : true,
      );
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      const cooldownKey = ts?.claudeSessionId || `terminal:${msg.id}`;
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(cooldownKey, now);

      const topicName = ts?.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
      const label = ts?.name || topicName || 'Claude Code';
      // Stessa chiave della cooldown qui sopra: questo ripiego e il percorso
      // phase-based non devono poter lasciare due righe per la stessa fine
      // turno, esattamente come non lasciano due banner.
      fire(
        'session:state',
        label,
        statusBody('completed'),
        cfg.notificationsSound,
        { dedupeKey: `terminal:${cooldownKey}`, topicId: ts?.topicId },
      );
  });
}

/**
 * Renderless component that wires up `useCompletionNotifier`. Drop it
 * inside `<ToastProvider>` (it depends on the toast context).
 */
export function CompletionNotifierBridge(props: CompletionNotifierProps) {
  useCompletionNotifier(props);
  return null;
}
