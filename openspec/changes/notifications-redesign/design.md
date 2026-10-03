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
la card del gruppo legge i terminali finiti che la tab ignora. Nessuno legge il lavoro in
background, tranne i glifi grigi.

Ogni difetto della proposta è una di queste somme che non torna. Rattoppare le somme una
per una è quello che è stato fatto da agosto (CHAT-DONE-01, NOTIF-ONE-01/02,
SEEN-ANY-FOCUS-01/02, SEEN-01/02 sono tutte correzioni di superficie): la cura è avere una
somma sola, fatta dove stanno i fatti.

## 2. Una sorgente: lo stato di attenzione

### 2.1 Dove vive

Sul server, in `server/attention/`:

- `compose.ts`: funzione pura `composeAttention(inputs) → { state, reason, outcome }`.
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
  detail       TEXT,               -- una riga: la domanda, il tool, il motivo del parcheggio, l'errore
  since        TEXT NOT NULL,      -- ingresso nello stato
  epoch        INTEGER NOT NULL,   -- cresce a ogni ingresso in uno stato acceso
  seen_epoch   INTEGER NOT NULL,   -- l'ultima epoca vista
  background   TEXT,               -- JSON: i compiti in volo, per id (§5)
  updated_at   TEXT NOT NULL
)
```

Acceso (`lit`) = `state = 'needs-you'`, oppure `state = 'finished'` e `seen_epoch < epoch`.

### 2.2 Chi la scrive

Solo `store.applyInputs(subject, patch)`. Gli ingressi di un soggetto stanno in memoria
accanto alla riga (`AttentionInputs`):

| Ingresso | Scritto da (wire.ts) |
|----------|----------------------|
| `turnOpen` | `stream:start` / `stream:end` della rotta chat; `UserPromptSubmit` / `Stop` per i terminali; `terminal:activity` busy per i terminali senza hook |
| `hold` (`question`/`permission`/`plan`, testo, da quando) | eventi di `human-hold-events.ts` (ask bridge, permission bridge); `PreToolUse` di `AskUserQuestion` e `ExitPlanMode`; il pannello del piano della rotta chat (`chat.ts:2144-2162`); la fase `awaiting-approval` e `paused` |
| `background` (compiti per id) | §5 |
| `lastTurn` (`done`/`error`, `messageId`, quando) | `stream:end` con un messaggio visibile; `Stop` dei terminali; `terminal:activity` finished per i terminali senza hook |
| `card` (`review`/`parked`/null) | `releaseAndEmit` e le transizioni di `services/tasks.ts` |
| `archived`, `deleted`, `dispatched` | rotte dei topic, `archive-topic.ts`, dispatcher |

Dopo ogni patch lo store ricompone; se `(state, reason, outcome)` cambia scrive la riga e
trasmette. Nessun altro file scrive `subject_attention`, e un test lo verifica con
`git grep` (task 2.9).

### 2.3 Come ogni superficie ne deriva

Il client ha uno store (`client/src/state/attention.ts`) riempito solo da
`attention:init` e `attention:updated`, e due selettori puri. Per i topic i due frame
portano anche il non-letto, così il numero sulla riga viene dallo stesso frame dello
stato:

- `attentionOf(subject) → { tier, lit, count }`: `tier` ∈ `needs-you | error | done |
  background | working | null`; `count` = `max(1, unread)` se acceso, altrimenti 0.
- `rollupAttention(subjects) → { tier, count }`: il tier più alto fra i figli accesi
  (`needs-you` > `error` > `done`), `count` = figli accesi.

| Superficie | Legge |
|------------|-------|
| Tab di pane, riga della sidebar (chat e terminale) | `attentionOf` |
| Riga e tab di progetto, card del gruppo | `rollupAttention` dei figli |
| Vista per stato della sidebar | `tier`: «Ti aspetta», «Finite», «In background», «Al lavoro» |
| Menu agenti | `background` e `working` per gli attivi, `done`/`error` accesi per i finiti |
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

`composeAttention` applica le regole in quest'ordine; vince la prima:

1. `archived` o `deleted` → `idle`.
2. `dispatched` (topic di un agente di board) → `idle`: il soggetto è la card.
3. `hold` aperto → `needs-you(hold.kind)`. `paused` (permesso scaduto) resta `permission`.
4. `card = review` → `needs-you(review)`; `card = parked` → `needs-you(parked)`.
5. `turnOpen` → `working`.
6. `lastTurn.outcome = error` e non visto → `finished(error)`. Un errore vince sul
   background: il turno è andato storto e il lavoro rimasto non lo ripara.
7. `background` non vuoto → `background`.
8. `lastTurn.outcome = done` e non visto → `finished(done)`.
9. altrimenti `idle`.

La regola 8 dopo la 7 è la scelta 2: lo stesso «ha finito» che il lavoro in background
teneva sotto riemerge quando l'ultimo compito torna, con un'epoca nuova, una volta sola.

Con l'alternativa della scelta 1 la riga 8 diventerebbe «`lastTurn = done` finché non
arriva un turno nuovo, visto o no», e `NOTIF-ONE-02` terrebbe lo scenario 4.
Con l'alternativa della scelta 2 la regola 8 richiederebbe anche che il turno precedente
non abbia avuto background.

## 4. Transizioni

L'epoca cresce quando lo stato entra in uno stato acceso da uno spento, o quando cambia
`reason`/`outcome` restando acceso (una domanda dopo un permesso è una cosa nuova).
Ogni epoca nuova scrive UNA riga di cronologia e passa per la decisione di §10.

| # | Da | Evento | A | Effetto |
|---|----|--------|---|---------|
| T1 | qualunque spento | `stream:start`, `UserPromptSubmit`, terminale busy | `working` | — |
| T2 | `working` | fine turno con messaggio, niente in background | `finished(done)` | epoca+1 |
| T3 | `working` | fine turno con compiti in volo | `background` | nessun avviso; non-letti +1 se c'è un messaggio |
| T4 | `background` | turno risvegliato | `working` | — |
| T5 | `background` | turno risvegliato chiuso, compiti ancora in volo | `background` | nessun avviso |
| T6 | `background` | l'ultimo compito torna e il turno che lo porta chiude | `finished(done)` | epoca+1 |
| T7 | `background` | l'ultimo compito torna e nessun turno si apre entro 5 s | `finished(done)` se l'ultimo turno non è stato visto, altrimenti `idle` | epoca+1 se acceso |
| T8 | `working` | si apre un'attesa (domanda MCP, AskUserQuestion, permesso, piano) | `needs-you` | epoca+1 |
| T9 | `needs-you` | risposta data, attesa chiusa | `working` | — |
| T10 | `working` | turno in errore | `finished(error)` | epoca+1 |
| T11 | `finished` | visto (§6) | `finished` con `seen_epoch = epoch` | spento ovunque |
| T12 | `working` | stop della persona, watchdog | `idle` | nessun avviso |
| T13 | qualunque | archiviazione, cancellazione | `idle` | righe del soggetto viste |
| T14 | card qualunque | entra in `review` o è parcheggiata | `needs-you(review|parked)` | epoca+1 |
| T15 | `needs-you(review|parked)` | la card esce da review, viene rimessa in coda, cancellata, archiviata | stato composto senza `card` | — |
| T16 | `working`/`background` | riavvio del server senza processo vivo | `idle` | nessun avviso |
| T17 | `working` | turno risvegliato scartato (vuoto) | lo stato di prima | niente: né non-letti né epoca |

Il «finito» di un terminale senza hook è T2 con `terminal:activity` finished come fine
turno; il terminale con hook è T2 con `Stop`.

## 5. Il lavoro in background (scelta 2)

### 5.1 I compiti, per id

`background` è una mappa `taskId → { kind, label, startedAt }`. Un compito entra e esce
per id; non c'è un booleano.

| Tipo | Entra | Esce |
|------|-------|------|
| Bash con `run_in_background` | `PostToolUse` con l'id in `tool_response` | `<task-notification>` con quell'id nel transcript |
| Agent con `run_in_background` | idem | idem |
| Workflow (sempre in background) | `PostToolUse` («Task ID: …») | idem |
| Monitor | `PreToolUse`/`PostToolUse` Monitor | consegna dell'ultimo evento o fine del Monitor nel transcript (anche la scadenza) |
| CronCreate non ricorrente | `PostToolUse` | il suo primo scatto, o CronDelete |
| `run_command` di Topics | registro dei processi | uscita del processo |

Un CronCreate ricorrente non è un'attesa: è un calendario, e lo terrebbe in background per
sempre. Non entra.

### 5.2 Chat e terminali

- **Chat** (CLI headless): la verità è lo snapshot `background_tasks_changed` che la CLI
  stampa prima del `result` e che il provider tiene in `BackgroundWork`
  (`providers/claude/background-work.ts`), più `commandWakeState`. `backgroundOfTurn` si
  calcola PRIMA di `stream:end` e il frame porta
  `background: { count, kinds }`. Lo stato `wake-queued` conta come in volo: la CLI si sta
  già svegliando. Gli hook delle chat aggiornano la fase ma non la mappa dei compiti, per
  non avere due fonti.
- **Terminali** (CLI interattiva): solo hook e transcript, tabella sopra. La mappa si salva
  nella colonna `background` a ogni cambio, così il watcher che ricarica il server non la
  perde (oggi `monitorArmed` muore a ogni ricarico).
- **Fine del processo**: `SessionEnd`, uscita del PTY o del figlio CLI svuotano la mappa.
  Un compito che non torna più tiene il soggetto in `background` finché il processo vive,
  ed è visibile dal glifo grigio: nessuna scadenza a tempo, perché una build di due ore è
  legittima.
- **Riavvio del server**: le mappe delle chat ripartono vuote (il provider le riscrive al
  primo snapshot); quelle dei terminali si rileggono dalla tabella se la sessione del
  bridge PTY è viva, altrimenti si svuotano (T16).

### 5.3 La fase

`applyHook` mette `watching` allo `Stop` quando la mappa del soggetto non è vuota, non solo
con un Monitor armato; `noteWatchDelivered` toglie l'id consegnato invece di un booleano.
`watching` resta una fase attiva per il client (MONITOR-04). La fase serve ancora alle
superfici che la mostrano (es. l'etichetta «sta guardando»); l'attenzione non la legge per
decidere se accendere.

### 5.4 Non-letti

`finalizeTurnActivity` alza il non-letto solo se il turno ha lasciato un messaggio visibile
(non con `discardedMessageId`). Un turno risvegliato con un messaggio («1 di 3 arrivato»)
lo alza anche in `background`: il numero non si vede finché il soggetto non si accende, e
quando si accende dice quanti messaggi ci sono da leggere.

## 6. Il visto (scelta 3)

- **Di chi**: della persona che possiede l'installazione. Le socket degli ospiti non lo
  scrivono e non ricevono i frame (`lib/grants.ts`, come oggi per `notification:*`).
- **Una porta**: `POST /api/attention/seen { items: [{ subject, epoch }] }`. Per ogni voce:
  `seen_epoch = max(seen_epoch, min(epoch, epoca corrente))`; per un topic azzera i
  non-letti (la stessa funzione di `markTopicSeen`); segna viste le righe di cronologia del
  soggetto fino a quell'epoca; trasmette `attention:updated` SEMPRE, anche se non ha
  cambiato righe (difetto E). `POST /api/topics/:id/read` e `/api/notifications/seen`
  restano come alias della stessa porta finché il client vecchio esiste, poi si tolgono.
- **L'epoca protegge il nuovo**: un visto per l'epoca 4 non spegne l'epoca 5 arrivata
  mentre la lista era aperta (NOTIF-ONE-01, «una notifica più nuova della lista letta»).
- **Chi lo chiama**: la soglia di visto della pane a fuoco (SEEN-ANY-FOCUS-01, definizione
  invariata), l'apertura di una voce dalla inbox, «Segna visto», «Segna tutte viste», il
  clic sulla riga di una chat tenuta da un'altra finestra. Aprire la inbox NO (scelta 4).
- **Nato visto**: il frame `focus` porta `{ subject, awake }` (oggi solo `topicId`) e si
  manda a ogni cambio di pane a fuoco e di visibilità o fuoco della finestra; la chiusura
  della socket lo cancella. Quando un'epoca nasce e una socket della persona ha quel
  soggetto a fuoco e sveglio, lo store mette subito `seen_epoch = epoch`: niente numero,
  niente riga non vista, niente spinta. Il banner locale lo decide l'impostazione
  «notifica anche se a fuoco» (§10).
- **`needs-you` col visto** resta acceso: il visto toglie solo il primo banner ripetuto e
  il segno «nuovo» nella inbox.
- **Ottimismo**: la finestra che manda il visto lo applica subito nel suo store; il frame
  del server conferma o corregge.

## 7. Avvio senza replay

- A ogni apertura della socket (prima e riconnessioni) il server manda `attention:init`
  con tutte le righe non `idle` e quelle `finished` non viste. Il client sostituisce lo
  store per intero: un `seen` perso durante il sonno non resta perso (F1).
- `GET /api/attention` dà la stessa istantanea per chi non ha la socket (la PWA al ritorno
  dallo sfondo prima di riconnettersi).
- I banner partono solo da `attention:updated` con `live: true` e
  `epoch > ultimaEpocaAnnunciata[subject]`; l'istantanea semina quella mappa e non
  annuncia mai. Un ricarico, una riconnessione o una finestra nuova non suonano.
- **Primo avvio con la tabella vuota**: il server compone ogni soggetto dagli ingressi che
  ha (attese salvate per HOLD-04, card in review e parcheggiate, processi vivi) con
  `live: false`. Le chat finite prima del rilascio non si accendono: si accende solo ciò
  che è vero adesso.

## 8. Superfici

| Tier | Tab e riga | Numero | Progetto / gruppo | Vista per stato |
|------|-----------|--------|-------------------|-----------------|
| `working` | spinner | no | conta come attivo, non acceso | «Al lavoro» |
| `background` | glifo grigio, niente fill | no | idem | «In background» |
| `needs-you` | fill ambra, `data-attention="needs-you"` | `max(1, unread)` | ambra se un figlio lo è | «Ti aspetta» |
| `done` (non visto) | fill blu, `data-attention="done"` | `max(1, unread)` | blu | «Finite» |
| `error` (non visto) | fill rosso, `data-attention="error"` | `max(1, unread)` | rosso se nessun ambra | «Finite» |
| visto / `idle` | niente | no | niente | nessuna sezione |

- La tab attiva della pane a fuoco non mostra il numero (TAB-BADGE-07, invariato).
- Chat e terminali (con o senza hook) usano lo stesso `attentionOf`: TERM-1 e TERM-2
  spariscono perché non ci sono più due insiemi.
- **Dock, tray, PWA**: numero = soggetti accesi non archiviati. Lo calcola ogni finestra
  dallo stesso store, ma `set_app_status` lo accetta solo dalla finestra principale
  (`lib.rs` controlla l'etichetta della finestra chiamante); `navigator.setAppBadge` lo
  chiama solo la PWA, che ha una finestra. Se la principale è nascosta continua a
  calcolare e scrivere: il suo store riceve gli stessi frame.
- Spariscono: `chatFinishedTopics`, `terminalFinishedIds`, `claudeAttentionTopics`,
  `awaitingFeedbackTopics`/`awaitingInputTopics` come fonti di attenzione, gli
  `extraCounts` delle pane utility (`notifyPane` non ha chiamanti),
  `useUnseenNotificationsStore` come addendo del numero. `seenSubjects` resta solo come
  ottimismo locale del visto.

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
   viste», che manda esattamente le epoche elencate.
3. Una riga quieta, grigia, senza numero nel tasto: «2 in background · 1 al lavoro».
   Si apre sul posto con i nomi e il primo compito di ciascuno («Agent: verify render»).
   È la risposta a «cosa sta facendo?» senza farne un avviso.

Vuota: «Niente da guardare» e la riga quieta se c'è.

**Cronologia**: le ultime 100 righe di `notification_log`, raggruppate per giorno, in sola
lettura, con l'icona del tipo e «Sistema» per gli avvisi di infrastruttura (§10.4).
Nessun numero sulla linguetta. Le righe di un soggetto ancora acceso hanno il pallino.

Aprire il pannello non segna niente.

### 9.3 Tastiera e tocco

- Scorciatoia rimappabile «Apri Da guardare», default ⇧⌘I se libera (verificata in task
  4.6 contro la mappa di `remappable-shortcuts`), che apre il pannello col fuoco sulla
  prima riga.
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
   archiviato, di un agente di board, o che Non disturbare sia acceso (QUIET-01).
3. Lo mette nel frame `attention:updated` insieme a `bornSeen`.
4. **Spinta**: la manda ai dispositivi iscritti solo se `announce` c'è, `bornSeen` è falso
   e nessuna socket della persona da un guscio desktop è stata sveglia negli ultimi 2
   minuti. Il guscio desktop si riconosce dal frame di saluto, che dice il tipo di client.

`maybeSendPush` esce da `broadcastToAll`: niente più frame annusati, e le righe non
dipendono da una consegna.

### 10.2 Banner sul Mac

La finestra che riceve `announce` lo mostra se: non è `bornSeen`, oppure è `bornSeen` e
«notifica anche se a fuoco» è acceso. Il claim fra finestre è `claimMessageBanner` con la
chiave `subject#epoch`: due finestre, un banner. Il ramo `session:state` e il ramo
`stream:end` di `useCompletionNotifier` si tolgono; restano `message:new` per una finestra
nascosta (che già fa claim sulla stessa chiave) e nient'altro.

### 10.3 Cosa annuncia

Solo gli ingressi in `needs-you` e in `finished`. Mai `working`, mai `background`, mai un
turno risvegliato con compiti ancora in volo, mai una riconnessione.

### 10.4 Avvisi di sistema

Swap-freeze (congelato e scongelato) e riavvio trattenuto scrivono una riga di cronologia
con `kind: 'system'`, soggetto `system:<chiave>`, senza `targetKind: 'topic'`, una per
ciclo (lo scongelamento aggiorna la riga del congelamento). Non hanno uno stato di
attenzione e non contano. Il GC dei worktree uguale.

## 11. Dati

- Una migration solo schema, `<ts>-subject-attention.sql`, con il `CREATE TABLE` di §2.1
  e un indice su `state`. Nessun backfill: si parte vuoti (§7). Prima di creare il file
  si fa la copia di `data/topics.db` e `-wal`, perché il watcher la applica al DB vivo in
  pochi secondi (CLAUDE.md del repo).
- `notification_log` invariata: le righe vecchie diventano cronologia. `seen_at` resta per
  il pallino della cronologia.
- `unread` invariata nello schema.
- Il client non salva niente in `localStorage` per l'attenzione.

## 12. Come si chiude ogni difetto

| Difetto | Meccanismo | Test |
|---------|------------|------|
| D1, bgwait-1 | `stream:end` porta `background`; regola 7 prima di 8; T3 senza epoca | 1.1, 2.4 |
| D2, A, bgwait-2 | `watching` con mappa non vuota (§5.3) | 1.2 |
| bgwait-2 terminale | compiti per id; il Monitor scaduto esce | 1.2 |
| BG-1, BG-3, B1, bgwait-3 | le superfici leggono solo `attentionOf` | 1.6, 3.3 |
| BG-2 | banner solo da `announce` | 1.6, 3.5 |
| BG-4 | vista per stato da `tier` | 3.3 |
| D6 | `hold` dagli eventi del bridge; `PreToolUse` di `mcp__topics__ask_user_question` → `awaiting-approval` | 1.3 |
| D8 | il pannello del piano apre `hold(plan)` | 1.3 |
| D7 | `finalizeTurnActivity` con messaggio; T17 | 1.4 |
| D3 | riga scritta dallo store, nata vista se davanti; spinta separata | 1.5 |
| D4, F3 | `card` esce con la card; T15 | 1.7 |
| D5 | §10.4 | 2.8 |
| BELL-1, B2, F5 | regola 8 col visto; numero = accesi | 1.6, 3.4 |
| TERM-1, TERM-2 | stesso `attentionOf` per chat e terminali | 1.6, 3.3 |
| ARCH-1, B3/C | regola 1; T13 segna viste le righe | 1.8 |
| B4 | visto sul server, `attention:init` | 1.9, 5.2 |
| D (focus) | ramo `session:state` tolto; nato visto dal server | 3.5 |
| E | la porta annuncia sempre | 1.9 |
| F1 | istantanea a ogni apertura | 5.2 |
| F2 | regola 1 prima di ogni annuncio | 2.6 |
| WIN-1, F4 | un solo scrittore del Dock | 4.5 |

## 13. Rischi

- **Un compito che non torna mai** tiene il soggetto muto. Il glifo grigio e la riga
  quieta della inbox lo mostrano; la fine del processo lo svuota. Non si mette una
  scadenza: sarebbe un avviso falso dopo ogni build lunga.
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
