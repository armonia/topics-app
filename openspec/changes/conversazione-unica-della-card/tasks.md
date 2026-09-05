# Tasks: conversazione-unica-della-card

T0 (questa change) è la spec. T1 e T2 sono indipendenti e partono insieme dopo
l'approvazione; T3 aspetta T1 e T2; T4 aspetta T1 e T3. Ogni fetta atterra da
sola con la sua barra.

## 1. T1 — Ancore sul filo (server, nessun cambio UI)

- [x] 1.1 Backup PRIMA di creare qualunque file di migration:
  `cp data/topics.db data/topics.db.bak-$(date +%s)` e lo stesso per
  `data/topics.db-wal` (il watcher `TOPICS_SERVER_WATCH=1` applica al DB vivo in
  secondi).
- [x] 1.2 Migration `server/db/migrations/2026090XXXXXXX-mark-dispatched-envelopes.sql`
  con l'`UPDATE` ancorato all'inizio sulle quattro aperture, `role='user'` e
  `blocks IS NULL`; rigenerare il manifest embedded come per le altre.
- [x] 1.3 `tests/integration/migration-XXXX-dispatched-envelopes.test.ts` sul
  pattern di `migration-071-empty-turns.test.ts`: ESEGUE il file .sql su un DB
  sintetico — 4 aperture marcate, 1 riga umana che cita «Human update on task» a
  metà frase → `NULL`, 1 riga già marcata → invariata.
- [x] 1.4 Aggiornare il commento di `server/lib/user-row-marks.ts:10-15`
  (2301 totali, 437 `LAST TURN on`).
- [x] 1.5 `commentIds` sulla busta: `shared/types.ts:960`;
  `userRowMarks({goalNudge, dispatched, commentIds})` scrive gli id solo con
  `dispatched === true` e elenco non vuoto; `server/routes/chat.ts:327` legge
  `body.dispatchedFor` (array di stringhe, filtrato) e 431-436 lo passa;
  `runHeadlessTurn` (server.ts:872-885) lo mette nel body.
- [x] 1.6 Catena nel dispatcher: `resume(taskId, text, {continuation?, commentIds?})`
  (3064); `pendingResume`/`bufferResume` (1192-1193) conservano `commentId?`; i
  flush di `onTurnEnd` (2695, 2714) passano gli id; `slotWaits` (3151-3160) li
  eredita; il ramo che parte (3178-3187) passa `dispatchedFor` a `deps.runTurn`
  (firma ~318-327 estesa).
- [x] 1.7 Chiamanti: `routes/tasks.ts:3230` →
  `dispatcher.resume(root.id, msg, {commentIds:[comment.id]})`; rotta
  reject-con-testo (2929-2939): `svc.addComment` PRIMA, poi
  `reviewDecision({comment: text})` come oggi, poi `resume(…, {commentIds:[id]})`.
  Il testo di `buildResume` (3012-3027) non cambia.
- [x] 1.8 Migration `server/db/migrations/2026090XXXXXXX-task-comment-message-anchor.sql`:
  `ALTER TABLE task_comments ADD COLUMN message_id TEXT` (nullable, nessun
  backfill, nessun indice). Backup come in 1.1.
- [x] 1.9 `addComment({…, messageId?})` scrive la colonna (tasks.ts:3670);
  `rowToComment` espone `messageId`; `shared/board.ts:1350-1380`
  `TaskComment.messageId?: string | null`.
- [x] 1.10 Scrittori dell'ancora: `routes/tasks.ts:3425-3470` (`comment_task`) con
  `ctx.isStreaming(sk)?.messageId ?? null`; la PATCH di sessione con
  `status:'review'`+`summary` passa l'id a `update()` → tasks.ts:3345 sulla riga
  `delivery`; `routes/permission.ts:57-67` (domanda instradata);
  `getLastAgentText` (server.ts:1560-1592) torna `{text, id} | null`,
  `recoverAgentWords` (task-dispatcher.ts:2628-2633) e il chiamante a 2215 si
  adeguano, `deliverToReviewBySystem` (tasks.ts:4431-4560) scrive `message_id`
  sulla nota con le «Ultime parole».
- [x] 1.11 Test nuovi: `userRowMarks` scrive `commentIds` solo con `dispatched`;
  `resume` con `commentIds` → body con `dispatchedFor`; il flush di `onTurnEnd`
  conserva gli id; `addComment({messageId})` round-trip in `rowToComment`;
  `getLastAgentText` torna l'id giusto saltando i cartelli ⚠️.
- [x] 1.12 Barra T1: `bun test server/lib/user-row-marks.test.ts
  server/services/task-dispatcher.test.ts server/services/tasks.comment-kind.test.ts
  server/services/tasks.delivery.test.ts server/services/tasks.system-delivery.test.ts
  tests/integration/ultima-prosa-agente.test.ts
  tests/integration/migration-*-dispatched-envelopes.test.ts` verde;
  `bun run typecheck` verde; query sqlite della barra → 0 sul DB vivo (dopo il
  backup, con `restart-when-idle` e mai `kickstart`); task-dispatcher.test.ts:3799
  invariato e verde.

## 2. T2 — La sessione dallo store della chat, il drawer dichiara il suo topic (client, nessun cambio visivo)

- [x] 2.1 `client/src/state/topicSubscriptions.ts` (+ `.test.ts`): insieme extra
  con conteggio — `holdTopic(topicId): () => void`, `getExtraTopicIds()`,
  `subscribeExtraTopics(cb)` — stabile per riferimento.
- [x] 2.2 `usePanelLifecycle.ts:2553`: il frame `subscribe` manda
  `presenceTopicIds ∪ extra` (dedup), effetto dipendente anche da `extra`;
  `presence:announce` (2537-2552) invariato. Server invariato (server.ts:3963,
  server/lib/ws-topic-routing.ts:33).
- [x] 2.3 `loadHistory` e `onMessage` per prop: `ProjectWindow.tsx:504` e
  `StandaloneChatGroup.tsx:739` → `KanbanBoardPane` (props 574, `onMessage` 65)
  → `TaskDetail` (KanbanBoardPane.tsx:1913).
- [x] 2.4 In `TaskDetail.tsx` sostituire `sessionMsgs`/`loadSession`/poll/
  `sessionCatchUp`/`streamPreview` (1594-1656) con: `usePaneAlive()`;
  `holdTopic(task.assignedTopicId)` gated; `useSyncExternalStore` su
  `subscribeSession`/`getSessionMessagesFromStore` gated; `loadHistory(sessionKey)`
  su mount/cambio chiave, nell'`onWake` esistente (925-934, UN listener) e su ogni
  `stream:end` con `sessionKey` uguale ricevuto da `onMessage`. Mappa temporanea
  ChatMessage→SessionMsg per `SessionPane`, che T3 toglie; `streamPreview`
  ricavato dall'ultima riga assistant `partial` finché T3 non lo toglie.
- [x] 2.5 Riscrivere `client/src/components/Board/TaskDetail.test.ts` (scan del
  sorgente): niente `/api/history` né `}, 3000);`; presenti `usePaneAlive()` e
  `holdTopic(`; sottoscrizione gated su `paneAlive`; UN solo
  `addEventListener('visibilitychange'`; recupero su `stream:end` filtrato per
  `sessionKey`. Docblock KANBAN-52 aggiornato.
- [x] 2.6 e2e `DRAWER-05a` in `tests/e2e/board-drawer-scroll.spec.ts`: card legata
  a un topic con turno vivo del provider di test (pattern
  `tests/e2e/turn-interrupted-live.spec.ts` + `/api/test/tasks/:id/bind-topic`
  come a 145-152) → `page.route('**/api/history/**')` armato DOPO il mount conta 0
  richieste finché il turno è vivo, e il testo streammato compare PRIMA di
  `stream:end`; la lettura di recupero su
  `stream:end` NON e' asseribile dalla rete a questa scala (il dedup da 5 s di
  `loadHistory` la trattiene: il contatore misurerebbe il dedup, non il drawer)
  e resta al cancello sul sorgente; il `stream:tool_permission_required` non e'
  osservabile finche' il pane della sessione non disegna le tool row, cioe'
  fino a T3, e viaggia con lo stesso instradamento del testo, che qui e'
  provato.
- [x] 2.7 Barra T2: `bun test client/src/state/topicSubscriptions.test.ts
  client/src/components/Board/TaskDetail.test.ts client/src/hooks` verde (con
  `holdTopic('t1')` il frame `subscribe` contiene `t1` e non lo contiene dopo il
  release; `listSessions().watched` true mentre il drawer è iscritto);
  `bun run typecheck` verde; DRAWER-04 (493-540) ancora verde.

## 3. T3 — Una colonna: la proiezione e il drawer che la disegna; via la scheda Sessione

- [x] 3.1 `client/src/components/Board/taskTimeline.ts` + `taskTimeline.test.ts`:
  `TimelineItem`, `mergeTaskTimeline(comments, msgs, {status, pinnedDeliveryId}, prev?)`
  con le regole (a) busta con `commentIds` nascosta / senza → `envelope` / user
  senza busta → umano; (b) strip di `mcp__topics__comment_task`/`update_task`/
  `ask_user_question` SOLO con `comments.some(c => c.messageId === msg.id)`, riga
  vuota scartata; (c) `coalesceToolRuns` prima; (d) merge a due puntatori, tie →
  commento, commento ancorato subito DOPO il suo messaggio — compreso il caso in
  cui il messaggio è la `partial`: test con `m9` `partial` e `c9` con
  `messageId='m9'` → ordine `m9`, `c9`, riga live; (e) la `partial` è l'ULTIMO
  MESSAGGIO della sessione, i commenti ancorati a lei la seguono subito dopo, la
  riga live (`task-session-live`) viene dopo di loro; (f) `pinnedDeliveryId`
  esclusa; (g) stabilità per riferimento; (h) chip `delivered`/`pending`
  derivato. Un test per regola. Nessun predicato testuale.
- [x] 3.2 `client/src/components/Chat/dispatchedEnvelope.ts`:
  `envelopeCommentIds(blocks): string[]` (+ test).
- [x] 3.3 `DispatchEnvelopeRow` estratta da `MessageBubble.tsx:253-270` in
  `client/src/components/Chat/DispatchEnvelopeRow.tsx`, usata da entrambe le
  superfici.
- [x] 3.4 Render in `TaskDetail.tsx` `renderThread` (1685-1755):
  `<ThreadRuns comments={timeline} …>` con `renderRow` che smista su `source`
  (comment → `CommentBubble` + chip `board.task.delivered`/`board.task.queuedForTurn`
  sotto la bolla propria; session assistant → `SessionItem` = `MessageContent`
  dentro `COMPACT_MD_CLS` senza `usage*`/`costCents`; session user → bolla grigia;
  envelope → `DispatchEnvelopeRow`).
- [x] 3.5 UNA `SessionLiveRow` (spostata con `Ticker` in
  `client/src/components/Board/SessionLiveRow.tsx`, senza `preview`/`onOpenPane`)
  sotto la riga `partial` quando `agentBusy`; `task-stream-preview` sparisce.
- [x] 3.6 Stick-to-bottom entro 80 px (regola di SessionPane.tsx:139-150) sul solo
  scroller (1710), via lo `scrollIntoView` su `comments.length` (935).
- [x] 3.7 Vuoto: `task-thread-empty` quando `timeline.length === 0` (cade
  `!task.assignedTopicId`, 1716-1720). Banda della consegna su done tenuta, riga
  esclusa. Etichetta `board.task.threadLabel` → «Conversazione»/«Conversation».
- [x] 3.8 Cancellare: `sessionBuckets.ts` (+test), `SessionPane.tsx`,
  `renderSessionPane` (1766-1782), ramo `session:` di `renderSurface` (1787),
  `bucketsRef`/`sessionBuckets`/`boundaryIds` (1668-1683), la mappa temporanea di
  T2; in `useTaskBrowserGroupLayout.tsx` `sessionActive`/`sessionTitle`/
  `sessionPane`/`sessionPaneId` (57, 64-71, 179-181, 192-198); la prop `breaksRun`
  di `ThreadRuns.tsx:75-79` (+ riga in ThreadRuns.test.tsx:45-49); i18n
  `board.task.sessionLabel/sessionReplied/sessionEmpty/openSessionPane/streamPreviewTitle`
  (i18n-it.ts:732, 769-773; i18n-en).
- [x] 3.9 e2e in `tests/e2e/board-drawer-scroll.spec.ts`: DRAWER-04 riscritto
  («il passo sta dentro `task-session-column` e non esiste `pane-tab-session:*`»);
  DRAWER-03b senza l'asserzione sulla tab; DRAWER-05 (estende 05a): passo vivo
  nella colonna; steer dal composer → bolla con chip «in coda» → dopo
  `stream:end` e la ripresa la busta con `commentIds` NON compare e il chip dice
  «consegnato»; commento agente seminato con `messageId` sta subito sotto il suo
  messaggio e la tool row `comment_task` non è disegnata; `ask_user_question` in
  `waiting_for_input` senza commento instradato mostra il `ToolInputForm`.
  Il passo assistant si semina con `POST /api/topics/:topicId/system-message`
  (board-drawer-scroll.spec.ts:152), il seme che i test già usano.
  Registrare il `.webm` di DRAWER-05.
- [x] 3.10 Barra T3: `bun test client/src/components/Board client/src/components/Chat`
  verde; `bun run typecheck` e `bun run check:deadcode` verdi;
  `bunx playwright test tests/e2e/board-drawer-scroll.spec.ts tests/e2e/board.spec.ts
  tests/e2e/board-card-vs-session.spec.ts tests/e2e/board-review-quiet-note.spec.ts`
  verde contro :13334; DRAWER-03 invariato (320-400 px); ThreadRuns.test.tsx:132-140
  verde; screenshot 1600×900 del modo largo allegato alla card.

## 4. T4 — Il composer dice il verbo, i tasti in ogni stato, lo stato di consegna non è più una nota

- [x] 4.1 Composer (`TaskDetail.tsx:3046-3095`, semantica server invariata):
  placeholder e title derivati — review con agent → `board.task.replyPlaceholder`
  con «{sendBack}» + «Nota»; in_progress → `board.task.steerPlaceholder` o, con
  domanda pendente, nuovo `board.task.answerPlaceholder`; done/todo/backlog →
  `board.task.commentPlaceholder`. Nessun composer spento in più.
- [x] 4.2 Risposte rapide: `pending` (999-1001) da `isAgentReview && …` a
  «`lastThreadComment` è un blocco question e `task.status !== 'done'`»;
  `usableQuestionOptions` (1019-1023) e `ReviewDecisionRow` invariati.
- [x] 4.3 `interceptBoardAction(root, text)` estratta da `routes/tasks.ts:2876-2892`
  in `server/services/board-actions.ts` (+ `board-actions.test.ts`), chiamata anche
  dalla rotta dei commenti (3147-3236) DOPO `quiet` (3175) e DOPO
  `pendingRoutedAsk` (3190), PRIMA di reject/resume (3218-3230).
- [x] 4.4 Via le due note (`task-dispatcher.ts` 3086-3095 e 2722-2729); restano
  2699-2707 e 3121-3151. La misura scritta qui («nessun test cerca le due
  stringhe») era su `Feedback ricevuto mentre` / `arrivato a turno finito`: DUE
  test le cercavano per FRAMMENTO (`mentre l'agent sta lavorando`, `resta nel
  thread`), e sono stati riscritti sulla regola nuova — un messaggio umano
  bufferizzato a turno vivo non produce righe `service`, e il resume seguente
  porta `commentIds`.
- [x] 4.5 i18n it/en per le chiavi nuove; `grep` su `docs/board-protocol.md` non
  trova le due note.
- [x] 4.6 e2e `BOARD-08b` in `tests/e2e/board.spec.ts`: card `in_progress` con
  una domanda `ask_user_question` instradata (POST /api/sessions/:sk/ask-user su
  un task legato, come `server/routes/permission.test.ts`) → tasti sopra il
  composer, un click chiude il rendez-vous (`waiting_for_input` → chiuso) senza
  reject. e2e `DRAWER-06`: steer durante un turno vivo → nessuna `task-app-note`
  con «Feedback ricevuto», solo il chip «in coda».
- [x] 4.7 Barra T4: `bun test server/services/task-dispatcher.test.ts
  server/services/board-actions.test.ts server/routes` verde;
  `bun run typecheck` verde; board-review-quiet-note e BOARD-08 verdi; BOARD-08b e
  DRAWER-06 verdi.

## 5. Barra di tornata e prova

- [ ] 5.1 `bun run typecheck` verde.
- [ ] 5.2 `bun test client/src/components/Board client/src/components/Chat
  client/src/state server/lib server/services/task-dispatcher.test.ts
  server/services/tasks.system-delivery.test.ts server/services/tasks.comment-kind.test.ts
  server/services/tasks.delivery.test.ts tests/integration/ultima-prosa-agente.test.ts
  tests/integration/migration-*-dispatched-envelopes.test.ts` verde.
- [ ] 5.3 `bun run check:deadcode` verde (zero export morti dopo la cancellazione
  di SessionPane/sessionBuckets/sessionPaneId).
- [ ] 5.4 `bunx playwright test tests/e2e/board-drawer-scroll.spec.ts
  tests/e2e/board.spec.ts tests/e2e/board-card-vs-session.spec.ts
  tests/e2e/board-review-quiet-note.spec.ts` verde contro :13334 (oltre questi 4
  file la batteria va sul PC, CLAUDE.md «Lavori pesanti»).
- [ ] 5.5 Query sqlite della bonifica → 0 sul DB vivo (riferimento: 2301).
- [ ] 5.6 Ciò che è verde resta verde: BOARD-03b/08/13, board-card-vs-session
  («Apri la sessione» e `task-session-gone`), board-review-quiet-note (`quiet`),
  ThreadRuns.test.tsx:132-140, server/lib/ws-topic-routing.test.ts,
  server/routes/permission.test.ts, task-dispatcher.test.ts (la busta
  `Human update on task` non cambia testo).
- [ ] 5.7 Prova: `.webm` di DRAWER-05; screenshot 1600×900 del modo largo; output
  del test di migration e della query sqlite; output verdi di typecheck, bun test,
  check:deadcode e dei 4 file e2e.
