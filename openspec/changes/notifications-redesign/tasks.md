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
   `client/src/lib/notify/`);
3. `bunx playwright test tests/e2e/attention-*.spec.ts tests/e2e/chat-finished-banner.spec.ts --project=chromium`
   sul server isolato :13334 (sul Mac con una config locale che dà al progetto chromium
   `browserName: "webkit"`).

Quello che è verde resta verde. Le suite intere le fa la CI.

## 1. Test rossi sul tree di oggi

Ognuno nasce dal repro in `evidence/`, riscritto contro il contratto nuovo. Oggi sono
rossi; diventano verdi con le sezioni 2 e 3.

- [ ] 1.1 `server/routes/chat.background-turn-end.test.ts` (D1, bgwait-1): sulla rotta
  vera col provider registrato e la sessione registrata del 25/09
  (`background-work.fixture.ts`), un turno che lancia Agent, Bash e Monitor chiude con
  `stream:end.background.count = 3`, stato `background`, zero righe di cronologia, zero
  spinte. Il turno 8 della fixture (`background=none`) porta a `finished(done)` con UNA
  epoca nuova per tutta la sessione.
- [ ] 1.2 `server/lib/claude-session-state.background-tasks.test.ts` (D2, A, bgwait-2):
  chat e terminale, Bash e Agent con `run_in_background`, Workflow, CronCreate non
  ricorrente → `watching`; CronCreate ricorrente e Bash in primo piano → `awaiting-user`;
  il Monitor scaduto della fixture `claude-cli-2.1.285-monitor-wakes.transcript.jsonl`
  esce dall'insieme; uno di due tornati resta `watching`.
- [ ] 1.3 `server/attention/holds.test.ts` (D6, D8): `PreToolUse` di
  `mcp__topics__ask_user_question` e l'evento del bridge danno `needs-you(question)`;
  il permission bridge dà `needs-you(permission)`; il pannello del piano dà
  `needs-you(plan)` e nessuna riga `chat-message`.
- [ ] 1.4 `server/routes/chat.empty-wake.test.ts` (D7): turno risvegliato scartato →
  non-letto invariato, nessuna epoca.
- [ ] 1.5 `server/attention/born-seen.test.ts` (D3): con zero iscrizioni e una socket
  sveglia a fuoco sul soggetto, la riga nasce vista e nessuna spinta parte; con la socket
  non sveglia la riga nasce non vista, una sola.
- [ ] 1.6 `client/src/state/attention.surfaces.test.ts` (BG-1…4, BELL-1, TERM-1, TERM-2,
  ARCH-1, bgwait-3): i nove casi di `evidence/client-surfaces-disagree.test.ts.txt` e il
  caso di `bgwait-3`, scritti su `attentionOf`, `rollupAttention` e il conteggio del
  chrome a partire da frame `attention:*`.
- [ ] 1.7 `server/services/tasks.parked-requeue.test.ts` (D4, F3): park → todo spegne il
  soggetto e segna vista la riga `task-parked`; anche cancellata e archiviata.
- [ ] 1.8 `server/services/archive-topic.attention.test.ts` (ARCH-1, B3/C): dopo
  `archiveTopicFully` il soggetto è `idle` e le righe sono viste; un turno risvegliato
  dopo non crea epoche.
- [ ] 1.9 `server/attention/seen-door.test.ts` (E, B4): la porta annuncia anche senza
  righe; un visto per l'epoca 4 non spegne la 5; una socket ospite viene scartata.

## 2. Server

- [ ] 2.1 Copia di `data/topics.db` e `-wal`, poi la migration solo schema
  `<ts>-subject-attention.sql` (design §2.1). Test che la esegue su un DB sintetico,
  come `tests/integration/migration-074-messages-timestamp-index.test.ts`; manifest
  embedded rigenerato.
- [ ] 2.2 `server/attention/compose.ts`: funzione pura. Test a tabella sulle nove regole
  di precedenza e sulle transizioni T1…T17 di design §4.
- [ ] 2.3 `server/attention/store.ts`: epoca, visto, scrittura, `attention:init` a ogni
  apertura della socket della persona, `attention:updated`, `GET /api/attention`.
  Test: epoca +1 solo all'ingresso in acceso o al cambio di motivo/esito; istantanea con
  `live: false`.
- [ ] 2.4 `routes/chat.ts`: `backgroundOfTurn` prima di `stream:end` e `background` nel
  frame; `finalizeTurnActivity` solo con un messaggio visibile; il pannello del piano apre
  `hold(plan)`. Fa passare 1.1, 1.4.
- [ ] 2.5 `lib/claude-session-state.ts` e `claude-session-tracker.ts`: insieme dei compiti
  per id al posto di `monitorArmed`, salvato per i terminali; `mcp__topics__ask_user_question`
  fra i tool di attesa; `wire.ts` ascolta `human-hold-events`. Fa passare 1.2, 1.3.
- [ ] 2.6 Annunci (design §10.1): riga scritta dallo store, `announce` nel frame, spinta
  solo senza desktop sveglio da 2 minuti, cancelli di silenzio, archiviato e Non
  disturbare. `maybeSendPush` esce da `broadcastToAll`; review e parcheggio passano dalle
  transizioni dei soggetti `task:`; via il ramo `approval:created`. Test: i casi di
  ATTN-11, compreso «una chat archiviata si risveglia» (F2); i test esistenti di
  `push-triggers` riscritti sul punto nuovo, nessuno cancellato senza il suo gemello.
  Fa passare 1.5.
- [ ] 2.7 La porta del visto `POST /api/attention/seen`; `POST /api/topics/:id/read` e
  `/api/notifications/seen` come alias; frame `focus` con `{subject, awake}`; il saluto
  dice il tipo di client; `lib/grants.ts` tiene `attention:*` fuori dagli ospiti.
  Fa passare 1.9.
- [ ] 2.8 Avvisi di sistema (ATTN-10): swap-freeze, riavvio trattenuto e GC dei worktree
  scrivono `kind: 'system'` su `system:<chiave>`, una riga per ciclo. Test: un ciclo
  congela/scongela = una riga, nessun soggetto `topic:` acceso.
- [ ] 2.9 Test di confine con `git grep`: solo `server/attention/store.ts` scrive
  `subject_attention`, e nessun file fuori da lì scrive righe di tipo `chat-message`,
  `session` o `chat-error`.
- [ ] 2.10 `archive-topic.ts`, cancellazione, `services/tasks.ts`: archiviato,
  cancellato e stato della card come ingressi. Fa passare 1.7, 1.8.
- [ ] 2.11 Riconciliazione all'avvio (T16, ATTN-07): soggetti senza processo vivo → `idle`
  senza annunci; tabella vuota → solo ingressi veri. Test sul DB sintetico.

## 3. Client

- [ ] 3.1 `client/src/state/attention.ts`: store da `attention:init` (sostituisce) e
  `attention:updated` (applica); `attentionOf`, `rollupAttention`, conteggio del chrome.
  Test unitari.
- [ ] 3.2 `useSignalsSync.ts` e `signals.ts`: via `chatFinishedTopics`,
  `terminalFinishedIds`, `claudeAttentionTopics` e gli insiemi di attesa come fonti di
  attenzione; `seenSubjects` resta solo come ottimismo. I test esistenti che fissano i
  segni per finestra si riscrivono sul contratto nuovo, uno per uno.
- [ ] 3.3 Superfici: `PaneTabBar.tsx`, `TabSlot.tsx`, `TopicItem.tsx`, `TopicTree.tsx`
  (righe dei terminali), `useSpaceCards.ts`, `buildSidebarItems.ts` (vista per stato con
  le quattro sezioni), menu agenti. Fa passare 1.6.
- [ ] 3.4 Conteggio: `attentionTotal.ts` e `useTabNotifications.tsx` contano i soggetti
  accesi; via `useUnseenNotificationsStore` e `extraCounts` dal numero. Test di parità di
  CHROME-COUNT-01 sugli aiutanti per riga.
- [ ] 3.5 `useCompletionNotifier.tsx`: banner solo da `announce`, claim su
  `subject#epoch`; via i rami `session:state` e `stream:end` e i POST di righe. Test: la
  chat a fuoco con l'impostazione spenta non suona (difetto D); due finestre un banner.
- [ ] 3.6 `paneSeen.ts` e `useWebSocket.ts`: la soglia di visto manda `{subject, epoch}`
  alla porta nuova; `focus` con soggetto e veglia a ogni cambio di pane e di
  `visibilitychange`.

## 4. Inbox e desktop

- [ ] 4.1 `components/Sidebar/Inbox.tsx` al posto di `NotificationHistoryButton.tsx`:
  tasto, popover, foglio sotto i 768 px, linguette «Ora» e «Cronologia» (design §9).
- [ ] 4.2 Sezioni «Ti aspettano» e «Finite», righe, azioni, «Segna visto», «Segna tutte
  viste», apertura sul punto (domanda, cassetto della card).
- [ ] 4.3 Riga quieta «N in background · M al lavoro», che si apre sul posto.
- [ ] 4.4 i18n `lib/i18n-it.ts` e `lib/i18n-en.ts`.
- [ ] 4.5 `desktop-tauri/src-tauri/src/lib.rs`: `set_app_status` solo dalla finestra
  principale; il client lo chiama solo da lì. Test Rust sull'etichetta del chiamante.
- [ ] 4.6 Scorciatoia «Apri Da guardare» nella mappa di `remappable-shortcuts`, default
  ⇧⌘I se libera; se no la prima libera fra ⇧⌘N e ⌥⌘I, scritta qui.

## 5. E2E sul server di test vero

Niente frame iniettati con `page.routeWebSocket` per gli stati di attenzione: si pilota il
server (rotta degli hook, provider finto). Ogni spec lascia il `.webm`.

- [ ] 5.1 `tests/e2e/attention-background.spec.ts`: un terminale con hook lancia un Bash in
  background e fa `Stop` → nessun fill, numero o voce in inbox, glifo grigio, riga quieta
  «1 in background»; arriva la `task-notification` e lo `Stop` → blu, inbox 1, un banner.
- [ ] 5.2 `tests/e2e/attention-sync.spec.ts`: due pagine; visto in A spegne B; ricarico di
  B non riaccende; socket chiusa e riaperta in B dopo un visto in A → B spenta senza
  aprire la inbox.
- [ ] 5.3 `tests/e2e/attention-inbox.spec.ts`: aprire non spegne; Invio su una `Finite`;
  `E` e ⇧`E`; una domanda resta; tastiera sola; 390 px col foglio e lo scorrimento.
  Screenshot chiaro e scuro, desktop e 390 px.
- [ ] 5.4 `tests/e2e/attention-archive-park.spec.ts`: chiudere la tab di una chat finita
  cala il numero; una card parcheggiata rimessa in coda esce dalla inbox.
- [ ] 5.5 `tests/e2e/chat-finished-banner.spec.ts` e le altre spec che iniettano
  `stream:end` o `session:state` per l'attenzione: riscritte sul server vero o su frame
  `attention:*`, nessuna cancellata senza un gemello.

## 6. Chiusura

- [ ] 6.1 `docs/board-protocol.md` se il testo dell'envelope cita le notifiche (oggi no:
  verificarlo con `git grep -n notific server/services/task-dispatcher.ts`).
- [ ] 6.2 Dopo una release con il client nuovo: via gli alias delle porte vecchie e i frame
  `notification:new`/`notification:seen`/`unread:*` se nessun lettore resta (`git grep`).
- [ ] 6.3 Archiviare la change: le delta entrano in `notifications` e `claude-sessions`.
  Prima va sistemata `openspec/specs/claude-sessions/spec.md`, che oggi ha i requisiti
  fuori dalla sezione `## Requirements`: `openspec validate` dice che l'archivio
  rifiuterebbe la delta di MONITOR-04 finché non è corretta.
