# Design: conversazione-unica-della-card

Vincitore fra tre direzioni: `one-timeline-projection` (2 giudici su 3), con
innesti da `card-events-plus-session` (ancore, migration dati obbligatoria, stato
di consegna derivato, `DispatchEnvelopeRow` condivisa) e da `session-is-thread`
(placeholder per stato, `interceptBoardAction`). I tre difetti fatali della prima
stesura sono tolti: (1) lo strip per NOME delle tool call specchiate diventa strip
per ANCORA; (2) la vivezza non è più «lo store della chat la dà gratis» — il drawer
DICHIARA il suo topic; (3) la bonifica delle buste è una migration obbligatoria e
provata, non un predicato testuale nel client.

Numeri sul DB vivo (04/09/2026): 2301 righe `user` che aprono con le quattro
buste, 0 marcate; 72 messaggi con `ask_user_question` e 0 commenti instradati;
`task_comments`: 7995 comment / 8251 status / 5035 service / 293 review-note /
37 delivery.

## 1. Fonti di verità

Nessuna terza tabella, nessuna fusione server.

- `task_comments` (server/db/migrations/001-initial.sql:186-193, `kind` dalla 039)
  = ciò che è stato DETTO e DECISO sulla card. Cinque specie, whitelist solo in TS
  (shared/board.ts:1380; `addComment` coerce l'ignoto a `comment`,
  server/services/tasks.ts:3670-3678).
- `messages` di `topic:<8>` (chiave costruita in server/services/task-dispatcher.ts:3160,
  letta dal client in TaskDetail.tsx:1595) = ciò che l'agent ha FATTO: tool call,
  blocchi, thinking, prosa, buste come righe `user`.
- Le parole umane dirette all'agent restano in `task_comments` (`author:'user'`,
  server/routes/tasks.ts:2380, `HUMAN`). È ciò che tiene in piedi, senza toccarli:
  KANBAN-71 (`awaitingAnswerFor`, server/services/tasks.ts:1788-1820), KANBAN-27
  (`cardCommentsFor` 1822, `SQL_PAROLA`/`SQL_MIA`/`SQL_IS_DELIVERY` 1357-1395),
  `hasFreshAgentComment` (2895-2903) e `reviewChipFor`
  (task-dispatcher.ts:2639-2652).
- Oggi nessun codice server unisce le due (grep `timeline` in server/ tocca solo i
  `blocks` del messaggio: server/types.ts:174, routes/history.ts:87). Resta così: la
  fusione è una proiezione pura sul client (§4).

## 2. Ancore — due, una per verso

### (a) `task_comments.message_id TEXT NULL`

Migration `server/db/migrations/2026090XXXXXXX-task-comment-message-anchor.sql`:
solo `ADD COLUMN`, nessun backfill, nessun indice. Valore =
`ctx.isStreaming(sk)?.messageId`, la stessa lettura che server/routes/chat.ts:414
fa già per il 409 `stream_in_flight`.

Scrittori:
- la rotta agente dei commenti, `comment_task` → POST
  /api/sessions/:sk/tasks/:t/comments (server/routes/tasks.ts:3425-3470);
- la consegna `update({status:'review', summary})` che scrive la riga `delivery`
  (server/services/tasks.ts:3345): l'id arriva dalla PATCH di sessione;
- la domanda instradata, `routeAskToTaskThread` in server/routes/permission.ts:57-67
  (`createPermissionRouter(ctx)` ha `ctx`);
- la nota di sistema con «Ultime parole dell'agent (recuperate dalla sessione)»
  (task-dispatcher.ts:2941-2943, via `recoverAgentWords` 2628-2633 e
  `getLastAgentText` server.ts:1560-1592, che passa a tornare `{text, id}`), scritta
  da `deliverToReviewBySystem` (tasks.ts:4431-4560).

`addComment` (tasks.ts:3670) prende `messageId?: string | null`; `rowToComment` lo
espone come `TaskComment.messageId` (shared/board.ts:1350-1380). L'ancora arriva
al client SENZA frame nuovi: `task:updated` porta solo il task (routes/tasks.ts:3157-3158
fa `svc.get(...)?.task` e lo broadcasta, cioè il solo `rowToTask`), e il pannello
rilegge GET /api/boards/:p/tasks/:t (routes/tasks.ts:3238 → `svc.get`, tasks.ts:3129-3135,
`{task, comments: rows.map(rowToComment)}`) a ogni `bump`, che espone
`comments[].messageId` (server/lib/grants.ts:155-161 dice esplicitamente che
`task:comment` non esiste).

### (b) `commentIds` sulla busta

Blocco `{ kind: 'dispatched-envelope'; commentIds?: string[] }` (shared/types.ts:960).
`userRowMarks({goalNudge, dispatched, commentIds})` (server/lib/user-row-marks.ts:38-47)
scrive gli id solo se `dispatched === true` e l'array non è vuoto.
server/routes/chat.ts:327 legge `body.dispatched` e 431-436 scrive i marchi → si
aggiunge `body.dispatchedFor` (array di stringhe, filtrato).
`runHeadlessTurn(sk, content, {timeoutMs, idleMs, contextMode, dispatchedFor?})`
(server.ts:872-885) lo mette nel body.

Catena nel dispatcher (server/services/task-dispatcher.ts):
- `resume(taskId, text, {continuation?, commentIds?})` (3064);
- `pendingResume` / `bufferResume` (1192-1193) conservano `{text, at, commentId?}`;
- i flush di `onTurnEnd` — 2695 (riaperta con `needs_input`) e 2714 (in_progress) —
  passano `queued.map(q => q.commentId).filter(Boolean)`;
- `slotWaits` (3151-3160) eredita gli id insieme al messaggio;
- il ramo che parte (3178-3187) passa `dispatchedFor: commentIds` a
  `deps.runTurn`, la cui firma (318-327) si estende.

Chiamanti: routes/tasks.ts:3230 → `dispatcher.resume(root.id, msg, {commentIds: [comment.id]})`.
Rotta reject-con-testo (routes/tasks.ts:2929-2939 → `reviewDecision`
tasks.ts:3861): la rotta chiama PRIMA `svc.addComment({taskId, author: HUMAN,
content: text})` e ottiene l'id, POI `reviewDecision({comment: text})` come oggi —
la dedupe autore+testo di `addComment` (tasks.ts:3714-3724, `commentDedupeMs`) rende la
seconda scrittura idempotente e `settleReviewApproval` (2955-2967) tiene
`review_comment`, che era il difetto segnalato dal giudice 3 su
`card-events-plus-session`. Il TESTO di `buildResume` (3012-3027) non cambia:
PREVENV-01, `docs/board-protocol.md` e task-dispatcher.test.ts:3799 intatti.

## 3. Bonifica obbligatoria

`server/db/migrations/2026090XXXXXXX-mark-dispatched-envelopes.sql`:

```sql
UPDATE messages SET blocks='[{"kind":"dispatched-envelope"}]'
WHERE role='user' AND blocks IS NULL AND (
  content LIKE 'You are the exclusive owner of task%' OR
  content LIKE 'Human update on task%' OR
  content LIKE 'Your previous turn on this task was interrupted%' OR
  content LIKE 'LAST TURN on%')
```

- Ancorata all'INIZIO della riga (THREAD-05: un riconoscimento a metà frase si
  porta via il messaggio di una persona che cita la busta).
- Provata ESEGUENDO il file su un DB sintetico (pattern
  tests/integration/migration-071-empty-turns.test.ts) con dentro le quattro
  aperture, una riga umana che cita «Human update on task» a metà frase e una riga
  già marcata; giudicata su ciò che LASCIA STARE (`NULL` resta `NULL`, il marchio
  esistente resta invariato).
- Backup di `data/topics.db` + `-wal` PRIMA di creare il file: il watcher di
  produzione (`TOPICS_SERVER_WATCH=1`, CLAUDE.md) applica la migration al DB vivo in
  secondi.
- Il commento di server/lib/user-row-marks.ts:10-15 (411/1033 righe non marcate) è
  superato: 2301 totali, di cui 437 `LAST TURN on`.
- Beneficio collaterale immediato: la chat del topic smette di mostrare 2301 righe
  come parole della persona (MessageBubble.tsx:253 già collassa il marchio).
- Il client NON contiene nessun predicato testuale sul contenuto: legge il blocco.

Misura: `sqlite3 -readonly data/topics.db "select count(*) from messages where
role='user' and blocks is null and (content like 'You are the exclusive owner of
task%' or content like 'Human update on task%' or content like 'Your previous turn
on this task was interrupted%' or content like 'LAST TURN on%')"` → **0**
(riferimento oggi: 2301).

## 4. Proiezione — pura, client, testata senza DOM

`client/src/components/Board/taskTimeline.ts`:
`mergeTaskTimeline(comments, msgs, {status, pinnedDeliveryId}, prev?) → TimelineItem[]`.

```ts
type TimelineItem =
  | { source:'comment'; id; at; author; kind; content; comment: TaskComment }
  | { source:'session'; id; at; author; kind:'comment'; content; msg: ChatMessage;
      delivery?: 'delivered' | 'pending' }
```

`author/kind/content` presenti su entrambe le varianti così il risultato soddisfa
`ThreadRunsRow` (ThreadRuns.tsx:33) e passa da `groupServiceRuns` /
`groupStatusRuns` / `foldsAway` (shared/task-comment-service.ts:252-306) invariati:
una riga di sessione non è mai `service` né `status`, quindi taglia una piega per
costruzione (la clausola di THREAD-05 «fra un commento e l'altro il filo intercala i
passi» torna vera).

Regole, in quest'ordine:

1. **`role='user'`.** Busta (`isDispatchedEnvelope(blocks)`) CON `commentIds` non
   vuoto → NASCOSTA: le parole sono già le righe-commento. Busta SENZA `commentIds`
   (kickoff, sollecito, le riprese legacy) → riga collassata `DispatchEnvelopeRow`,
   estratta da MessageBubble.tsx:253-270 in
   `client/src/components/Chat/DispatchEnvelopeRow.tsx` e usata da ENTRAMBE le
   superfici. `user` senza busta → bolla della persona (i 1046 turni vivi scritti
   nella chat del topic, oggi buttati da sessionBuckets.ts:129).
2. **`role='assistant'`.** Le tool call `mcp__topics__comment_task`,
   `mcp__topics__update_task`, `mcp__topics__ask_user_question` (nomi via
   client/src/components/Chat/toolDetail.ts:343-351) si tolgono da `toolCalls` /
   `blocks` SOLO se `comments.some(c => c.messageId === msg.id)`. Senza ancora
   (riga legacy, `comment_too_long` / `media_path_not_allowed`
   routes/tasks.ts:3440-3452, `review_needs_summary` tasks.ts:3337-3341, ask non
   instradato) la tool row RESTA — cioè i 72 `ask_user_question` senza commento si
   vedono e si RISPONDONO dal `ToolInputForm` di `ToolCallRow`
   (client/src/components/Chat/ToolCallRow.tsx:131) dentro `MessageContent`
   (client/src/components/MessageContent.tsx:1040): il buco di
   `project_midturn-question-invisible-on-card.md` chiuso gratis. Una riga rimasta
   senza contenuto, ragionamento e tool si scarta.
3. **Corse di tool** fuse prima con `coalesceToolRuns`
   (client/src/components/Chat/coalesceToolRun.ts:276): «N azioni», identità in
   `mergedIds`.
4. **Ordine per istante** (`createdAt` / `timestamp`, entrambi già ascendenti),
   merge a due puntatori; tie → commento prima; un commento con `messageId`
   presente fra i messaggi si disegna SUBITO DOPO quel messaggio, qualunque sia
   l'orologio. La riga `partial` è l'ULTIMO MESSAGGIO della sessione; i commenti
   ancorati a lei la seguono, subito dopo; la riga live (`task-session-live`) viene
   dopo di loro. È il caso normale, non un'eccezione: l'ancora vale
   `ctx.isStreaming(sk)?.messageId`, cioè l'id della riga assistant IN STREAMING
   (`startStream(sessionKey, messageId)` server/utils.ts:1690-1691, `isStreaming`
   1809), quindi ogni `comment_task` fatto a turno vivo è ancorato alla `partial`.
5. **Card `done`**: la `delivery` appuntata nella banda (TaskDetail.tsx:1705-1730)
   è ESCLUSA dall'elenco (oggi dipinta due volte, 1731-1732). La nota «Ultime parole
   dell'agent (recuperate…)» resta (THREAD-05: non si piega) e con l'ancora porta un
   «↳» al passo.
6. **Stabilità per riferimento**: item riusato se `comment` / `msg` sono lo stesso
   riferimento di `prev` (`getSessionMessagesFromStore` è già stabile,
   client/src/state/messageStore.ts:52-56); chiavi React `c:<id>` / `m:<id>`.
7. **Stato di consegna derivato** sulle righe umane (§7).

Helper: `envelopeCommentIds(blocks): string[]` in
client/src/components/Chat/dispatchedEnvelope.ts.

## 5. Vivezza — il drawer dichiara il suo topic

Oggi `stream:content_chunk` / `thinking_chunk` / `tool_call` / `tool_update` /
`tool_result` passano da `broadcastToTopicSubscribers` (server/utils.ts:906-921;
chat.ts:215-216, 2238, 2263, 2671) filtrati su `openTopicIds`, che il server
SOSTITUISCE a ogni frame `subscribe` (server.ts:3963; regola in
server/lib/ws-topic-routing.ts:33) e che il client manda da `presenceTopicIds` =
pane aperte (client/src/hooks/usePanelLifecycle.ts:2488-2497, 2553). Il drawer non
è una pane: senza dichiararsi vede solo `stream:start` / `message:new` /
`stream:end` (broadcastToAll: chat.ts:442, 2059, 3401) e una bolla vuota per tutto
il turno.

Quindi, solo client:
- `client/src/state/topicSubscriptions.ts`: insieme extra con conteggio —
  `holdTopic(topicId): () => void`, `getExtraTopicIds()`,
  `subscribeExtraTopics(cb)`, stabile per riferimento.
- usePanelLifecycle.ts:2553: il frame `subscribe` manda `presenceTopicIds ∪ extra`
  (dedup), e l'effetto dipende anche da `extra`. `presence:announce` (2537-2552)
  NON cambia: il drawer non è «una chat aperta in questa finestra» per le altre
  finestre.
- TaskDetail: `useSyncExternalStore(cb => subscribeSession(sessionKey, cb), () =>
  getSessionMessagesFromStore(sessionKey))` + `holdTopic(assignedTopicId)`, entrambi
  gated su `usePaneAlive()` (client/src/state/paneLiveness.ts:27 — la prima
  clausola di KANBAN-52 resta vera). `useChat` è UNA istanza per pagina
  (client/src/hooks/liveTurn.ts:13-14) e riduce ogni sessione nello store
  (stream:start 1255-1300, chunk/tool 1318-1381, end 1517); lo store guardato non
  viene sfrattato (`evictSessions`, messageStore.ts; useChat.ts:2797-2810).
- Idratazione e recupero: `loadHistory(sessionKey)` (useChat.ts:2358, dedup +
  in-flight collapse) su mount, sul risveglio (`onWake`, TaskDetail.tsx:925-934, UN
  solo listener `visibilitychange`) e su `stream:end` del proprio `sessionKey` —
  perché `message:new` porta solo il contenuto e i `blocks` / tool persistiti
  arrivano da /api/history. `loadHistory` e `onMessage` arrivano per prop:
  ProjectWindow.tsx:504 e StandaloneChatGroup.tsx:739 le tengono già (58/104,
  82/178) → `KanbanBoardPane` (props KanbanBoardPane.tsx:574, `onMessage` 65) →
  `TaskDetail` (KanbanBoardPane.tsx:1913).
- `stream:tool_permission_required` è broadcastToAll (permission.ts:260) e useChat
  lo riduce (1434) → il pannello del permesso compare nella conversazione via
  `ToolPermissionRow`.
- Spariscono: il poll da 3 s, `sessionCatchUp`, `streamPreview`
  (TaskDetail.tsx:1594-1656) e il tetto a 200 righe.

Misura: nell'e2e DRAWER-05 un contatore `page.route('**/api/history/**')` armato
DOPO il mount del drawer conta 0 richieste durante un turno vivo, e il testo del
passo compare dentro `task-session-column` PRIMA del frame `stream:end`.

## 6. UI, composer e risposte rapide

**Colonna.** UNA `task-session-column` (testid tenuto), etichetta
`board.task.threadLabel` → «Conversazione» / «Conversation»
(client/src/lib/i18n-it.ts:770, i18n-en). Body =
`<ThreadRuns comments={timeline} renderRow={row} renderStatusRun={statusRun}
isService={done ? isDoneThreadService : undefined}>` con `row` che smista su
`source`: commento → `CommentBubble` (TaskDetail.tsx:3396-3496) come oggi; sessione
assistant → `SessionItem` = `MessageContent` con `role='assistant'`,
`content/thinking/toolCalls/blocks/partial/sessionKey/messageId`, dentro
`COMPACT_MD_CLS`, senza metriche di piede (`usage*` / `costCents`); sessione user →
la bolla grigia di `CommentBubble` (3489-3495); busta → `DispatchEnvelopeRow`.

**Riga live.** UNA `SessionLiveRow` (fase, ticker, Stop; senza `preview` /
`onOpenPane`; spostata con `Ticker` in `client/src/components/Board/SessionLiveRow.tsx`)
sotto la riga `partial` quando `agentBusy` (1614); `task-stream-preview` sparisce.

**Scroll.** Il solo `flex-1 overflow-y-auto` (1710) con «segui l'agent solo se già
entro 80 px dal fondo» (regola di SessionPane.tsx:139-150) al posto dello
`scrollIntoView` su `comments.length` (935).

**Vuoto.** `task-thread-empty` con `emptyThreadKey(task.status)` (emptyThread.ts)
quando la TIMELINE è vuota: cade la guardia `!task.assignedTopicId` (1716-1720),
BOARD-03b resta verde, le quattro frasi di EMPTYTHREAD-01 restano.

**Gone / archiviato.** `task-session-gone` e il bottone «Apri la sessione»
(2450-2466; board-card-vs-session.spec.ts:171-176) restano e aprono LO STESSO store,
quindi le due viste non possono più divergere; un `loadHistory` che torna vuoto
lascia la timeline dei soli commenti.

**Layout.** Modo largo (`twoCol`, TaskDetail.tsx:833; layout a due colonne
2635-2639): conversazione a sinistra, spazio di lavoro a destra (solo tab
browser / Piano / allegati). Colonna sola: brief →
Workspace → conversazione → decisione + composer (2841-2900). Mobile identico,
overlay come oggi (2309).

**Composer** (TaskDetail.tsx:3046-3095): semantica server INVARIATA —
`deliverAnswer` (1042-1061) → `boardApi.comment` / `boardApi.review('reject', text)`
→ routes/tasks.ts:3147-3236 (`quiet` esce a 3175, ask instradato →
`answerRoutedAsk` 3190, review → reject+resume 3218-3230, in_progress →
resume). Placeholder per VERBO derivato: review con agent → «Rimanda indietro con
questo testo» + «Nota» (KANBAN-45, board-review-quiet-note verde); in_progress →
`board.task.steerPlaceholder` e, se l'ultima parola è una domanda senza risposta,
`board.task.answerPlaceholder` (ASK-05 nel drawer); done/todo/backlog →
`board.task.commentPlaceholder`.

**Risposte rapide.** `pending` (999-1001) allargato da `isAgentReview` a
«`lastThreadComment` è un blocco question e `task.status !== 'done'`» — il derivato
KANBAN-71, server già coerente con `awaitingAnswerFor`; fallback
`pendingQuestion(threadComments)` (shared/board.ts:1877-1890); de-dup con
`usableQuestionOptions` (1019-1023) e `ReviewDecisionRow` invariati.
`interceptBoardAction(root, text)` estratta da routes/tasks.ts:2876-2892
(`isLandActionLabel` (routes/tasks.ts:2917), `isTakeOverParkedLabel`, `isRequeueParkedLabel` /
`isArchiveParkedLabel` / `isPromoteParkedLabel`) in `server/services/board-actions.ts`
e chiamata anche dalla rotta dei commenti DOPO `quiet` e DOPO `pendingRoutedAsk`,
PRIMA di reject/resume: un'etichetta di sistema cliccata dal drawer in
`in_progress` non deve mai svegliare un turno per fare un UPDATE.

## 7. Stato di consegna derivato

Su una riga umana (`kind:'comment'`, `author:'user'`), calcolato dalla proiezione a
ogni lettura, mai scritto:

- **consegnato** — esiste una busta (`dispatched-envelope`) che porta il suo id in
  `commentIds` → chip con link al messaggio;
- **in coda** — nessuna busta porta il suo id, nessuna busta ha `timestamp >
  createdAt`, e `task.status ∈ {in_progress, todo}`;
- **niente** altrimenti.

Un riavvio che perde `pendingResume` non mente più: la busta di continuazione è
più recente del commento, il chip cade, e la busta stessa dice all'agent di
rileggere i commenti (`buildResume` 3017). KANBAN-36 applicato: lo stato si legge
dal registro, non da un messaggio che invecchia.

## 8. Note rimosse

Cancellati i due scrittori di stato-come-nota in task-dispatcher.ts:
- 3086-3095 «Feedback ricevuto mentre l'agent sta lavorando…» (buffer a turno vivo);
- 2722-2729 «Il tuo feedback è arrivato a turno finito…» (flush su todo/altro).

Restano:
- 2699-2707 (riaperta / «la consegna resta»): è una DECISIONE, regola del 04/09
  «A DELIVERY IS NOT REJECTED BY A MESSAGE THAT NEVER SAW IT» (2677-2688);
- le attese di slot 3121-3151: portano la CAUSA (cap/floor), non uno stato.

Nessun test cerca oggi quelle stringhe: `/usr/bin/grep -rl 'Feedback ricevuto
mentre\|arrivato a turno finito'` su `*.ts`/`*.tsx`/`*.md` trova solo
server/services/task-dispatcher.ts e i file di questa change. Non c'è niente da
sostituire: si AGGIUNGE a task-dispatcher.test.ts il test «un messaggio umano
bufferizzato a turno vivo non produce righe `service`, e il resume seguente porta
`commentIds`». `docs/board-protocol.md` non cita le due note (si verifica con grep).

## 9. Cosa si cancella

- client/src/components/Board/sessionBuckets.ts (+test); `SessionPane` /
  `SessionSteps` in SessionPane.tsx;
- `sessionActive` / `sessionTitle` / `sessionPane` / `sessionPaneId` in
  useTaskBrowserGroupLayout.tsx:57, 64-71, 179-181, 192-198 — i layout persistiti
  con `session:<taskId>` si potano da soli via `reconcileTaskLayout` (214-219);
- in TaskDetail.tsx: `sessionMsgs` / `loadSession` / poll / `sessionCatchUp` /
  `streamPreview` (1594-1656), `bucketsRef` / `sessionBuckets` / `boundaryIds`
  (1668-1683), `renderSessionPane` (1766-1782), il ramo `session:` di
  `renderSurface` (1787), lo `scrollIntoView` (935);
- la prop `breaksRun` di ThreadRuns (ThreadRuns.tsx:75-79, morta dal `1ab9c390d`;
  la firma condivisa di `groupServiceRuns` resta; una riga in
  ThreadRuns.test.tsx:45-49);
- i due scrittori di servizio del dispatcher (§8);
- i18n `board.task.sessionLabel` / `sessionReplied` / `sessionEmpty` /
  `openSessionPane` / `streamPreviewTitle` (i18n-it.ts:732, 769-773; i18n-en).

`bun run check:deadcode` (knip) verifica che non resti un export morto.

## 10. Rischi dichiarati

- `isStreaming(sk)?.messageId` `undefined` all'istante della chiamata MCP → ancora
  `NULL` → tool row + commento visibili entrambi: doppione piccolo, mai una riga
  persa; quota `NULL` da misurare dopo una settimana.
- `MessageContent` in 320-400 px: si misura (screenshot DRAWER-03), si allarga solo
  se serve.
- Idratazione intera su card enormi: la chat la fa già, `loadHistory` dedupa; da
  misurare.
- Le due migration girano sul DB vivo entro secondi dalla creazione del file:
  backup prima, file provato su DB sintetico, `restart-when-idle` e non `kickstart`.
