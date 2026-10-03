# Design: notifications-redesign

Tutte le righe di codice citate sono di `origin/main` f93eeb187 (03/10). Le prove stanno
in `evidence/`; la proposta dice quale file prova quale difetto.

## 1. Oggi: sei assi, tre memorie, tredici superfici

Il server tiene sei fatti su una chat e non li compone mai:

| Asse | Dove vive | Chi lo scrive | Chi lo legge |
|------|-----------|---------------|--------------|
| Turno | `activeStreams`, in memoria | `routes/chat.ts` | `stream:start`/`stream:end`, `turn:snapshot`, `GET /api/topics/streaming` |
| Lavoro in background | `BackgroundWork` per figlio CLI e registro `run_command`, in memoria | stdout della CLI, registro processi | stall judge, reaper, goal loop, poll di 15 s. Nessun frame |
| Fase Claude | `claude_code_sessions` (chat), mappa in memoria (terminali) | hook, coda del JSONL, reaper | `session:state`, `GET /api/claude-sessions` |
| Persona in mezzo | mappe dei bridge ask/permission | bridge MCP | solo il dispatcher |
| Non-letti | tabella `unread` | `finalizeTurnActivity` e altri | `unread:init`, `unread:updated` |
| Righe del registro | `notification_log` | `push-triggers` dentro ogni `broadcastToAll`, POST del client | `notification:new`/`seen`, numero della campanella |

Il client ci aggiunge tre segni in memoria per finestra (`chatFinishedTopics`,
`terminalFinishedIds`, `seenSubjects`) e ogni superficie fa la sua somma: la tab legge la
fase e il visto, il numero legge la fase senza visto, la campanella legge anche le righe,
la card del gruppo legge i terminali finiti che la tab ignora, la tab board conta solo le
review, ⌘J legge gli insiemi d'attesa. Il lavoro in background lo legge solo il glifo
grigio, da un poll di 15 s.

Ogni difetto della proposta è una di queste somme che non torna. Rattoppare le somme una
per una è quello che è stato fatto da agosto (CHAT-DONE-01, NOTIF-ONE-01/02,
SEEN-ANY-FOCUS-01/02, SEEN-01/02 sono tutte correzioni di superficie): la cura è avere una
somma sola, fatta dove stanno i fatti.

## 2. Una sorgente: lo stato di attenzione

### 2.1 Dove vive

Sul server, in `server/attention/`:

- `compose.ts`: funzione pura `composeAttention(inputs) → { state, reason, outcome, cause }`.
  Nessun I/O, testata a tabella.
- `store.ts`: la tabella `subject_attention`, l'epoca, il visto, e l'unico punto che
  scrive una riga e trasmette.
- `wire.ts`: collega gli eventi che il server ha già agli ingressi di `compose`.

Soggetto = chiave stringa già in uso nel registro: `topic:<id>`, `terminal:<id>`,
`task:<id>`.

```
subject_attention(
  subject      TEXT PRIMARY KEY,
  state        TEXT NOT NULL,      -- idle | working | background | needs-you | finished
  reason       TEXT,               -- needs-you: question | permission | plan | review | parked
  outcome      TEXT,               -- finished: done | error
  detail       TEXT,               -- una riga: la domanda, il tool, il motivo del parcheggio, l'errore, l'ultima notizia del background
  since        TEXT NOT NULL,      -- ingresso nello stato
  epoch        INTEGER NOT NULL,   -- cresce a ogni fatto acceso nuovo (§4)
  epoch_cause  TEXT,               -- il fatto che ha dato l'epoca corrente (§4)
  seen_epoch   INTEGER NOT NULL,   -- l'ultima epoca vista
  last_turn    TEXT,               -- JSON: { id, outcome: done|error, at, detail }
  seen_at      TEXT,               -- fin dove la persona ha visto i turni del soggetto (§6)
  background   TEXT,               -- JSON: i compiti in volo, per id (§5)
  updated_at   TEXT NOT NULL
)
```

Acceso (`lit`) = `state = 'needs-you'`, oppure `state = 'finished'` (che per §3 esiste
solo con un ultimo turno non visto).

### 2.2 Chi la scrive

Solo `store.applyInputs(subject, patch)`. Gli ingressi di un soggetto (`AttentionInputs`)
sono di due specie: quelli **salvati** nella riga, perché nessun altro li ricorda, e quelli
**riletti** a ogni avvio da dove già vivono.

| Ingresso | Specie | Scritto da (wire.ts) |
|----------|--------|----------------------|
| `turnOpen` | riletto (reattach) | `stream:start` / `stream:end` della rotta chat; `UserPromptSubmit` / `Stop` per i terminali; `terminal:activity` busy per i terminali senza hook |
| `hold` (`question`/`permission`/`plan`, id, testo, da quando) | riletto (attese salvate di HOLD-04; le mappe dei bridge ripartono vuote) | eventi di `human-hold-events.ts` (ask bridge, permission bridge); `PreToolUse` di `AskUserQuestion` e `ExitPlanMode`; il pannello del piano della rotta chat (`chat.ts:2144-2162`); la fase `awaiting-approval` e `paused`. Se la sessione è quella di una card in volo (la stessa ricerca di `taskWaitingOnSession`, `task-dispatcher.ts:2012-2015`), l'attesa va sul soggetto `task:<id>`, non sul topic |
| `background` (compiti per id) | salvato | §5 |
| `lastTurn` (`id`, `done`/`error`, quando, detail) | salvato | `stream:end` con un messaggio visibile; `Stop` dei terminali; `terminal:activity` finished per i terminali senza hook; `processEnded` (§5.5) |
| `processEnded` (`cause`) | evento | §5.5 |
| `card` (`review`/`parked`/null, da quando) | riletto (`tasks`) | `releaseAndEmit` e le transizioni di `services/tasks.ts` |
| `archived`, `deleted` | riletto (`topics`) | rotte dei topic, `archive-topic.ts`, unarchive (`routes/topics.ts:254-376`) |
| `closed` (terminale) | riletto (roster del bridge PTY e pane store) | tombstone della pane `terminal:<id>` nel pane store; chiusura della sessione PTY chiesta dalla persona |
| `dispatched` | riletto (dispatcher) | dispatcher |

Dopo ogni patch lo store ricompone. Scrive la riga e trasmette `attention:updated` quando
cambia uno qualunque di: `(state, reason, outcome)`, `epoch`, `seen_epoch`, il non-letto
del topic, `turnUnseen` (§6), il riassunto del background (numero e tipi). Quindi un
non-letto nuovo su una chat già accesa parte nello stesso frame, e il client non legge
più `unread:updated` per nessun numero. Nessun altro file scrive `subject_attention`, e un
test lo verifica con `git grep` (task 2.9).

### 2.3 Come ogni superficie ne deriva

Il client ha uno store (`client/src/state/attention.ts`) riempito solo da
`attention:init` e `attention:updated`, e due selettori puri:

- `attentionOf(subject) → { tier, lit, count, since, background }`: `tier` ∈ `needs-you |
  error | done | background | working | null`; `count` = `max(1, unread)` se acceso,
  altrimenti 0; `since` = ingresso nello stato; `background` = i compiti in volo.
- `rollupAttention(subjects) → { tier, count }`: il tier più alto fra i figli accesi
  (`needs-you` > `error` > `done`), `count` = figli accesi.

| Superficie | Legge |
|------------|-------|
| Tab di pane, riga della sidebar (chat e terminale) | `attentionOf` |
| Presenza e ordine delle righe della sidebar | `lit` e `since` di `attentionOf` (§8.2) |
| Riga e tab di progetto, card del gruppo | `rollupAttention` dei figli |
| Tab board e riga Board | `rollupAttention` dei soggetti `task:` del progetto (§8.3) |
| Vista per stato della sidebar | `tier`: «Ti aspetta», «Finite», «In background», «Al lavoro» |
| ⌘J e porta «In attesa» del telefono (CHAT-WAIT-03/04) | `tier = needs-you` con motivo `question`, `permission` o `plan` |
| Menu agenti | `background` e `working` per gli attivi, `done`/`error` accesi per i finiti |
| Glifo grigio, `StreamingIndicator`, `BackgroundWorkLine` | `tier = background` e i compiti di `attentionOf` |
| Stop del composer sul lavoro in background | `background` non vuoto (anche con tier `error`) |
| Inbox (campanella) | i soggetti accesi, §9 |
| Dock, tray, badge PWA | numero di soggetti accesi non archiviati, §8 |
| Banner e spinte | le transizioni, §10 |

Non ci sono altri ingressi. `notification_log` non entra in nessun numero.

## 3. Tassonomia e precedenza (scelta 1)

| Stato | Acceso | Si spegne | Colore |
|-------|--------|-----------|--------|
| `idle` | no | — | nessuno |
| `working` | no | — | spinner |
| `background` | no | — | glifo grigio «in background» |
| `needs-you` (`question`, `permission`, `plan`, `review`, `parked`) | sì, sempre | rispondendo, o quando la persona non serve più | ambra |
| `finished` / `done` | finché non visto | col visto | blu |
| `finished` / `error` | finché non visto | col visto | rosso |

`composeAttention` applica le regole in quest'ordine; vince la prima. «Non visto» vuol dire
`lastTurn.at > seen_at`.

1. `archived`, `deleted` o `closed` → `idle`.
2. `dispatched` (topic di un agente di board) → `idle`: il soggetto è la card.
3. `hold` aperto → `needs-you(hold.kind)`. `paused` (permesso scaduto) resta `permission`.
   Vale anche per un soggetto `task:`, che riceve l'attesa della sua sessione (§2.2).
4. `card = review` → `needs-you(review)`; `card = parked` → `needs-you(parked)`.
5. `turnOpen` → `working`.
6. `lastTurn.outcome = error` e non visto → `finished(error)`. Un errore vince sul
   background: il turno è andato storto e il lavoro rimasto non lo ripara.
7. almeno un compito in `background` che conta (§5.1) → `background`.
8. `lastTurn.outcome = done` e non visto → `finished(done)`.
9. altrimenti `idle`.

La regola 8 dopo la 7 è la scelta 2: lo stesso «ha finito» che il lavoro in background
teneva sotto riemerge quando l'ultimo compito torna, una volta sola.

Con l'alternativa della scelta 1 la riga 8 diventerebbe «`lastTurn = done` finché non
arriva un turno nuovo, visto o no», e `NOTIF-ONE-02` terrebbe lo scenario 4.
Con l'alternativa della scelta 2 la regola 8 richiederebbe anche che il turno precedente
non abbia avuto background.

## 4. Epoca e transizioni

### 4.1 L'epoca è legata al fatto

Ogni stato acceso ha una **causa**: l'id dell'attesa per `needs-you(question|permission|plan)`,
`card:<stato>:<da quando>` per review e parcheggio, `lastTurn.id` per `finished`.
L'epoca cresce solo quando la composizione dà uno stato acceso la cui
`(state, reason/outcome, causa)` è diversa da quella dell'epoca corrente (`epoch_cause`).

Quindi una ricomposizione con gli stessi fatti non fa mai un'epoca nuova: un ricarico del
server (§7), la riapertura di un topic archiviato, un processo che muore senza niente in
volo, un background che si svuota sopra un turno già visto. Ogni epoca nuova scrive UNA
riga di cronologia e passa per la decisione di §10.

### 4.2 Transizioni

| # | Da | Evento | A | Effetto |
|---|----|--------|---|---------|
| T1 | qualunque spento | `stream:start`, `UserPromptSubmit`, terminale busy | `working` | — |
| T2 | `working` | fine turno con messaggio, niente in background | `finished(done)` | epoca+1 |
| T3 | `working` | fine turno con compiti in volo | `background` | `lastTurn` aggiornato, nessuna epoca; non-letti +1 se c'è un messaggio |
| T4 | `background` | turno risvegliato | `working` | — |
| T5 | `background` | turno risvegliato chiuso, compiti ancora in volo | `background` | come T3 |
| T6 | `background` | l'ultimo compito torna e il turno che lo porta chiude | `finished(done)` | epoca+1 |
| T7 | `background` | l'ultimo compito torna e nessun turno si apre entro 5 s | `finished(done)` se `lastTurn.at > seen_at`, altrimenti `idle` | epoca+1 se acceso |
| T8 | `working` | si apre un'attesa (domanda MCP, AskUserQuestion, permesso, piano) | `needs-you` | epoca+1 |
| T9 | `needs-you` | risposta data, attesa chiusa | `working` | — |
| T10 | `working` | turno chiuso con `reason: "error"` (anche un taglio della macchina: watchdog, stall judge, rifiuto, limite) | `finished(error)` | epoca+1 |
| T10b | `working` | errore che il sistema riprende da solo (`resumesByItself`, `chat.ts:2305`) | `working` finché il rinvio riapre il turno | nessuna epoca |
| T11 | `finished` | visto (§6) | `idle` | spento ovunque |
| T12 | `working` | stop della persona (`user_abort`) o turno dispatchato | `idle` | nessun avviso |
| T13 | qualunque | archiviazione, cancellazione, chiusura del terminale | `idle` | `seen_epoch = epoch`, `seen_at = lastTurn.at`, righe del soggetto viste |
| T14 | card qualunque | entra in `review` o è parcheggiata | `needs-you(review|parked)` | epoca+1 |
| T15 | `needs-you(review|parked)` | la card esce da review, viene rimessa in coda, cancellata, archiviata | stato composto senza `card` | — |
| T16 | `working`/`background`/`needs-you` | il processo finisce senza che la persona lo chieda (§5.5) | `finished(error)` | epoca+1 |
| T17 | `working` | turno risvegliato scartato (vuoto) | lo stato di prima | niente: né non-letti né epoca |
| T18 | archiviato | riapertura (unarchive) | stato composto senza `archived` | nessuna epoca: il turno vecchio era già visto da T13 |
| T19 | qualunque | ricarico o riavvio del server | lo stato ricomposto dagli ingressi (§7) | nessuna epoca, nessun annuncio |

T10 e T12 non si toccano: uno stop della PERSONA è `idle`, un taglio della MACCHINA è un
errore che la persona deve vedere, come la spinta di errore di oggi (`chat.ts:2341`). Il
«finito» di un terminale senza hook è T2 con `terminal:activity` finished come fine turno;
il terminale con hook è T2 con `Stop`.

## 5. Il lavoro in background (scelta 2)

### 5.1 I compiti, per id

`background` è una mappa `taskId → { kind, label, startedAt, recurring? }`. Un compito
entra e esce per id; non c'è un booleano.

| Tipo | Entra | Esce | Conta per il tier |
|------|-------|------|-------------------|
| Bash con `run_in_background` | `PostToolUse` con l'id in `tool_response` | `<task-notification>` con quell'id nel transcript | sì |
| Agent con `run_in_background` | idem | idem | sì |
| Workflow (sempre in background) | `PostToolUse` («Task ID: …») | idem | sì |
| Monitor | `PreToolUse`/`PostToolUse` Monitor | consegna dell'ultimo evento o fine del Monitor nel transcript (anche la scadenza) | sì |
| CronCreate non ricorrente | `PostToolUse` | il suo primo scatto, o CronDelete | sì |
| CronCreate ricorrente | `PostToolUse` | CronDelete o fine del processo | **no** |
| `run_command` di Topics | registro dei processi | uscita del processo | sì |

Un cron ricorrente sta nella mappa, così `BackgroundWorkLine` e lo Stop lo mostrano, ma non
è un'attesa: è un calendario, e terrebbe il soggetto in background per sempre.
`composeAttention` lo salta.

### 5.2 Un detentore solo: lo store

La mappa del soggetto vive in `subject_attention.background` e lo store è l'unico che la
scrive. Le fonti la alimentano, non la tengono:

- **Chat** (CLI headless): la verità è lo snapshot `background_tasks_changed` che la CLI
  stampa prima del `result`, tenuto dal provider in `BackgroundWork`
  (`providers/claude/background-work.ts`), più `commandWakeState`. A ogni cambio di
  snapshot `wire.ts` riscrive la mappa del soggetto. Il frame `stream:end` porta
  `background: { count, kinds }` letto da una funzione nuova,
  `attentionBackground(sessionKey)`: compiti vivi, `wake-queued` (la CLI si sta già
  svegliando) e cron NON ricorrenti. NON da `backgroundState`/`backgroundOfTurn`, che
  restano al goal loop: quelli dicono `running` anche con un cron ricorrente armato
  (`hasArmedCron`, `claude-code.ts:3005`), fino a `BACKGROUND_WORK_CAP_MS` = 2 h, ed è
  giusto per il goal loop (che deve rimandare) e sbagliato per l'attenzione.
- **Terminali** (CLI interattiva): hook e transcript, tabella sopra. `wire.ts` scrive la
  mappa nello store; la macchina delle fasi non tiene un insieme suo: `applyHook` riceve
  allo `Stop` il numero di compiti che contano letto dallo store.
- **Client**: il glifo, `StreamingIndicator`, `BackgroundWorkLine` e lo Stop leggono
  `attentionOf`. `backgroundWorkTopics` e il poll di 15 s di `GET /api/topics/streaming`
  smettono di alimentarli; il poll resta solo per le righe dei servizi
  (`state/runningServices.ts`), che non sono attenzione. Così glifo e fill non possono
  divergere: vengono dallo stesso frame.

### 5.3 La fase

`applyHook` mette `watching` allo `Stop` quando il soggetto ha almeno un compito che conta,
non solo con un Monitor armato. `noteWatchDelivered` toglie l'id consegnato invece di un
booleano. `watching` resta una fase attiva per il client (MONITOR-04). La fase serve
ancora alle superfici che la mostrano (es. l'etichetta «sta guardando»); l'attenzione non
la legge per decidere se accendere.

### 5.4 Non-letti

`finalizeTurnActivity` alza il non-letto solo se il turno ha lasciato un messaggio visibile
(non con `discardedMessageId`). Un turno risvegliato con un messaggio («1 di 3 arrivato»)
lo alza anche in `background`: il numero non si vede finché il soggetto non si accende, e
quando si accende dice quanti messaggi ci sono da leggere.

### 5.5 La fine del processo

`processEnded { cause }` arriva da: `SessionEnd`, uscita del PTY, uscita del figlio CLI,
reaper per inattività, tetto di vita, crash (`markPtyCrash`, `claude-session-state.ts:640-650`),
uccisione da parte dello swap, e all'avvio per ogni soggetto il cui processo non c'è più.
Lo store:

- svuota la mappa dei compiti;
- se c'erano un turno aperto o compiti che contano, e la fine non l'ha chiesta la persona
  (stop, chiusura della tab, `SessionEnd` dopo `/exit`), scrive
  `lastTurn = { outcome: error, detail: «il processo è finito con N compiti in volo» }`:
  T16, `finished(error)` con un'epoca nuova, perché il risveglio che il soggetto aspettava
  non arriverà più. Fa eccezione un turno che il ripristino all'avvio riprende da solo
  (come T10b);
- altrimenti non tocca `lastTurn`: la ricomposizione ha la stessa causa e non fa epoche
  (§4.1). Il reaper che chiude una CLI ferma da 15 minuti non accende niente.

Un compito che non torna mai e un processo che resta vivo tengono il soggetto in
`background`, visibile dal glifo grigio: nessuna scadenza a tempo, perché una build di due
ore è legittima. Il tetto di vita del provider chiude comunque la CLI, ed è T16.

## 6. Il visto (scelta 3)

- **Di chi**: della persona che possiede l'installazione. Le socket degli ospiti non lo
  scrivono, non ricevono i frame (`lib/grants.ts`, come oggi per `notification:*`), e il
  loro frame `focus` (che `GUEST_INBOUND_FRAMES` lascia passare, `grants.ts:257`, e che
  `server.ts:4607` scrive in `focusedTopicId`) NON entra nel registro dei fuochi
  dell'attenzione.
- **Una porta**: `POST /api/attention/seen { items: [{ subject, epoch, turnAt }] }`, dove
  `turnAt` è il `lastTurn.at` che il client aveva nel suo store. Per ogni voce:
  `seen_epoch = max(seen_epoch, min(epoch, epoca corrente))`;
  `seen_at = max(seen_at, min(turnAt, lastTurn.at))`; per un topic azzera i non-letti (la
  stessa funzione di `markTopicSeen`); segna viste le righe di cronologia del soggetto fino
  a quell'epoca; trasmette `attention:updated` SEMPRE, anche se non ha cambiato righe
  (difetto E). `POST /api/topics/:id/read` e `/api/notifications/seen` restano come alias
  della stessa porta finché il client vecchio esiste, poi si tolgono.
- **Il visto di un turno senza epoca**: il frame porta `turnUnseen = lastTurn.at > seen_at`.
  Una pane a fuoco manda il visto quando il soggetto è acceso, quando ha non-letti, o
  quando `turnUnseen` è vero: così guardare una chat in `background` registra che il turno
  di T3 è stato visto, e T7 sa decidere.
- **L'epoca protegge il nuovo**: un visto per l'epoca 4 non spegne l'epoca 5 arrivata
  mentre la lista era aperta, e un `turnAt` vecchio non copre il turno dopo (NOTIF-ONE-01,
  «una notifica più nuova della lista letta»).
- **Chi lo chiama**: la soglia di visto della pane a fuoco (SEEN-ANY-FOCUS-01, definizione
  invariata), l'apertura di una voce dalla inbox, «Segna visto», «Segna tutte viste», il
  clic sulla riga di una chat tenuta da un'altra finestra, ⌘J sulla meta. Aprire la inbox
  NO (scelta 4).
- **Nato visto**: il frame `focus` porta `{ subject, awake }` (oggi solo `topicId`) e si
  manda a ogni cambio di pane a fuoco e di visibilità o fuoco della finestra; la chiusura
  della socket lo cancella. Quando un'epoca nasce, o un turno chiude in T3/T5, e una socket
  della persona ha quel soggetto a fuoco e sveglio, lo store mette subito `seen_at =
  lastTurn.at` e, se c'è, `seen_epoch = epoch`: niente numero, niente riga non vista,
  niente spinta. Il banner locale lo decide l'impostazione «notifica anche se a fuoco» (§10).
- **`needs-you` col visto** resta acceso: il visto toglie solo il primo banner ripetuto e
  il segno «nuovo» nella inbox.
- **Ottimismo**: la finestra che manda il visto lo applica subito nel suo store (è l'unico
  uso rimasto di `seenSubjects`); il frame del server conferma o corregge.
- **Telefono**: la PWA aperta riceve il frame e si spegne da sola. Con la PWA chiusa il
  service worker non sa niente del visto (`sw.js:169-242` non aggiorna il badge né ritira
  le notifiche consegnate), e una spinta silenziosa su iOS non è permessa: all'apertura e a
  ogni ritorno in primo piano la PWA, ricevuto `attention:init`, ritira con
  `registration.getNotifications()` le notifiche dei soggetti non più accesi e riscrive il
  badge. Ogni spinta porta nel payload il numero corrente e il service worker lo scrive con
  `setAppBadge`.

## 7. Avvio senza replay

- A ogni apertura della socket (prima e riconnessioni) il server manda `attention:init`
  con tutte le righe non `idle` e quelle `finished` non viste. Il client sostituisce lo
  store per intero: un `seen` perso durante il sonno non resta perso (F1). Non c'è una
  rotta `GET` gemella: la PWA che torna dallo sfondo riconnette la socket, e
  `attention:init` arriva comunque.
- I banner partono solo da `attention:updated` con `live: true` e
  `epoch > ultimaEpocaAnnunciata[subject]`; l'istantanea semina quella mappa e non
  annuncia mai. Un ricarico, una riconnessione o una finestra nuova non suonano.
- **Ogni avvio** (anche i ricarichi del watcher a ogni salvataggio sotto `server/`): lo
  store rilegge le righe (con `last_turn`, `seen_at`, `background`, `epoch_cause`),
  rilegge gli ingressi «riletti» di §2.2 (card dai `tasks`, archiviati e cancellati dai
  `topics`, terminali chiusi dal pane store, dispatch dal dispatcher, attese salvate di
  HOLD-04, turni riattaccati), manda `processEnded { cause: 'restart' }` ai soggetti senza
  processo vivo (§5.5), e ricompone tutto con `live: false`. Per §4.1 nessuna epoca nasce
  da questo: un `finished` non visto resta acceso con la sua epoca, una card in review resta
  ambra.
- **Primo avvio con la tabella vuota**: le righe non ci sono, quindi `last_turn` è vuoto
  per tutti. Si accende solo ciò che è vero adesso (attese, card, processi vivi); le chat
  finite prima del rilascio non si accendono.

## 8. Superfici

### 8.1 Il tier

| Tier | Tab e riga | Numero | Progetto / gruppo | Vista per stato |
|------|-----------|--------|-------------------|-----------------|
| `working` | spinner | no | conta come attivo, non acceso | «Al lavoro» |
| `background` | glifo grigio, niente fill | no | idem | «In background» |
| `needs-you` | fill ambra, `data-attention="needs-you"` | `max(1, unread)` | ambra se un figlio lo è | «Ti aspetta» |
| `done` (non visto) | fill blu, `data-attention="done"` | `max(1, unread)` | blu | «Finite» |
| `error` (non visto) | fill rosso, `data-attention="error"` | `max(1, unread)` | rosso se nessun ambra | «Finite» |
| visto / `idle` | niente | no | niente | nessuna sezione |

- Il numero su tab e riga c'è solo su un soggetto acceso. Una chat spenta con non-letti
  (un messaggio di sistema, un turno risvegliato in background, un edit) non ha numero:
  TAB-BADGE-01 e PARITY-01 si modificano di conseguenza.
- La tab attiva della pane a fuoco non mostra il numero (TAB-BADGE-07, invariato).
- Chat e terminali (con o senza hook) usano lo stesso `attentionOf`: TERM-1 e TERM-2
  spariscono perché non ci sono più due insiemi.
- **Dock, tray, PWA**: numero = soggetti accesi non archiviati. Lo calcola ogni finestra
  dallo stesso store, ma `set_app_status` lo accetta solo dalla finestra principale
  (`lib.rs` controlla l'etichetta della finestra chiamante); `navigator.setAppBadge` lo
  chiama solo la PWA, che ha una finestra. Se la principale è nascosta nella tray continua
  a calcolare e scrivere: il suo store riceve gli stessi frame. Il menu della tray elenca i
  soggetti che il numero conta: chat e terminali fino a otto righe, e le card nei gruppi
  della board che già mostra (`trayBoardAttention`).
- Spariscono: `chatFinishedTopics`, `terminalFinishedIds`, `claudeAttentionTopics`,
  `awaitingFeedbackTopics`/`awaitingInputTopics`/`claudePhaseAwaitingInputTermIds` come
  fonti di attenzione (anche per ⌘J), `backgroundWorkTopics` come fonte del glifo, gli
  `extraCounts` delle pane utility (`notifyPane` non ha chiamanti),
  `useUnseenNotificationsStore` come addendo del numero, `reconcileTerminalSignals` (la
  riconciliazione col roster la fa il server con `closed`). `seenSubjects` resta solo come
  ottimismo locale del visto.

### 8.2 Presenza e ordine delle righe

Oggi `notificationCount` tiene in sidebar una chat senza tab (`buildSidebarItems.ts:465-474`,
`:607-616`) e la fa salire in cima ordinando per `lastNotifiedAt` (`:729-743`): una chat
letta che conserva un non-letto o una fase `awaiting-user` resta su (F5).

- Una chat o un terminale senza tab SHALL restare in sidebar se è acceso, come oggi con
  `notificationCount > 0` (le altre eccezioni restano: fissata, aperta in un'altra
  finestra, sotto-agenti).
- L'ordine: prima gli accesi, fra loro per `since` decrescente (l'ingresso nello stato,
  cioè l'epoca più recente), poi per attività. Visto, il soggetto perde la spinta in cima
  e torna al suo posto per attività, su ogni finestra.

### 8.3 La board

`useBoardTabCounts` (`BoardTabCounts.tsx:53-90`) oggi conta solo le review da
`boardTasksStore`, con una cache in `localStorage`. Diventa: il numero della tab board e
della riga Board = `rollupAttention` dei soggetti `task:` del progetto (tutti i progetti
per la board generale), cioè review, parcheggio e attese a metà turno; l'anello delle card
in corso resta da `boardTasksStore`, perché non è attenzione. La cache del numero se ne va
(§11): `attention:init` arriva all'apertura della socket. I chip delle card restano fuori
da questa change; la parità di CHROME-COUNT-01 si misura quindi su righe di sidebar e
numero della tab board generale, non sulle card.

### 8.4 ⌘J e la porta del telefono

CHAT-WAIT-03 e CHAT-WAIT-04 (`spec chat`) leggono oggi `awaitingInputTopics`,
`claudePhaseAwaitingInputTermIds` e la sezione «Attende te» (`waitingQueue.ts:35-36, 85`),
e il numero della porta è `waitingCount` (`App.tsx:1359`). La coda si costruisce dalle
righe chat e terminale con `tier = needs-you` e motivo `question`, `permission` o `plan`,
nell'ordine della sezione «Ti aspetta». Le card (review, parcheggio) non sono righe della
sidebar e non entrano: le porta la inbox. Conseguenza voluta: il piano del runtime nativo
(`plan-approval.ts`) ora è `needs-you(plan)`, ambra, e diventa una meta. Il passo di ⌘J
sulla riga di un terminale manda il visto invece di `clearTerminalFinished`.
CHAT-WAIT-04 non cambia testo: legge la stessa coda.

## 9. La inbox (scelta 4)

### 9.1 Il tasto

Icona `Bell` di lucide nel piede della sidebar, dove sta oggi. Numero = soggetti accesi.
Pallino del numero ambra se almeno uno è `needs-you`, altrimenti neutro. `aria-label`:
«Da guardare: N, di cui M ti aspettano». Nessun numero quando è zero.

### 9.2 Il pannello

Popover di 380 px ancorato al tasto su desktop, foglio dal basso sotto i 768 px (stesso
guscio dei menu del composer). In alto «Da guardare» e due linguette: **Ora** e
**Cronologia**.

**Ora**, dall'alto:

1. **Ti aspettano** (ambra): i `needs-you`, dal più vecchio, perché chi aspetta da più
   tempo viene prima. Riga su due linee: icona per motivo (`MessageCircleQuestion`
   domanda, `ShieldAlert` permesso, `ClipboardCheck` piano, `GitPullRequest` review,
   `PauseCircle` parcheggio), nome della chat o della card, progetto, tempo; seconda linea
   il `detail` (la domanda, il tool e il comando, il motivo del parcheggio). Invio o tocco
   apre il soggetto nel punto: la chat sulla domanda, la card nel cassetto.
2. **Finite** (blu, rosso per gli errori): i `finished` non visti, dal più recente. Seconda
   linea: l'inizio dell'ultimo messaggio o l'errore, e «3 messaggi» se più di uno. Invio
   apre e segna visto. «Segna visto» a fine riga (al passaggio del mouse, sempre visibile
   al tocco come gesto di scorrimento a sinistra). In fondo alla sezione «Segna tutte
   viste», che manda esattamente le epoche e i `turnAt` elencati.
3. Una riga quieta, grigia, senza numero nel tasto: «2 in background · 1 al lavoro».
   Si apre sul posto con i nomi e il primo compito di ciascuno («Agent: verify render»).
   È la risposta a «cosa sta facendo?» senza farne un avviso.

Vuota: «Niente da guardare» e la riga quieta se c'è.

**Cronologia**: le ultime 100 righe di `notification_log`, raggruppate per giorno, in sola
lettura, con l'icona del tipo e «Sistema» per gli avvisi di infrastruttura (§10.4).
Nessun numero sulla linguetta. Le righe di un soggetto ancora acceso hanno il pallino.

Aprire il pannello non segna niente.

### 9.3 Tastiera e tocco

- Scorciatoia «Apri Da guardare» nel registro che esiste oggi, `shared/shortcuts.ts` (lo
  stesso di ⌘J), con `shortcuts_generated.rs` rigenerato; default ⇧⌘I se libera nel
  registro, altrimenti la prima libera fra ⇧⌘N e ⌥⌘I (task 4.6). Non dipende da
  `remappable-shortcuts` (0/20 task): quando quella change arriverà, la voce diventa
  rimappabile come le altre del registro.
- ↑/↓ muovono, Invio apre, `E` segna visto, ⇧`E` segna tutte viste, ←/→ cambiano
  linguetta, Esc chiude e rende il fuoco al tasto. Fuoco a rotazione nella lista, una sola
  tabulazione per entrare e una per uscire.
- Righe da 56 px (due linee), bersagli da 44 px, scorrimento a sinistra per «Segna visto»
  solo sulle `Finite`; nessun gesto distruttivo su «Ti aspettano».
- Sobria: due colori di stato più il rosso, icone lucide, nessuna emoji, nessuna
  animazione oltre la dissolvenza di 120 ms del popover; testo `text-sm`, seconda linea
  `text-xs` attenuata, una linea ciascuna con ellissi.

## 10. Banner e spinte (scelta 5)

### 10.1 Un punto di decisione

Sul server, nello store, a ogni epoca nuova con `live: true`:

1. Scrive la riga di cronologia (sempre, anche silenziata; nata vista se il soggetto è
   nato visto). È l'unico scrittore delle righe di attenzione: il client smette di
   POSTare righe per fine turno, attesa e terminale.
2. Calcola `announce = { title, body, tag: subject, actions }` con i testi e i tasti di
   PUSH-04 (che restano), salvo che il soggetto sia silenziato (MUTE-01, MUTE-03),
   archiviato o di un agente di board.
3. Lo mette nel frame `attention:updated` insieme a `bornSeen`.
4. **Spinta**: la manda ai dispositivi iscritti se `announce` c'è e `bornSeen` è falso.

Non disturbare NON è un cancello del server: lo stato di concentrazione lo sa solo il guscio
nativo e lo legge il client (`lib/shell/focus.ts:87-97`, QUIET-01), e nessun file del
server lo conosce. Resta dov'è, dentro `fire` del client, per i banner del Mac. La spinta
non lo guarda: va al telefono, che ha la sua concentrazione.

Il filtro «nessuna finestra desktop sveglia da 2 minuti» della prima stesura non c'è: costa
il tipo di client nel saluto e un orologio per un canale che su questa macchina ha 0
consegne su 382 (D3). Si aggiunge quando un telefono è iscritto e il doppione si vede.

`maybeSendPush` esce da `broadcastToAll`: niente più frame annusati, e le righe non
dipendono da una consegna.

### 10.2 Banner sul Mac

La finestra che riceve `announce` lo mostra se: non è `bornSeen`, oppure è `bornSeen` e
«notifica anche se a fuoco» è acceso; poi passa il cancello di Non disturbare (QUIET-01).
Il claim fra finestre è `claimMessageBanner` con la chiave `subject#epoch`: due finestre,
un banner. Vale anche per la finestra principale nascosta nella tray (`CloseRequested` →
`hide`, `lib.rs:11625-11630`): il suo store riceve i frame come le altre.

Si tolgono TRE rami di `useCompletionNotifier`: `session:state`, `stream:end`, e
`message:new`. L'ultimo oggi bussa per ogni messaggio dell'assistente con la finestra
nascosta (`decideMessageBanner`, `messageBanner.ts:81-113`), con una claim su `messageId`
(`messageBannerClaim.ts:158-166`, chiamata in `useCompletionNotifier.tsx:523`) e senza
nessun cancello sul background (`backgroundNotice` filtra solo la riga di servizio): con la
principale nella tray ogni turno risvegliato «1 di 3 arrivato» suonerebbe, e poi suonerebbe
l'annuncio `subject#epoch`. Senza quel ramo l'unico banner è l'annuncio.

### 10.3 Cosa annuncia

Solo gli ingressi in `needs-you` e in `finished`. Mai `working`, mai `background`, mai un
turno risvegliato con compiti ancora in volo, mai un messaggio dentro un turno, mai una
riconnessione, mai una ricomposizione all'avvio.

### 10.4 Avvisi di sistema

Swap-freeze (congelato e scongelato) e riavvio trattenuto scrivono una riga di cronologia
con `kind: 'system'`, soggetto `system:<chiave>`, senza `targetKind: 'topic'`, una per
ciclo (lo scongelamento aggiorna la riga del congelamento). Non hanno uno stato di
attenzione e non contano. Il GC dei worktree uguale. L'uccisione di un comando da parte
dello swap, invece, è una fine di processo (§5.5).

## 11. Dati

- Una migration solo schema, `<ts>-subject-attention.sql`, con il `CREATE TABLE` di §2.1
  e un indice su `state`. Nessun backfill: si parte vuoti (§7). Prima di creare il file
  si fa la copia di `data/topics.db` e `-wal`, perché il watcher la applica al DB vivo in
  pochi secondi (CLAUDE.md del repo).
- `notification_log` invariata: le righe vecchie diventano cronologia. `seen_at` resta per
  il pallino della cronologia.
- `unread` invariata nello schema.
- Il client non salva niente in `localStorage` per l'attenzione: via anche la cache dei
  numeri della tab board (`COUNTS_CACHE_PREFIX`); resta quella dell'anello.

## 12. Come si chiude ogni difetto

| Difetto | Meccanismo | Test |
|---------|------------|------|
| D1, bgwait-1 | `stream:end` porta `background` da `attentionBackground`; regola 7 prima di 8; T3 senza epoca; ramo `message:new` tolto | 1.1, 1.10, 2.4 |
| D2, A, bgwait-2 | `watching` con compiti che contano (§5.3); cron ricorrente escluso | 1.2 |
| bgwait-2 terminale | compiti per id; il Monitor scaduto esce | 1.2 |
| BG-1, BG-3, B1, bgwait-3 | le superfici e il glifo leggono solo `attentionOf` | 1.6, 3.3 |
| BG-2 | banner solo da `announce`, `message:new` tolto | 1.10, 3.5 |
| BG-4 | vista per stato da `tier` | 3.3 |
| D6 | `hold` dagli eventi del bridge; `PreToolUse` di `mcp__topics__ask_user_question` → `awaiting-approval` | 1.3 |
| D8 | il pannello del piano apre `hold(plan)` | 1.3 |
| D7 | `finalizeTurnActivity` con messaggio; T17 | 1.4 |
| D3 | riga scritta dallo store, nata vista se davanti; spinta separata | 1.5 |
| D4, F3 | `card` esce con la card; T15 | 1.7 |
| BOARD-1 | attesa a metà turno sulla card; tab board da `rollupAttention` (§8.3) | 1.3, 1.13, 5.6 |
| D5 | §10.4 | 2.8 |
| BELL-1, B2 | regola 8 col visto; numero = accesi | 1.6, 3.4 |
| F5 | stesso `attentionOf` per chat e terminali; presenza e ordine da `lit`/`since` (§8.2) | 1.6, 1.13, 3.3 |
| TERM-1, TERM-2 | stesso `attentionOf` per chat e terminali | 1.6, 3.3 |
| ARCH-1, B3/C | regola 1; T13 segna viste righe ed epoca | 1.8 |
| B4 | visto sul server, `attention:init` | 1.9, 5.2 |
| D (focus) | ramo `session:state` tolto; nato visto dal server | 3.5 |
| E | la porta annuncia sempre | 1.9 |
| F1 | istantanea a ogni apertura | 5.2 |
| F2 | regola 1 prima di ogni annuncio | 2.6 |
| WIN-1, F4 | un solo scrittore del Dock | 4.5 |

## 13. Rischi

- **Un compito che non torna mai** tiene il soggetto muto finché il processo vive. Il glifo
  grigio e la riga quieta della inbox lo mostrano; la fine del processo lo porta a
  `finished(error)` (§5.5). Non si mette una scadenza: sarebbe un avviso falso dopo ogni
  build lunga.
- **Una finestra che muore senza dire che non è più davanti** farebbe nascere visti i suoi
  soggetti. La chiusura della socket cancella il suo `focus`, e `awake` si manda a ogni
  `visibilitychange`.
- **La migration sul DB vivo**: copia prima, file solo schema.
- **Gli E2E di oggi iniettano i frame** (`page.routeWebSocket`, es.
  `tests/e2e/chat-finished-banner.spec.ts:99`): non vedono il server, ed è così che D3 è
  passato. I nuovi pilotano il server di test vero (rotta degli hook, provider finto).
- **Due versioni del client** durante il rilascio (la app desktop si aggiorna dopo il
  server): le porte vecchie restano alias per una release, i frame vecchi
  (`notification:*`, `unread:*`) continuano a partire finché il client nuovo non è
  l'unico.
- **Il telefono con la PWA chiusa** vede il visto solo alla prossima apertura (§6): una
  spinta silenziosa che lo spenga non esiste su iOS.

## Implementazione: dove il codice si scosta

Metà server (sezioni 1 e 2 di `tasks.md`). Ogni voce: cosa fa il codice, e perché.

- **Forma dei frame.** `attention:init { rows: AttentionSnapshot[] }` e
  `attention:updated { row, live, announce?, bornSeen? }` (tipi in `shared/attention.ts`,
  schemi in `shared/ws-outbound.ts`). `row` porta anche `unread`, `turnUnseen`,
  `lastTurnAt` e i compiti per id, così il client non legge altro. Finché il client
  nuovo non c'è, i due tipi stanno in `UNCONSUMED` di `ws-outbound-coverage.test.ts`.
- **Lo stato della card entra dal servizio dei task, non da ogni transizione.**
  `createTaskService` avvolge i metodi che possono muovere una card
  (`CARD_MOVING_METHODS` in `services/tasks.ts`) e dopo ognuno rilegge la riga e scrive
  `setCard`. Le scritture SQL dirette sono una ventina: avvolgere i metodi copre anche
  quelle future, e il test 1.7 lo prova senza broadcast. Conseguenza: l'`announce:
  false` di `releaseAndEmit` (N card parcheggiate da una causa sola) non vale più,
  ogni card ha la sua epoca e la sua spinta.
- **`maybeSendPush` è tolta, non lasciata come alias.** `push-triggers.ts` tiene le
  parole (`buildAnnouncement`, testi e tasti di PUSH-04/05 invariati), il significato
  della fine di un turno (`classifyTurnEnd`, gli stessi cancelli di
  `isCleanChatTurnEnd`) e `isTopicSilenced`. I 56 test di prima sono riscritti sul punto
  nuovo (58 ora): testi e tasti su `buildAnnouncement`, cancelli del turno su
  `classifyTurnEnd`, silenzio, archivio e «stessa attesa» sullo store.
- **Chiavi di dedup delle righe invariate** (`chat:<id>`, `chat-error:<id>`,
  `session:<id>:awaiting-approval`, `task-review:<id>`...), con `group_key` = soggetto:
  il client vecchio che posta ancora la sua riga di banner viene deduplicato. Costo: due
  epoche dello stesso soggetto entro 10 s scrivono una riga sola.
- **Le porte vecchie sono alias «visto adesso».** `POST /api/topics/:id/read` e
  `/api/notifications/seen` chiamano la porta nuova con l'epoca e l'ultimo turno
  correnti (`seenItemNow`); il «segna tutto» con `upTo` del client vecchio continua a
  segnare le righe come prima. La porta nuova sta dentro `notificationsRouter`
  (`routes/attention.ts`), per non aggiungere un router alla tabella delle rotte.
- **`applyHook` tiene `monitorArmed` come ripiego.** Il quarto argomento
  `{ countingTasks }` decide `watching` allo `Stop`; il tracker lo passa sempre (dallo
  store), un chiamante puro che non lo passa ricade sul flag di prima.
- **Un compito entra al `PreToolUse`** sotto l'id della chiamata (Bash e Agent con
  `run_in_background`, Monitor, Workflow) e viene ri-chiavato all'id della CLI al
  `PostToolUse`: un turno che chiude prima del `PostToolUse` aspetta già. Il CronCreate
  entra solo al `PostToolUse` (serve `recurring`).
- **Un cron non ricorrente di un terminale** esce con `CronDelete` o con la fine del
  processo: il transcript non dice quando scatta. In chat lo dice lo snapshot della CLI.
- **`run_command`** entra nella mappa della chat come un compito solo (`command`) letto
  a fine turno da `commandWakeState`, non uno per processo.
- **Terminali**: con hook il turno è `UserPromptSubmit`/`Stop` (e le righe del
  transcript per i turni che la CLI apre da sola); senza hook è `terminal:activity`
  (busy/finished) per i claude-code che non hanno mai mandato un hook. La chiusura è
  `retireTerminalSession` (tab chiusa, orfano spazzato) più il tombstone della pane nella
  cascata di ritiro (`services/retirement.ts`): non c'è un ingresso «closed» separato
  dal pane store.
- **Fine del processo di una chat**: il provider la dice con `observeProcessEnded`;
  il turno aperto lo chiude la rotta col suo errore (`turnClosedByRoute`), lo store
  conta solo i compiti in volo. Un `SessionEnd` è sempre trattato come chiesto dalla
  persona.
- **Avvio**: la ricomposizione parte dopo la riadozione dei turni sopravvissuti. Un
  processo è vivo se il provider ha ancora lavoro in background (chat) o se la riga di
  `terminal_sessions` non è `dormant` (terminali). Le attese dei bridge non si
  rileggono: dopo un riavvio le mappe sono vuote e l'attesa non esiste più (ATTN-01).
- **Una risposta rigenerata (`routes/edit.ts`) è un turno finito (T2)**: prima non
  spingeva niente; ora vale come ogni turno, e se la chat è davanti nasce vista.
- **Il `detail` della fine del processo** è scritto dal server in italiano
  («Il processo è finito con N compiti in volo»), come le altre righe di cronologia.
- **Avvisi di sistema**: nuovo genere `system` in `shared/notification-log.ts`; il
  disgelo riscrive la riga del congelamento (stessa chiave di ciclo) invece di
  aggiungerne una.
