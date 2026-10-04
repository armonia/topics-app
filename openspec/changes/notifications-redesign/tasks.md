# Tasks: notifications-redesign

Prima del codice: `grep -qx 'status: approved' openspec/changes/notifications-redesign/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

**Barra.** Si esegue uguale a ogni giro:
1. `bun run typecheck` (client e server);
2. `TOPICS_GATE_HELD=targeted bun test` sui file di 1.x, `server/attention/`,
   `client/src/state/attention*.test.ts`, più i test esistenti dei moduli toccati
   (`server/push-triggers*.test.ts`, `server/lib/claude-session-state*.test.ts`,
   `server/lib/claude-session-tracker*.test.ts`, `server/subject-seen*.test.ts`,
   `client/src/state/signals*.test.ts`, `client/src/state/attentionTotal*.test.ts`,
   `client/src/lib/notify/`, `client/src/lib/waitingQueue.test.ts`,
   `client/src/lib/buildSidebarItems*.test.ts`,
   `server/providers/claude/background-work*.test.ts`);
3. `bunx playwright test tests/e2e/attention-*.spec.ts tests/e2e/chat-finished-banner.spec.ts tests/e2e/chat-next-waiting.spec.ts --project=chromium`
   sul server isolato :13334 (sul Mac con una config locale che dà al progetto chromium
   `browserName: "webkit"`).

Quello che è verde resta verde. Le suite intere le fa la CI.

## 1. Test rossi sul tree di oggi

Ognuno nasce dal repro in `evidence/`, riscritto contro il contratto nuovo. Oggi sono
rossi; diventano verdi con le sezioni 2 e 3.

- [x] 1.1 `server/routes/chat.background-turn-end.test.ts` (D1, bgwait-1): sulla rotta
  vera col provider registrato e la sessione registrata del 25/09
  (`background-work.fixture.ts`), un turno che lancia Agent, Bash e Monitor chiude con
  `stream:end.background.count = 3`, stato `background`, zero righe di cronologia, zero
  spinte. Il turno 8 della fixture (`background=none`) porta a `finished(done)` con UNA
  epoca nuova per tutta la sessione. Un turno che crea un cron ricorrente chiude con
  `background.count = 0` e `finished(done)`, mentre `backgroundOfTurn` dice ancora
  `backgroundWork: true` al goal loop.
- [x] 1.2 `server/lib/claude-session-state.background-tasks.test.ts` (D2, A, bgwait-2):
  chat e terminale, Bash e Agent con `run_in_background`, Workflow, CronCreate non
  ricorrente → `watching`; CronCreate ricorrente (nella mappa, segnato ricorrente) e Bash
  in primo piano → `awaiting-user`;
  il Monitor scaduto della fixture `claude-cli-2.1.285-monitor-wakes.transcript.jsonl`
  esce dall'insieme; uno di due tornati resta `watching`.
- [x] 1.3 `server/attention/holds.test.ts` (D6, D8): `PreToolUse` di
  `mcp__topics__ask_user_question` e l'evento del bridge danno `needs-you(question)`;
  il permission bridge dà `needs-you(permission)`; il pannello del piano dà
  `needs-you(plan)` e nessuna riga `chat-message`. Con la sessione di una card
  `in_progress` l'attesa va su `task:<id>` (`needs-you(permission)`) e il topic resta
  `idle`; la risposta la spegne.
- [x] 1.4 `server/routes/chat.empty-wake.test.ts` (D7): turno risvegliato scartato →
  non-letto invariato, nessuna epoca.
- [x] 1.5 `server/attention/born-seen.test.ts` (D3): con zero iscrizioni e una socket
  sveglia a fuoco sul soggetto, la riga nasce vista e nessuna spinta parte; con la socket
  non sveglia la riga nasce non vista, una sola; con solo una socket OSPITE sveglia a
  fuoco la riga nasce non vista.
- [x] 1.6 `client/src/state/attention.surfaces.test.ts` (BG-1…4, BELL-1, TERM-1, TERM-2,
  ARCH-1, bgwait-3): i nove casi di `evidence/client-surfaces-disagree.test.ts.txt` e il
  caso di `bgwait-3`, scritti su `attentionOf`, `rollupAttention` e il conteggio del
  chrome a partire da frame `attention:*`.
- [x] 1.7 `server/services/tasks.parked-requeue.test.ts` (D4, F3): park → todo spegne il
  soggetto e segna vista la riga `task-parked`; anche cancellata e archiviata.
- [x] 1.8 `server/services/archive-topic.attention.test.ts` (ARCH-1, B3/C): dopo
  `archiveTopicFully` il soggetto è `idle` e le righe sono viste; un turno risvegliato
  dopo non crea epoche.
- [x] 1.9 `server/attention/seen-door.test.ts` (E, B4): la porta annuncia anche senza
  righe; un visto per l'epoca 4 non spegne la 5; un `turnAt` vecchio non copre il turno
  dopo; una socket ospite viene scartata; un visto in `background` porta T7 a `idle`,
  senza visto T7 dà `finished(done)`.
- [x] 1.10 `client/src/hooks/useCompletionNotifier.background.test.ts` (D1, BG-2): finestra
  principale nascosta, tre `message:new` di turni risvegliati e i frame `attention:*`
  della stessa attesa → zero banner fino all'annuncio, poi UNO.
- [x] 1.11 `server/attention/process-ended.test.ts` (ATTN-15): reaper su una chat vista e
  senza compiti → nessuna epoca; tetto di vita con un Agent in volo → `finished(error)`;
  `markPtyCrash` su un terminale in `working` → `finished(error)`; riavvio senza processo
  con un compito in volo → `finished(error)` con `live: false`.
- [x] 1.12 `server/attention/recompose.test.ts` (ATTN-07, ATTN-13): ricarico con una chat
  `finished(done)` non vista all'epoca 7 e una card in review → stesse epoche, nessuna
  riga; unarchive di una chat archiviata mentre era finita → `idle`, nessuna epoca;
  tombstone della pane di un terminale finito → `idle`, riga vista.
- [x] 1.13 `client/src/lib/buildSidebarItems.attention.test.ts`,
  `client/src/lib/waitingQueue.test.ts`, `BoardTabCounts` (ATTN-14, ATTN-16,
  CHAT-WAIT-03): una chat senza tab accesa resta, vista sparisce dalla cima (F5); la coda
  di ⌘J nasce da `needs-you` e prende il piano nativo, non `finished`; la tab board conta
  review + parcheggio + attesa a metà turno.

## 2. Server

- [ ] 2.1 Copia di `data/topics.db` e `-wal`, poi la migration solo schema
  `<ts>-subject-attention.sql` (design §2.1). Test che la esegue su un DB sintetico,
  come `tests/integration/migration-074-messages-timestamp-index.test.ts`; manifest
  embedded rigenerato.
- [x] 2.2 `server/attention/compose.ts`: funzione pura. Test a tabella sulle nove regole
  di precedenza e sulle transizioni T1…T17 di design §4.
- [x] 2.3 `server/attention/store.ts`: epoca legata alla causa (design §4.1), visto con
  `seen_epoch` e `seen_at`, scrittura, `attention:init` a ogni apertura della socket della
  persona, `attention:updated` anche al cambio del solo non-letto o di `turnUnseen`.
  Test: epoca +1 solo per una causa nuova; la stessa causa ricomposta non fa epoche;
  istantanea con `live: false`.
- [x] 2.4 `providers/claude/background-work.ts`: `attentionBackground` (compiti vivi,
  `wake-queued`, cron non ricorrenti), `backgroundState` invariato per il goal loop.
  `routes/chat.ts`: `background` nel frame `stream:end` da `attentionBackground`;
  `finalizeTurnActivity` solo con un messaggio visibile; il pannello del piano apre
  `hold(plan)`; un errore con `resumesByItself` non fa epoca. Fa passare 1.1, 1.4.
- [x] 2.5 `lib/claude-session-state.ts` e `claude-session-tracker.ts`: i compiti per id
  scritti nello store (unico detentore) al posto di `monitorArmed`, e `applyHook` che allo
  `Stop` riceve dallo store il numero di compiti che contano;
  `mcp__topics__ask_user_question` fra i tool di attesa; `wire.ts` ascolta
  `human-hold-events` e, per la sessione di una card in volo, scrive l'attesa su
  `task:<id>` (il dispatcher espone la sua ricerca sessione → card). Fa passare 1.2, 1.3.
- [x] 2.6 Annunci (design §10.1): riga scritta dallo store, `announce` nel frame, spinta
  per ogni annuncio non nato visto col numero corrente nel payload, cancelli di silenzio,
  archiviato e agente di board (Non disturbare resta nel client). `maybeSendPush` esce da
  `broadcastToAll`; review e parcheggio passano dalle
  transizioni dei soggetti `task:`; via il ramo `approval:created`. Test: i casi di
  ATTN-11, compreso «una chat archiviata si risveglia» (F2); i test esistenti di
  `push-triggers` riscritti sul punto nuovo, nessuno cancellato senza il suo gemello.
  Fa passare 1.5.
- [x] 2.7 La porta del visto `POST /api/attention/seen` con `{subject, epoch, turnAt}`;
  `POST /api/topics/:id/read` e `/api/notifications/seen` come alias; frame `focus` con
  `{subject, awake}`, registrato per il nato visto solo dalle socket della persona;
  `lib/grants.ts` tiene `attention:*` fuori dagli ospiti. Fa passare 1.9.
- [x] 2.8 Avvisi di sistema (ATTN-10): swap-freeze, riavvio trattenuto e GC dei worktree
  scrivono `kind: 'system'` su `system:<chiave>`, una riga per ciclo. Test: un ciclo
  congela/scongela = una riga, nessun soggetto `topic:` acceso.
- [x] 2.9 Test di confine con `git grep`: solo `server/attention/store.ts` scrive
  `subject_attention`, e nessun file fuori da lì scrive righe di tipo `chat-message`,
  `session` o `chat-error`.
- [x] 2.10 `archive-topic.ts`, cancellazione, unarchive (`routes/topics.ts:254-376`),
  `services/tasks.ts`, pane store e bridge PTY: archiviato, cancellato, terminale chiuso
  e stato della card come ingressi; T13 segna viste epoca e ultimo turno. Fa passare 1.7,
  1.8.
- [x] 2.11 Ricomposizione a ogni avvio (ATTN-07, T19): rilettura degli ingressi riletti,
  `processEnded { cause: 'restart' }` ai soggetti senza processo vivo, `live: false`;
  tabella vuota → solo ingressi veri. Test sul DB sintetico. Fa passare 1.12.
- [x] 2.12 `processEnded` (ATTN-15): `SessionEnd`, uscita del PTY e del figlio CLI, reaper,
  tetto di vita, `markPtyCrash`, uccisione dello swap. Fa passare 1.11.

## 3. Client

- [x] 3.1 `client/src/state/attention.ts`: store da `attention:init` (sostituisce) e
  `attention:updated` (applica); `attentionOf`, `rollupAttention`, conteggio del chrome.
  Test unitari.
- [x] 3.2 `useSignalsSync.ts` e `signals.ts`: via `chatFinishedTopics`,
  `terminalFinishedIds`, `claudeAttentionTopics`, `reconcileTerminalSignals` e gli insiemi
  di attesa come fonti di attenzione; `backgroundWorkTopics` e `state/backgroundWork.ts`
  non alimentano più glifo, `StreamingIndicator`, `BackgroundWorkLine` e Stop (il poll
  resta per `runningServices.ts`); `seenSubjects` resta solo come ottimismo. I test esistenti che fissano i
  segni per finestra si riscrivono sul contratto nuovo, uno per uno.
- [x] 3.3 Superfici: `PaneTabBar.tsx`, `TabSlot.tsx`, `TopicItem.tsx`, `TopicTree.tsx`
  (righe dei terminali), `useSpaceCards.ts`, `buildSidebarItems.ts` (vista per stato con
  le quattro sezioni; presenza e ordine da `lit` e `since`, via `lastNotifiedAt`), menu
  agenti, `BackgroundWorkLine.tsx`, `StreamingIndicator`, Stop del composer,
  `BoardTabCounts.tsx` (numero da `rollupAttention` dei `task:`, via la cache del numero).
  Fa passare 1.6, 1.13.
- [x] 3.4 Conteggio: `attentionTotal.ts` e `useTabNotifications.tsx` contano i soggetti
  accesi; via `useUnseenNotificationsStore` e `extraCounts` dal numero; numero su tab e
  riga solo se acceso (TAB-BADGE-01, PARITY-01 modificati); la tray elenca chat e
  terminali contati. Test di parità di CHROME-COUNT-01: righe di sidebar accese + numero
  della tab board generale = numero del chrome.
- [x] 3.5 `useCompletionNotifier.tsx`: banner solo da `announce`, claim su
  `subject#epoch`, poi il cancello di Non disturbare (QUIET-01); via i rami
  `session:state`, `stream:end` e `message:new` (`decideMessageBanner`) e i POST di righe.
  Test: la chat a fuoco con l'impostazione spenta non suona (difetto D); due finestre un
  banner; 1.10.
- [x] 3.6 `paneSeen.ts` e `useWebSocket.ts`: la soglia di visto manda `{subject, epoch}`
  alla porta nuova (`{subject, epoch, turnAt}`, anche in `background` con `turnUnseen`);
  `focus` con soggetto e veglia a ogni cambio di pane e di `visibilitychange`.
- [x] 3.7 `lib/waitingQueue.ts` e il gestore di ⌘J (CHAT-WAIT-03 modificato): mete da
  `attentionOf` (`needs-you` con `question`, `permission`, `plan`), sezione «Ti aspetta»;
  `handleTerminalRowClick` manda il visto. `waitingCount` (`App.tsx:1359`) e la porta di
  CHAT-WAIT-04 leggono la stessa coda, invariati. Fa passare 1.13.
- [x] 3.8 PWA: a ogni `attention:init` ritira con `registration.getNotifications()` le
  notifiche dei soggetti non più accesi e riscrive il badge; `sw.js` scrive sul badge il
  numero del payload della spinta. Test sul selettore delle notifiche da ritirare.

## 4. Inbox e desktop

- [x] 4.1 `components/Sidebar/Inbox.tsx` al posto di `NotificationHistoryButton.tsx`:
  tasto, popover, foglio sotto i 768 px, linguette «Ora» e «Cronologia» (design §9).
- [x] 4.2 Sezioni «Ti aspettano» e «Finite», righe, azioni, «Segna visto», «Segna tutte
  viste», apertura sul punto (domanda, cassetto della card).
- [x] 4.3 Riga quieta «N in background · M al lavoro», che si apre sul posto.
- [x] 4.4 i18n `lib/i18n-it.ts` e `lib/i18n-en.ts`.
- [x] 4.5 `desktop-tauri/src-tauri/src/lib.rs`: `set_app_status` solo dalla finestra
  principale; il client lo chiama solo da lì. Test Rust sull'etichetta del chiamante.
- [x] 4.6 Scorciatoia «Apri Da guardare» nel registro di oggi `shared/shortcuts.ts`, con
  `shortcuts_generated.rs` rigenerato; default ⇧⌘I se libera nel registro, se no la prima
  libera fra ⇧⌘N e ⌥⌘I, scritta qui. Nessuna dipendenza da `remappable-shortcuts`.

## 5. E2E sul server di test vero

Niente frame iniettati con `page.routeWebSocket` per gli stati di attenzione: si pilota il
server (rotta degli hook, provider finto). Ogni spec lascia il `.webm`.

- [x] 5.1 `tests/e2e/attention-background.spec.ts`: un terminale con hook lancia un Bash in
  background e fa `Stop` → nessun fill, numero o voce in inbox, glifo grigio, riga quieta
  «1 in background»; arriva la `task-notification` e lo `Stop` → blu, inbox 1, un banner.
- [x] 5.2 `tests/e2e/attention-sync.spec.ts`: due pagine; visto in A spegne B; ricarico di
  B non riaccende; socket chiusa e riaperta in B dopo un visto in A → B spenta senza
  aprire la inbox.
- [x] 5.3 `tests/e2e/attention-inbox.spec.ts`: aprire non spegne; Invio su una `Finite`;
  `E` e ⇧`E`; una domanda resta; tastiera sola; 390 px col foglio e lo scorrimento.
  Screenshot chiaro e scuro, desktop e 390 px.
- [x] 5.4 `tests/e2e/attention-archive-park.spec.ts`: chiudere la tab di una chat finita
  cala il numero; una card parcheggiata rimessa in coda esce dalla inbox.
- [ ] 5.5 `tests/e2e/chat-finished-banner.spec.ts`, `chat-next-waiting.spec.ts` e le
  altre spec che iniettano `stream:end`, `session:state` o `unread:updated` per
  l'attenzione o per i badge (TAB-BADGE, PARITY): riscritte sul server vero o su frame
  `attention:*`, nessuna cancellata senza un gemello. Fatte: chat-finished-banner,
  chat-next-waiting, notification-history, notifications-one-truth, mute-and-badge,
  message-banner-single-delivery, tab-notifications, tab-state-view, tab-one-slot,
  tab-widget-geometry, split-badge-focus, space-card-seen, project-tab-seen,
  project-badge-attributable, unread-clearing, unread-badge-cross-client,
  turn-awaiting-input, chat-streaming-indicator, pane-zoom, profile-menu,
  topic-management-org, motion-floating-surfaces, sidebar-header-fit, user-menu-*
  (e i testid della campanella in window-chrome-inset e mobile-chrome-bar). Resta `seen-on-any-focus.spec.ts` (8 prove,
  rosse su questo ramo): inietta `stream:end`/`terminal:activity` e legge le righe di
  cronologia che il client non scrive più; va riscritta sul server vero.
- [x] 5.6 `tests/e2e/attention-board-sidebar.spec.ts`: una card che chiede un permesso a
  metà turno compare in inbox e sulla tab board, e la risposta la spegne; una chat letta
  scende dalla cima della sidebar in entrambe le pagine. Scostamento in design.md
  («Metà e2e»): il permesso a metà turno è provato sul ponte vero di una chat, la card
  in review sulla tab board; la card in volo serve un agente lanciato davvero.

## 6. Chiusura

- [ ] 6.1 `docs/board-protocol.md` se il testo dell'envelope cita le notifiche (oggi no:
  verificarlo con `git grep -n notific server/services/task-dispatcher.ts`).
- [ ] 6.2 Dopo una release con il client nuovo: via gli alias delle porte vecchie e i frame
  `notification:new`/`notification:seen`/`unread:*` se nessun lettore resta (`git grep`).
- [ ] 6.3 Archiviare la change: le delta entrano in `notifications` e `claude-sessions`.
  Prima va sistemata `openspec/specs/claude-sessions/spec.md`, che oggi ha i requisiti
  fuori dalla sezione `## Requirements`: `openspec validate` dice che l'archivio
  rifiuterebbe la delta di MONITOR-04 finché non è corretta.
