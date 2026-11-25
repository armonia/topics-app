# Delta: kanban — la conversazione unica della card

## MODIFIED Requirements

### Requirement: KANBAN-35 — Nel pannello c'è UN SOLO contenitore che scorre, e la decisione resta in vista

Nel pannello di un task SHALL esistere UN SOLO contenitore che scorre in
verticale. Quando nessuno possiede l'altezza, ogni sezione si mette un tetto
addosso, e il primo pezzo tagliato è l'ULTIMO figlio — cioè proprio i comandi
della decisione.

I comandi della decisione SHALL restare DENTRO la finestra, PRIMA e DOPO lo
scorrimento, anche nel caso peggiore: un'evidenza altissima, decine di commenti,
tutte le sezioni aperte.

L'anteprima SHALL avere un tetto proporzionato al pannello, non un'altezza che se
lo mangia.

Chiudere una sezione SHALL nascondere ciò che le appartiene e NON SHALL muovere i
comandi della decisione.

In modo LARGO la CONVERSAZIONE della card SHALL stare a sinistra e lo spazio di
lavoro (browser, Piano, allegati) a destra, con l'intestazione a piena larghezza
sopra entrambe, e nessuna delle due colonne SHALL essere annidata nell'altra.

La conversazione della card SHALL essere UNA lista ordinata nel tempo: i commenti
del filo e i passi della sessione, nella colonna col composer. NON SHALL esistere
una scheda separata per la sessione: nel DOM NON SHALL comparire alcun
`pane-tab-session:*`, e la riga live (fase, ticker, Stop) SHALL essere UNA
(`task-session-live`), non una per superficie.

> Prima diceva: «In modo LARGO la sessione dell'agente SHALL stare da una parte e
> il resto dall'altra … La sessione dell'agente SHALL essere una SCHEDA, presente
> solo quando c'è davvero una sessione.» La scheda nasceva dal commit
> `1ab9c390d`, che aveva portato la sessione fuori dalle fette perché intercalata e
> ripiegata a ogni poll era illeggibile; con una proiezione ordinata per istante e
> una riga live sola la scheda non ha più un motivo di esistere.

MISURA: e2e DRAWER-03 in `tests/e2e/board-drawer-scroll.spec.ts` —
`task-session-column` in modo largo fra 320 e 400 px, `task-drawer-right` a
destra; DRAWER-04 riscritto — il passo dell'agent sta DENTRO `task-session-column`
e `pane-tab-session:*` non esiste; una sola `task-session-live` nel DOM.

#### Scenario: il caso peggiore
- **GIVEN** un'evidenza altissima, molti commenti e tutte le sezioni aperte
- **THEN** i comandi della decisione SHALL restare dentro la finestra

#### Scenario: chiudere una sezione
- **GIVEN** una sezione chiusa
- **THEN** i comandi della decisione NON SHALL spostarsi

#### Scenario: una card dispatchata non ha una scheda Sessione
- **GIVEN** una card legata a un topic con un turno vivo
- **WHEN** il pannello è aperto in modo largo a 1600×900
- **THEN** il passo dell'agent è dentro `task-session-column`
- **AND** nessun `pane-tab-session:*` esiste nel DOM
- **AND** esiste UNA sola `task-session-live`

### Requirement: KANBAN-52 — Il pannello non LEGGE quando nessuno lo guarda, e la sessione arriva dallo stesso store della chat

Il pannello di un task NON SHALL leggere la cronologia quando non ha un posto nel
layout: congelare i DISEGNI di una superficie nascosta non ferma gli effetti di un
sottoalbero già montato, e un pannello parcheggiato dietro un'altra superficie
continuava a leggere. Sottoscrizione e dichiarazione del topic SHALL essere
entrambe gated sulla vivezza della pane (`usePaneAlive()`).

Al ritorno in vista SHALL RECUPERARE (`loadHistory` del proprio `sessionKey`), e
SHALL farlo sullo STESSO ascoltatore, non su uno nuovo per giro: UN solo listener
`visibilitychange` nel sorgente del pannello.

Il pannello SHALL DICHIARARE il topic della sessione al filo — il frame
`subscribe` porta `presenceTopicIds ∪ extra` — mentre ha un posto nel layout, e la
sessione SHALL arrivare dallo stesso store della chat
(`getSessionMessagesFromStore`), non da un poll. Durante un turno vivo il pannello
NON SHALL leggere `/api/history/**` per SEGUIRE il turno: le sole letture ammesse
sono il mount, il risveglio (`visibilitychange`) e lo `stream:end` del proprio
`sessionKey`; il testo del passo SHALL comparire nella colonna PRIMA del frame
`stream:end`. La dichiarazione NON SHALL
toccare `presence:announce`: il pannello non è una chat aperta per le altre
finestre.

Una busta di dispatch che porta gli id dei commenti che consegna (`commentIds`)
NON SHALL essere disegnata: le parole sono già le righe-commento. Una busta senza
id SHALL essere una riga collassata.

Un turno umano scritto direttamente nella chat del topic SHALL comparire nella
conversazione come bolla della persona.

Una chiamata specchiata (`comment_task`, `update_task`, `ask_user_question`)
SHALL sparire dalla riga della sessione SOLO quando la riga che ne è l'effetto
porta la sua ancora (`messageId` uguale all'id del messaggio); altrimenti SHALL
restare.

Il turno in corso (`partial`) SHALL essere l'ultimo messaggio della sessione;
dopo di lui SHALL venire solo i commenti che lo hanno per ancora e la riga live
(KANBAN-73, regola 4).

Una riga il cui contenuto NON è cambiato SHALL restituire lo STESSO oggetto: la
stabilità è per RIFERIMENTO (il commento o il messaggio dello store sono lo stesso
oggetto di prima), non per confronto di valore.

> Prima diceva: «interroga la cronologia a intervalli … SHALL SALTARE il giro
> quando la finestra non è in vista … Il taglio della sessione fra i commenti
> SHALL essere UNA passata … solo un confronto di VALORE può tenere stabile … I
> confini fra i tratti di sessione … SHALL COLLASSARE in uno … I turni umani
> iniettati nella sessione SHALL essere tolti: il filo li mostra già.» Il poll, il
> taglio e i confini non esistono più; i turni umani NON si tolgono: la busta si
> nasconde per ANCORA e la parola della persona si mostra.

MISURA: `client/src/components/Board/TaskDetail.test.ts` (scan del sorgente) —
NON contiene `/api/history` né `}, 3000);`, contiene `usePaneAlive()` e
`holdTopic(`, la sottoscrizione è gated su `paneAlive`, UN solo
`addEventListener('visibilitychange'`, il recupero su `stream:end` filtra per
`sessionKey`. `client/src/state/topicSubscriptions.test.ts` — con `holdTopic('t1')`
il frame `subscribe` contiene `t1` e non lo contiene dopo il release. e2e
DRAWER-05a in `tests/e2e/board-drawer-scroll.spec.ts` — `page.route('**/api/history/**')`
armato DOPO il mount conta 0 richieste finché il turno è vivo, e il testo streammato
compare prima di `stream:end`.

#### Scenario: nessuna richiesta durante un turno vivo
- **GIVEN** una card legata a un topic con un turno vivo del provider di test
- **WHEN** il pannello è aperto e un contatore su `/api/history/**` è armato DOPO il mount
- **THEN** il contatore resta a 0 finché arriva `stream:end`
- **AND** il testo del passo compare in `task-session-column` PRIMA di `stream:end`

#### Scenario: il topic si dichiara e si ritira
- **GIVEN** un pannello vivo su una card con `assignedTopicId = t1`
- **THEN** il frame `subscribe` contiene `t1`
- **WHEN** il pannello perde il posto nel layout
- **THEN** il frame `subscribe` successivo non contiene `t1`
- **AND** `presence:announce` non è cambiato

#### Scenario: un permesso a metà turno compare nella conversazione
- **GIVEN** un pannello iscritto alla sessione
- **WHEN** arriva `stream:tool_permission_required` per quella sessione
- **THEN** lo stato `awaiting_permission` è nello store della sessione del pannello
- **AND** la riga del permesso è disegnata nella conversazione

#### Scenario: un turno umano scritto nella chat
- **GIVEN** un messaggio `role='user'` senza blocco busta nella storia del topic
- **THEN** compare nella conversazione come bolla della persona

## ADDED Requirements

### Requirement: KANBAN-72 — Un fatto specchiato porta un'ANCORA, una per verso

Una riga del filo scritta da una sessione SHALL poter portare l'ancora del
messaggio che l'ha prodotta: `task_comments.message_id TEXT NULL`, aggiunta con
una migration che fa SOLO `ADD COLUMN` — nessun backfill, nessun indice, nessuna
riga di `task_comments` riscritta. Il DB vivo (`data/topics.db` + `-wal`) SHALL
essere salvato PRIMA che il file di migration esista, come per CHAT-ENV-01. Il
valore SHALL essere l'id del messaggio in streaming al momento della chiamata
(`ctx.isStreaming(sk)?.messageId`), e SHALL
essere scritto da tutti e quattro gli scrittori di sessione: il commento
dell'agent (`comment_task`), la riga `delivery` della consegna
(`update({status:'review', summary})`), la domanda instradata a metà turno e la
nota di sistema che porta le «Ultime parole dell'agent». `addComment` SHALL
accettare `messageId`, `rowToComment` SHALL esporlo come `TaskComment.messageId`,
e l'ancora SHALL arrivare al client SENZA frame nuovi: `task:updated` porta solo
il task, e il pannello rilegge GET /api/boards/:p/tasks/:t (`rowToComment`) a
ogni `bump`, che espone `comments[].messageId`.

Nel verso opposto, la busta di ripresa SHALL portare gli id dei commenti umani che
consegna: `{ kind: 'dispatched-envelope', commentIds?: string[] }`. Gli id SHALL
essere scritti solo su una riga marcata `dispatched` e solo se l'elenco non è
vuoto, e SHALL sopravvivere a ogni passaggio del dispatcher: buffer a turno vivo,
flush a fine turno, attesa di slot. Il TESTO della busta NON SHALL cambiare.

Un'ancora assente NON SHALL essere un errore: il lettore SHALL trattarla come
«nessuna ancora» e disegnare entrambe le righe (KANBAN-73).

MISURA: `bun test server/lib/user-row-marks.test.ts server/services/task-dispatcher.test.ts
server/services/tasks.comment-kind.test.ts server/services/tasks.delivery.test.ts
server/services/tasks.system-delivery.test.ts tests/integration/ultima-prosa-agente.test.ts`
verde con i test nuovi: `userRowMarks` scrive `commentIds` solo con `dispatched`;
`resume` con `commentIds` produce un turno il cui body porta `dispatchedFor`; il
flush di `onTurnEnd` conserva gli id; `addComment({messageId})` fa round-trip in
`rowToComment`; `getLastAgentText` torna l'id della riga giusta saltando i cartelli
⚠️. Il test di task-dispatcher.test.ts:3799 (`Human update on task`) resta
invariato e verde.

#### Scenario: il commento dell'agent porta l'id del suo messaggio
- **GIVEN** una sessione con un turno in streaming il cui messaggio ha id `m1`
- **WHEN** l'agent chiama `comment_task`
- **THEN** la riga di `task_comments` ha `message_id = 'm1'`
- **AND** GET /api/boards/:p/tasks/:t risponde con `comments[].messageId = 'm1'` alla rilettura del pannello

#### Scenario: la busta porta gli id dei commenti che consegna
- **GIVEN** un commento umano `c1` su una card `in_progress` senza turno vivo
- **WHEN** il dispatcher riprende l'agent
- **THEN** la riga `user` scritta in `messages` ha il blocco
  `{kind:'dispatched-envelope', commentIds:['c1']}`
- **AND** il testo della busta è identico a quello di prima

#### Scenario: due commenti bufferizzati a turno vivo escono in UNA busta con due id
- **GIVEN** un turno vivo e due commenti umani `c1`, `c2` arrivati durante il turno
- **WHEN** il turno finisce e la card è `in_progress`
- **THEN** la busta di ripresa porta `commentIds: ['c1','c2']`

#### Scenario: nessun id senza marchio
- **GIVEN** una riga `user` non dispatchata
- **WHEN** `userRowMarks` riceve `commentIds` non vuoto e `dispatched: false`
- **THEN** nessun blocco `dispatched-envelope` viene scritto

#### Scenario: il reject con testo scrive UNA riga e la ancora
- **GIVEN** una card in review con agent
- **WHEN** la persona rimanda indietro con un testo
- **THEN** `task_comments` contiene UNA sola riga con quel testo (dedupe autore+testo)
- **AND** `review_comment` è conservato
- **AND** la busta di ripresa porta l'id di quella riga

### Requirement: KANBAN-73 — La conversazione è UNA proiezione: ordine per istante, strip per ancora, mai una riga nascosta

La conversazione della card SHALL essere una funzione PURA dei commenti del filo e
dei messaggi della sessione (`mergeTaskTimeline(comments, msgs, {status,
pinnedDeliveryId}, prev)`), testata senza DOM, senza nessun predicato testuale sul
contenuto. Le regole SHALL essere applicate in quest'ordine:

1. Una riga `user` con blocco busta E `commentIds` → NASCOSTA. Una busta senza
   `commentIds` → riga collassata. Un `user` senza busta → bolla della persona.
2. Una tool call specchiata (`mcp__topics__comment_task`,
   `mcp__topics__update_task`, `mcp__topics__ask_user_question`) SHALL essere
   tolta dalla riga SOLO se esiste un commento con `messageId === msg.id`. Senza
   ancora la tool row SHALL restare: una domanda `ask_user_question` non
   instradata SHALL vedersi e rispondersi dal suo modulo nella conversazione. Una
   riga rimasta senza contenuto, ragionamento e tool SHALL essere scartata.
3. Le corse di tool consecutive SHALL essere fuse («N azioni») prima della
   fusione con i commenti.
4. L'ordine SHALL essere per istante; a parità SHALL venire prima il commento; un
   commento con `messageId` SHALL essere disegnato SUBITO DOPO quel messaggio,
   qualunque sia l'orologio. La riga `partial` SHALL essere l'ULTIMO MESSAGGIO
   della sessione; i commenti ancorati a lei SHALL seguirla, subito dopo; la riga
   live (`task-session-live`) SHALL venire dopo di loro.
5. Su una card `done` la `delivery` appuntata nella banda SHALL essere ESCLUSA
   dall'elenco. La nota con le «Ultime parole dell'agent» SHALL restare in elenco e
   NON SHALL piegarsi.
6. Un item il cui commento o messaggio è lo stesso riferimento di prima SHALL
   essere lo stesso oggetto.

Il modo di sbagliare SHALL essere una riga in più, MAI una riga nascosta. La lista
vuota SHALL mostrare la frase di EMPTYTHREAD-01 per lo stato della card, anche se
la card ha un topic.

MISURA: `bun test client/src/components/Board` — `taskTimeline.test.ts` copre le
regole 1-6 e il chip derivato (KANBAN-74); `dispatchedEnvelope.test` copre
`envelopeCommentIds`; ThreadRuns.test.tsx:132-140 resta verde. e2e DRAWER-05: un
commento agente seminato con `messageId` sta subito sotto il suo messaggio e la
tool row `comment_task` non è disegnata; un messaggio con `ask_user_question` in
`waiting_for_input` SENZA commento instradato mostra il `ToolInputForm` nella
colonna; la busta con `commentIds` NON compare. BOARD-03b (`board.spec.ts`) resta
verde.

#### Scenario: il commento ancorato si disegna una volta, subito dopo il suo passo
- **GIVEN** un messaggio assistant `m1` con una tool call `mcp__topics__comment_task`
- **AND** un commento `c1` con `messageId = 'm1'` e `createdAt` più vecchio di `m1`
- **THEN** la conversazione ha `m1` senza la tool row e `c1` subito dopo `m1`

#### Scenario: il commento ancorato alla riga in streaming la segue, e la riga live viene dopo
- **GIVEN** una riga assistant `partial` `m9` e un commento `c9` con `messageId = 'm9'`
- **THEN** l'ordine è `m9`, `c9`, riga live

#### Scenario: senza ancora restano entrambe le righe
- **GIVEN** un messaggio assistant `m2` con `mcp__topics__comment_task`
- **AND** un commento `c2` con `messageId = null`
- **THEN** la tool row di `m2` resta e `c2` è ordinato per istante

#### Scenario: la domanda non instradata si risponde dalla conversazione
- **GIVEN** un messaggio con `ask_user_question` in `waiting_for_input` e nessun commento con quell'ancora
- **THEN** la conversazione mostra il modulo della domanda
- **AND** rispondere lì chiude il rendez-vous senza un reject

#### Scenario: la busta con id non si vede, quella senza è una riga collassata
- **GIVEN** una riga `user` busta con `commentIds: ['c1']` e una riga `user` busta di kickoff senza id
- **THEN** la prima non compare
- **AND** la seconda è una `DispatchEnvelopeRow` collassata

#### Scenario: la delivery appuntata non si dipinge due volte
- **GIVEN** una card `done` con una riga `delivery` `d1` appuntata nella banda
- **THEN** `d1` non è nell'elenco della conversazione

#### Scenario: stabilità per riferimento
- **GIVEN** una proiezione precedente `prev` e gli stessi oggetti commento/messaggio
- **THEN** ogni item invariato è lo stesso oggetto di `prev`

### Requirement: KANBAN-74 — «Consegnato» e «in coda» si DERIVANO dalla busta, mai si scrivono

Lo stato di consegna di un messaggio umano SHALL essere derivato a ogni lettura
dalle buste della sessione, e SHALL essere mostrato come chip sotto la bolla della
persona:

- **consegnato** — esiste una busta che porta il suo id in `commentIds`; il chip
  SHALL portare il link al messaggio;
- **in coda** — nessuna busta porta il suo id, nessuna busta è più recente del
  commento, e la card è `in_progress` o `todo`;
- **niente** — altrimenti.

Nessun processo SHALL scrivere questo stato nel filo (KANBAN-36). Un riavvio che
perde il buffer NON SHALL lasciare una promessa: la busta di continuazione, più
recente del commento, fa cadere il chip da sola.

MISURA: `taskTimeline.test.ts` copre i tre casi e il riavvio (busta più recente
senza l'id → nessun chip). e2e DRAWER-05: steer scritto nel composer durante un
turno vivo → bolla grigia con chip «in coda»; dopo `stream:end` e la ripresa il
chip dice «consegnato». i18n `board.task.delivered` / `board.task.queuedForTurn`
in it/en.

#### Scenario: in coda, poi consegnato
- **GIVEN** un turno vivo su una card `in_progress`
- **WHEN** la persona scrive nel composer
- **THEN** la bolla porta il chip «in coda»
- **WHEN** il turno finisce e la busta di ripresa porta il suo id
- **THEN** il chip dice «consegnato» e punta al messaggio

#### Scenario: il riavvio non promette niente
- **GIVEN** un commento `c1` mai portato da una busta
- **AND** una busta di continuazione con `timestamp > c1.createdAt` senza `commentIds`
- **THEN** `c1` non porta nessun chip

#### Scenario: una card done non ha code
- **GIVEN** un commento umano su una card `done` senza busta
- **THEN** nessun chip

### Requirement: KANBAN-75 — Le due note di stato del dispatcher NON si scrivono più

Il dispatcher NON SHALL scrivere nel filo la nota «Feedback ricevuto mentre
l'agent sta lavorando…» quando bufferizza un messaggio umano a turno vivo, né la
nota «Il tuo feedback è arrivato a turno finito…» quando il flush trova la card
fuori da `in_progress`/`review`: sono STATO, e lo stato è il chip di KANBAN-74.

SHALL restare, perché non sono stato: la nota di riapertura / «la consegna resta»
scritta a fine turno su una card in review (è una DECISIONE) e le note di attesa di
slot (portano la CAUSA).

MISURA: nessun test cerca oggi le due stringhe — `/usr/bin/grep -rl 'Feedback
ricevuto mentre\|arrivato a turno finito'` su `*.ts`/`*.tsx`/`*.md` trova solo
server/services/task-dispatcher.ts — quindi la misura NON è «nessun test le cerca
più», che sarebbe vera a vuoto: `bun test server/services/task-dispatcher.test.ts`
verde con un test NUOVO che prova che un messaggio bufferizzato a turno vivo non
produce righe `service` e che il resume seguente porta `commentIds`. e2e DRAWER-06
in `tests/e2e/board-drawer-scroll.spec.ts`: steer durante un turno vivo → nessuna
`task-app-note` con «Feedback ricevuto», solo il chip «in coda». `grep` su
`docs/board-protocol.md` non trova le due frasi.

#### Scenario: buffer a turno vivo senza nota
- **GIVEN** un turno vivo su una card `in_progress`
- **WHEN** arriva un commento umano
- **THEN** `task_comments` NON riceve una riga `service`
- **AND** al termine del turno la busta porta l'id del commento

#### Scenario: la decisione resta
- **GIVEN** un turno che finisce in review come consegna piana, con un commento bufferizzato
- **THEN** la nota «la consegna resta» viene scritta come oggi
