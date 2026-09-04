# Change: conversazione-unica-della-card

## Why

Nel pannello di una card la stessa conversazione è spezzata in due superfici che
non si parlano. «Discussione» è il filo di `task_comments` (TaskDetail.tsx:2871-2886,
corpo da `renderThread` 1688-1756), riletto via `boardApi.get` a ogni `bump` di
`task:updated`. «Sessione» è una scheda del GroupLayout del task
(useTaskBrowserGroupLayout.tsx:179-198, id `session:<taskId>`) alimentata da un
poll HTTP di `/api/history/topic:<8>?limit=200` ogni 3 secondi mentre l'agent
lavora (TaskDetail.tsx:1596-1631), che tiene solo `role/content/timestamp/thinking`
(le tool call cadono a 1602-1605) e butta ogni riga `role='user'`
(sessionBuckets.ts:129). Il taglio fra le due è la data del commit `1ab9c390d`
(21/08): prima la sessione stava intercalata sopra ogni riga del filo, ripiegata a
ogni poll, ed era illeggibile. La separazione ha curato quel sintomo e lasciato la
malattia: per leggere «cosa ha fatto, poi cosa ha detto» servono due schede e una
correlazione mentale sui timestamp.

Quattro fatti misurati sul DB vivo (04/09/2026) dicono cosa costa:

- **Le parole della persona esistono due volte con due identità.** Una riga di
  `task_comments` (`author:'user'`, server/routes/tasks.ts:2380, `HUMAN`) e un turno
  `role:'user'` nella storia del topic, incartato nella busta di `buildResume`
  (task-dispatcher.ts:3012-3027). **2301** righe `user` aprono con una delle
  quattro buste del dispatcher e **0** portano il marchio `dispatched-envelope`
  (server/lib/user-row-marks.ts:38-47, nato tardi): la tab della chat le mostra
  come se le avesse scritte la persona (MessageBubble.tsx:253), e la scheda
  Sessione le nasconde filtrando per ruolo, cioè nasconde anche i **1046** turni
  umani veri scritti nella chat del topic.
- **Le parole dell'agent alla persona stanno solo nel filo, i suoi passi solo nella
  sessione.** `comment_task` scrive in `task_comments` (routes/tasks.ts:3425-3470)
  e la tool call che porta quel testo è tolta dalla vista della sessione. La stessa
  domanda si disegna tre volte (bolla con le opzioni a punti 3512-3530, tasti sopra
  il composer 2966-2975, card kanban) e i tasti compaiono solo in `review`: **72**
  messaggi con `ask_user_question` hanno **0** commenti instradati, e quella
  domanda dal drawer non si vede né si risponde
  (`project_midturn-question-invisible-on-card.md`).
- **Lo stato di consegna di un messaggio umano è scritto come nota.** Il dispatcher
  mette in `task_comments` «Feedback ricevuto mentre l'agent sta lavorando…»
  (task-dispatcher.ts:3086-3095) e «Il tuo feedback è arrivato a turno finito…»
  (2722-2729): uno stato scritto come messaggio non invecchia (KANBAN-36), e dopo un
  riavvio che perde `pendingResume` la nota promette una consegna che non avviene.
- **La riga live è disegnata due volte di proposito** (TaskDetail.tsx:1743-1750 e
  1766-1782, commento a 1759-1765) perché le due superfici possono stare a schermo
  insieme; su una card `done` la `delivery` appuntata nella banda è dipinta anche in
  elenco (1705-1730 + 1731-1732).

Vale la pena perché il costo si paga a ogni card dispatchata: il drawer è il posto
dove una persona decide, e oggi decide leggendo metà della conversazione, in
ritardo di tre secondi, senza vedere le domande fatte a metà turno.

## What changes

1. **Una colonna sola, «Conversazione».** `task-session-column` (testid tenuto)
   disegna UNA lista ordinata nel tempo: i commenti del filo e i passi della
   sessione — tool run fusi «N azioni», ragionamento, prosa, domande e permessi a
   metà turno, buste collassate, bolle della persona — smistati per `source` da
   `ThreadRuns` invariato. La scheda «Sessione», `SessionPane`, `sessionBuckets` e
   la seconda riga live spariscono. In modo largo la conversazione sta a sinistra e
   lo spazio di lavoro (browser, Piano, allegati) a destra.

2. **Due ancore, una per verso, così ogni fatto specchiato si disegna una volta.**
   (a) `task_comments.message_id TEXT NULL` (solo `ADD COLUMN`, nessun backfill):
   l'id del messaggio assistant in cui l'agent ha chiamato `comment_task` /
   `update_task` / `ask_user_question`, letto con `ctx.isStreaming(sk)?.messageId`
   come già fa server/routes/chat.ts:414. (b) `commentIds?: string[]` sul blocco
   `{kind:'dispatched-envelope'}` della busta di ripresa: gli id dei commenti umani
   che quella busta consegna. La proiezione toglie la tool call specchiata SOLO se
   esiste un commento con `messageId === msg.id`, e nasconde la busta SOLO se porta
   `commentIds`. Senza ancora la riga RESTA: il modo di sbagliare è una riga in più.

3. **Bonifica obbligatoria e provata.** Una migration marca `dispatched-envelope`
   le 2301 buste già scritte (`role='user'`, `blocks IS NULL`, contenuto che APRE
   con una delle quattro buste), provata ESEGUENDO il file su un DB sintetico che
   contiene anche una riga umana che cita la busta a metà frase e va lasciata
   `NULL`. Il client non contiene nessun predicato testuale. Beneficio collaterale
   immediato: la chat del topic smette di attribuire 2301 buste alla persona.

4. **Il drawer dichiara il suo topic al filo, e la sessione arriva dallo store della
   chat.** Il frame `subscribe` (usePanelLifecycle.ts:2553) manda
   `presenceTopicIds ∪ extra`, dove `extra` è tenuto da `holdTopic(topicId)` in un
   nuovo `client/src/state/topicSubscriptions.ts`; il drawer legge
   `getSessionMessagesFromStore(sessionKey)` con `useSyncExternalStore`, ricarica con
   `loadHistory` su mount, risveglio e `stream:end`. Il poll da 3 s, `sessionCatchUp`,
   `streamPreview` e il tetto a 200 righe spariscono. Tutto gated su `usePaneAlive()`.

5. **Lo stato di consegna di un messaggio umano è derivato**, sotto la bolla:
   «consegnato» se una busta porta il suo id, «in coda» se nessuna busta lo porta,
   nessuna busta è più recente e la card è `in_progress`/`todo`, niente altrimenti.
   Le due note di servizio di task-dispatcher.ts:3086-3095 e 2722-2729 si
   cancellano. Resta 2699-2707 (riaperta / la consegna resta: è una decisione) e
   restano le attese di slot 3121-3151 (portano la causa).

6. **Il composer dice il verbo e le risposte rapide compaiono ovunque l'ultima
   parola è una domanda.** Placeholder derivato dallo stato (review con agent →
   «Rimanda indietro con questo testo» + «Nota»; in_progress → «Scrivi all'agent…»
   o «Rispondi alla domanda…»; altro → «Commenta…»). `pending` (TaskDetail.tsx:999-1001)
   passa da `isAgentReview && …` a «l'ultima parola del filo è una domanda e la card
   non è `done`» — il derivato di KANBAN-71. `interceptBoardAction(root, text)` viene
   estratta da routes/tasks.ts:2876-2892 e chiamata anche dalla rotta dei commenti,
   così un'etichetta di sistema cliccata dal drawer in `in_progress` non sveglia mai
   un turno per fare un UPDATE.

Le tre biforcazioni sono decise («tutte le consigliate», 04/09/2026): subscribe e
non poll; colonna `message_id` adesso, con backup; le due note via, chip derivato.

## Cosa NON cambia, e perché

- **Le sessioni figlie** (`spawn_agent`/coordinatore) non entrano nella
  conversazione: solo gli esiti «🤖 Sotto-agente» (server/routes/subagent-exit.ts:38)
  e le domande instradate nel filo. Un figlio è un PTY separato con un trascritto
  suo; inlinarlo è un'altra change.
- **Il registro delle domande instradate** (`routed` Map,
  server/services/board-ask-routing.ts:52) resta memoria di processo: dopo un
  riavvio una risposta rapida diventa un resume come oggi.
- **La SEMANTICA del canale server resta quella che è** (quiet → nota; domanda
  instradata → risposta; review → reject+resume; in_progress → resume): la rotta
  dei commenti (server/routes/tasks.ts:3147-3236) guadagna solo `commentIds` sul
  resume e l'intercetta delle etichette di sistema prima di reject/resume. Nessun
  `claimHumanTurn`, nessun tocco a POST /api/chat oltre a leggere `dispatchedFor`.
  Restano com'erano: `comment_task`, `update_task`,
  POST /api/sessions/:sk/tasks/:t/comments (3425-3470), `quiet`, `pendingResume`,
  `buildResume`, i testi delle buste e `docs/board-protocol.md`. Il TESTO di
  `buildResume` (3012-3027) non cambia: PREVENV-01, board-protocol.md e
  task-dispatcher.test.ts:3799 restano intatti.
- **Card.tsx** (composer e risposte rapide della card kanban), il gateway
  `topics-board` fuori repo, i regimi di effort board/chat.
- **Il testid `task-session-column`** (9 riferimenti in
  tests/e2e/board-drawer-scroll.spec.ts, board-card-vs-session,
  board-review-quiet-note) e la larghezza della colonna in modo largo (DRAWER-03,
  320-400 px): si misura con uno screenshot, si allarga solo se le tool row leggono
  strette — non in questa tornata.
- **Prestazioni dell'idratazione intera** (`loadHistory` con `limit:0`,
  server/routes/history.ts:49-62) su una card con migliaia di messaggi: si misura al
  primo giro con `project_live-app-layout-probe.md`, si tratta dopo (finestra di
  testa con «carica i precedenti» è il ripiego, non un flag).
- **Gesti mobile del drawer** (swipe, overlay full-screen, TaskDetail.tsx:2309) e
  PWA: invariati.
- **Le migration di ri-etichettatura del passato su `task_comments`**
  (20260818110000, 20260820235900, 20260821000500): non si toccano; nessuna riga di
  `task_comments` viene riscritta.
- **Requisiti TENUTI così come sono**: KANBAN-05, -08, -19, -27, -33, -36, -45,
  -50, -61, -64, -65, -71, PREVENV-01, REVAGE-01, EMPTYTHREAD-01 (la guardia si
  allarga alla timeline, le quattro frasi restano), THREAD-01/02/04, ASK-03 (la
  domanda entra nel filo — ora la conversazione — o, se non instradata, nella riga
  tool visibile), ASK-05/06, PERM-03/05.

## Risks

- **`isStreaming(sk)?.messageId` può essere `undefined`** all'istante della
  chiamata MCP → ancora `NULL` → tool row e commento entrambi visibili. È un
  doppione piccolo, mai una riga persa; la quota di `NULL` si misura dopo una
  settimana con una query su `task_comments`.
- **`MessageContent` in 320-400 px** può leggere stretto: si misura con lo
  screenshot di DRAWER-03, si allarga solo se serve.
- **Idratazione intera su card enormi**: la chat la fa già e `loadHistory` dedupa
  (useChat.ts:2358); da misurare, non da pre-ottimizzare.
- **Le due migration girano sul DB vivo entro secondi** dalla creazione del file
  (`TOPICS_SERVER_WATCH=1`, CLAUDE.md): backup di `data/topics.db` + `-wal` PRIMA,
  file provato su DB sintetico, `restart-when-idle` e non `kickstart`.

## Impact

- **Specs (delta)**: `kanban/` — MODIFIED KANBAN-35, KANBAN-52; ADDED KANBAN-72
  (le due ancore), KANBAN-73 (la proiezione), KANBAN-74 (stato di consegna
  derivato), KANBAN-75 (le due note non si scrivono più). `chat/` — ADDED
  CHAT-ENV-01 (la busta porta `commentIds`, le buste già scritte si marcano).
  `thread/` — MODIFIED THREAD-03 (cinque specie + ancora `messageId`), THREAD-05
  (il taglio fra note di servizio avviene per costruzione).
- **Server**: due migration in `server/db/migrations/` (marchio sulle buste
  legacy; `task_comments.message_id`), `shared/types.ts:960`,
  `server/lib/user-row-marks.ts`, `server/routes/chat.ts:327,431-436`,
  `server.ts:872-885`, `server/services/task-dispatcher.ts` (`resume`,
  `bufferResume`, `onTurnEnd`, `slotWaits`, `recoverAgentWords`, due scrittori
  cancellati), `server/services/tasks.ts` (`addComment`, `rowToComment`, `update`,
  `deliverToReviewBySystem`), `server/routes/tasks.ts` (rotta commenti, reject con
  testo, `comment_task`), `server/routes/permission.ts:57-67`, `server.ts:1560-1592`
  (`getLastAgentText` torna `{text,id}`), nuova `server/services/board-actions.ts`.
- **Client**: nuovi `client/src/state/topicSubscriptions.ts`,
  `client/src/components/Board/taskTimeline.ts`,
  `client/src/components/Board/SessionLiveRow.tsx`,
  `client/src/components/Chat/DispatchEnvelopeRow.tsx`;
  `usePanelLifecycle.ts:2553`, `TaskDetail.tsx`, `KanbanBoardPane.tsx`,
  `ProjectWindow.tsx:504`, `StandaloneChatGroup.tsx:739`,
  `useTaskBrowserGroupLayout.tsx`, `ThreadRuns.tsx`, `dispatchedEnvelope.ts`,
  i18n it/en. Cancellati: `sessionBuckets.ts` (+test), `SessionPane.tsx`.
- **Tests**: `tests/integration/migration-*-dispatched-envelopes.test.ts`,
  `client/src/state/topicSubscriptions.test.ts`,
  `client/src/components/Board/taskTimeline.test.ts`, `TaskDetail.test.ts`
  riscritto, `server/services/board-actions.test.ts`; e2e DRAWER-03b/04 riscritti,
  DRAWER-05/05a/06 e BOARD-08b nuovi in `tests/e2e/board-drawer-scroll.spec.ts` e
  `tests/e2e/board.spec.ts`.
