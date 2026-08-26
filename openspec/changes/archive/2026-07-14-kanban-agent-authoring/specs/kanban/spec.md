## ADDED Requirements

### Requirement: KANBAN-03 — Authoring task da agente via MCP

Il sistema SHALL permettere a un agente, tramite MCP, di creare e aggiornare task sulla
board del **progetto legato alla sua sessione**, senza dover conoscere `project_id`. Le
mutazioni SHALL passare da un unico task-service ed essere riflesse live sulla board via
broadcast WebSocket. La creazione SHALL essere idempotente rispetto a un
`idempotency_key` opzionale. Un task creato da un agente SHALL entrare in `backlog`
(intake): solo un umano lo sposta in `todo`, che è ciò che lo rende eleggibile
all'auto-dispatch — simmetrico al gate `review → done` (KANBAN-05) e guardia
anti-ricorsione (un worker non può accodare lavoro che spawna altri worker).

#### Scenario: create_task crea sul progetto della sessione
- **GIVEN** una sessione agente legata al progetto P
- **WHEN** l'agente chiama `create_task` con un testo e nessun `project_id`
- **THEN** un nuovo task compare nella colonna `backlog` della board di P
- **AND** la board aperta si aggiorna senza refresh manuale

#### Scenario: create_task è idempotente
- **GIVEN** un `create_task` già andato a buon fine con `idempotency_key = K`
- **WHEN** l'agente ripete `create_task` con lo stesso `K` e stessi campi
- **THEN** nessun task duplicato viene creato
- **AND** viene restituito il task esistente

#### Scenario: update_task estende oltre lo stato
- **GIVEN** un task esistente
- **WHEN** l'agente chiama `update_task` con `priority`, `assignee`, `tags` o `dependencies`
- **THEN** il task riflette i nuovi campi sulla card e nel detail panel

### Requirement: KANBAN-04 — Discussione (thread commenti) via MCP

Il sistema SHALL esporre lettura e scrittura del thread di discussione di un task via MCP.
`get_task` SHALL restituire il task con i suoi commenti (ordine cronologico) e gli eventi
di ciclo-vita. `comment_task` SHALL aggiungere un commento. L'autore SHALL essere risolto
**dal server** dall'identità di sessione dell'agente e non dal parametro del tool.

I commenti degli agent SHALL essere brevi e utili: la superficie agent rifiuta commenti
oltre un cap (600 caratteri) con un errore che invita a sintetizzare — il thread è una
scia di stato per l'umano, non un log sink. La superficie umana non è cappata.

I commenti SHALL supportare **allegati** (stessa pipeline della chat nativa: upload
multipart → path assoluto, render via `/api/media` allowlist-gated): immagini inline,
altri file come chip; solo path assoluti, max 8 per commento; commento solo-allegato
legale. Un allegato umano su un task in review SHALL raggiungere l'agent al resume
(path su disco nel messaggio, l'agent li legge direttamente); anche l'agent può
allegare file prodotti (`comment_task media[]`).

#### Scenario: allegato che guida l'agent
- **GIVEN** un task agent-driven in review
- **WHEN** l'umano commenta allegando un'immagine (file o incolla)
- **THEN** l'immagine appare inline nel thread e l'agent riparte con testo + path del file
- **AND** l'agent può leggere il file da disco

Una richiesta di decisione umana SHALL essere strutturata: `comment_task` accetta
`options[]` e il **server** compone il blocco ```question``` canonico (fence e newline
garantiti) — il modello non riproduce mai la sintassi markdown a mano. La board SHALL
mostrare sulla card in review l'ultimo commento SEMPRE (domanda con bottoni-opzione se
question block, testo altrimenti): mai un Approva/Rifiuta alla cieca.

#### Scenario: commento agent troppo lungo → rifiutato con guida
- **GIVEN** una sessione agente
- **WHEN** l'agente chiama `comment_task` con un contenuto oltre il cap
- **THEN** la richiesta è rifiutata (`comment_too_long`) con un messaggio che chiede
  1-2 frasi di sintesi

#### Scenario: domanda strutturata → quick-reply sulla card
- **GIVEN** un task agent-driven
- **WHEN** l'agente chiama `comment_task(content=<domanda>, options=[A, B])` e poi
  `update_task(status='review')`
- **THEN** la card in review mostra la domanda e un bottone per opzione
- **AND** il click dell'umano ri-kicka lo stesso agent con la scelta

#### Scenario: get_task restituisce il thread
- **GIVEN** un task con commenti
- **WHEN** l'agente chiama `get_task`
- **THEN** riceve il testo del task, la lista dei commenti e gli eventi di stato

#### Scenario: comment_task firma l'agente
- **GIVEN** una sessione agente A
- **WHEN** l'agente chiama `comment_task` su un task
- **THEN** il commento appare nel detail panel con `author` = identità di A (≠ `user`)

#### Scenario: l'autore non è spoofabile dal client
- **GIVEN** un `comment_task` che passa un `author` arbitrario nei parametri
- **WHEN** il commento viene salvato
- **THEN** l'`author` persistito è quello risolto dal server, non quello passato

### Requirement: KANBAN-05 — Gate di consegna umano (Review → Done)

Un agente SHALL NOT poter portare un task a `done`. Il completamento da parte di un agente
SHALL spostare il task in `review` e registrare un'approvazione pendente. La transizione
`review → done` SHALL essere consentita solo a un attore umano. Un rifiuto SHALL riportare
il task a `in_progress` e registrare un commento.

Una consegna SHALL NOT essere muta: un agente non può portare un task in `review` se il
thread non contiene almeno un suo commento (autore ≠ `user`/`system`) — la card in review
mostra sempre l'ultima parola dell'agent (KANBAN-04) e senza commenti l'umano deciderebbe
alla cieca. Il rifiuto (`review_needs_summary`, 409) SHALL istruire l'agent a postare una
sintesi di 1-2 frasi e riprovare. Unica eccezione al gate `done`: gli **step propri**
(KANBAN-08), che l'agent chiude direttamente.

#### Scenario: la consegna muta è rifiutata
- **GIVEN** un task lavorato da un agent senza alcun suo commento nel thread
- **WHEN** l'agent chiama `update_task(status='review')`
- **THEN** l'operazione è rifiutata (`review_needs_summary`) con istruzioni per la sintesi
- **AND** dopo `comment_task(<sintesi>)` la stessa transizione riesce

#### Scenario: l'agente consegna in Review, non in Done
- **GIVEN** un task `in_progress` lavorato da un agente
- **WHEN** l'agente chiama `update_task` con `status = done`
- **THEN** l'operazione è rifiutata
- **AND** l'agente può invece portarlo a `review`, creando un'approvazione pendente

#### Scenario: solo l'umano chiude
- **GIVEN** un task in `review` con approvazione pendente
- **WHEN** l'umano approva dalla approval modal
- **THEN** il task passa a `done` con `reviewed_by` valorizzato
- **AND** lo stesso passaggio richiesto da un agente resta rifiutato

#### Scenario: reject rimanda in lavorazione
- **GIVEN** un task in `review`
- **WHEN** l'umano rifiuta con un commento
- **THEN** il task torna in `in_progress` e il commento è visibile nel thread

### Requirement: KANBAN-06 — Feed globale multiprogetto via MCP

`list_tasks` SHALL accettare `scope: project | all`. Con `scope = all` il sistema SHALL
restituire un feed piatto dei task di tutti i progetti, ciascuno etichettato con il proprio
progetto, paginato a cursore. `scope = project` (default) SHALL limitare al progetto della
sessione.

#### Scenario: scope all attraversa i progetti
- **GIVEN** task in due progetti diversi
- **WHEN** l'agente chiama `list_tasks` con `scope = all`
- **THEN** riceve task di entrambi i progetti, ognuno con l'etichetta del progetto

#### Scenario: scope project è il default
- **GIVEN** una sessione legata al progetto P
- **WHEN** l'agente chiama `list_tasks` senza `scope`
- **THEN** riceve solo i task di P

### Requirement: KANBAN-07 — Auto-dispatch reattivo (opt-in)

L'interruttore di avvio (`auto_dispatch`) SHALL essere **globale** — un solo switch per
tutte le board (riga riservata `board_settings.project_id='*'`), esposto come toggle
nell'header di ogni board **inclusa la board generale** (il click sul pill È il toggle;
`GET/PATCH /api/all-boards/settings`, broadcast `board:dispatch` a ogni client). Quando
è attivo, un task che entra in `todo` (trascinato O creato direttamente lì da un umano)
SHALL innescare, dopo una finestra di grazia anti drag-through, il claim atomico del
task e l'avvio di un agent headless dedicato in una chat tab detached, isolato in un
git worktree quando `dispatch_use_worktree` è attivo. Cap di concorrenza, effort,
worktree e timeout restano **per board**. Il numero di agent concorrenti per board
SHALL essere limitato da `max_agents`; i tentativi per task da un retry-cap. L'agent
lavora fino a `review` (mai `done`, KANBAN-05). Con il flag disattivo (default) nessuno
spawn SHALL avvenire e nessun chip di dispatch SHALL comparire. La guardia
anti-ricorsione è strutturale: gli agent creano solo in `backlog` (KANBAN-03), quindi
il lavoro accodato da un worker non è mai auto-eleggibile.

Feedback SHALL essere sempre visibile sulla card: `queued → starting → working →
needs_input | delivered` via `dispatch_state`, e ogni interruzione (worktree impossibile,
progetto non risolvibile, turno morto, retry esauriti) SHALL parcheggiare il task con il
motivo in `dispatch_error` E un commento nel thread — mai un fallimento silenzioso solo
nei log. In review i due esiti sono distinti: `needs_input` ("serve te") quando l'ultima
parola dell'agent è un question block (risposta richiesta), `delivered` ("consegnato")
quando la consegna è pulita e attende solo l'approvazione.

Un turno che termina senza raggiungere `review` con il task ancora `in_progress` e il
topic ancora legato (tipicamente il timeout wall-clock che taglia un agent al lavoro)
SHALL **continuare sulla stessa sessione**: bump del tentativo (stesso retry-cap),
commento di sistema nel thread, e resume dello stesso topic/worktree con un nudge di
continuazione ("riprendi da dove eri, non ricominciare") — MAI un release+re-claim che
scarta la conversazione e fa ripartire l'agent da zero. Il parcheggio in `backlog`
avviene solo a cap esaurito. Il topic dell'agent SHALL nascere **background**
(archiviato = chiuso nel modello 2-stati): visibile in sidebar, MAI una tab che si
apre da sola su ogni client; la tab si apre solo dal bottone del task (che de-archivia)
e chiuderla non ferma la sessione.

Ogni task SHALL poter portare un **override di modello** (`tasks.model`, NULL = auto =
default del provider) scelto dal composer; il dispatcher lo copia sul topic alla
creazione insieme all'effort per-board.

Un input umano (risposta, reject) che arriva mentre il turno dell'agent sta ancora
terminando SHALL essere bufferizzato e consegnato sullo **stesso tab** al turn-end —
mai scartato (il task resterebbe orfano e il requeue spawnerebbe un agent nuovo senza
il contesto della conversazione). Rinominare task o step SHALL essere sempre sicuro:
il loop è id-based (kickoff, tool MCP e resume referenziano gli id, mai i titoli).

L'umano SHALL poter **fermare** un dispatch in corso (stop): il task è parcheggiato
(backlog + motivo nel thread) PRIMA del taglio del turno, così il turn-end trova il
task già spostato e NON ri-accoda un nuovo tentativo. Un task creato con
**plan_first** SHALL istruire l'agent a consegnare un piano sintetico in review
(question block "Approva il piano"/"Da rivedere") PRIMA di implementare; l'agent
implementa solo al resume con l'approvazione.

#### Scenario: stop umano di un dispatch in corso
- **GIVEN** un task con un agent al lavoro (chip working)
- **WHEN** l'umano preme Ferma
- **THEN** il task va in backlog con "Fermato da te" nel thread, il turno è abortito
- **AND** nessun nuovo tentativo parte da solo

#### Scenario: plan first
- **GIVEN** un task creato con plan_first
- **WHEN** l'agent parte
- **THEN** consegna un piano in review con quick-reply (senza implementare nulla)
- **AND** implementa solo dopo l'approvazione del piano

#### Scenario: task in todo parte da solo (flag on)
- **GIVEN** una board con `auto_dispatch` attivo
- **WHEN** un task entra in `todo` e vi resta oltre la finestra di grazia
- **THEN** il task è claimato (`in_progress`, chip `working`) e un agent lavora in una
  tab dedicata raggiungibile dalla card ("apri tab")
- **AND** alla consegna il task è in `review` con chip `serve te`

#### Scenario: nessun dispatch con flag off
- **GIVEN** l'interruttore globale `auto_dispatch` disattivo (default)
- **WHEN** un task viene creato o trascinato in `todo` su qualsiasi board
- **THEN** nessun agente viene spawnato automaticamente
- **AND** l'header della board mostra che l'auto-dispatch è spento

#### Scenario: il toggle è globale
- **GIVEN** l'interruttore spento e due board aperte (una di progetto e la generale)
- **WHEN** l'umano clicca il pill "agent: off" su una qualsiasi delle due
- **THEN** l'interruttore si accende per TUTTE le board e ogni header aperto si aggiorna
  (broadcast, non refresh)

#### Scenario: drag-through non spawna
- **GIVEN** una board con `auto_dispatch` attivo
- **WHEN** un task attraversa `todo` e ne esce prima della finestra di grazia
- **THEN** nessun claim avviene e il chip `in coda` viene rimosso

#### Scenario: interruzione visibile, mai silenziosa
- **GIVEN** una board con `auto_dispatch` attivo il cui progetto non è risolvibile o il
  cui worktree non può essere creato
- **WHEN** un task tenta il dispatch
- **THEN** il task è parcheggiato in `backlog` con il motivo in `dispatch_error` e nel
  thread commenti

#### Scenario: timeout a metà lavoro = continuazione, non restart
- **GIVEN** un task `in_progress` il cui turno viene tagliato dal timeout wall-clock
- **WHEN** il turn-end trova il task ancora in_progress col topic legato
- **THEN** il tentativo è incrementato e l'agent riprende SULLA STESSA sessione
  (stesso topic, stesso worktree) con un nudge di continuazione
- **AND** il thread mostra "l'agent continua sulla stessa sessione (tentativo n/cap)"
- **AND** solo a cap esaurito il task è parcheggiato in backlog

#### Scenario: la sessione agent non apre tab da sola
- **GIVEN** un dispatch che crea il topic dell'agent
- **WHEN** il topic nasce
- **THEN** nasce archiviato (background): nessuna tab spunta nella tabbar di alcun client
- **AND** il bottone "apri tab" del task lo de-archivia e apre la tab on demand

### Requirement: KANBAN-10 — Dipendenze fra task (bloccato da)

Un task SHALL poter dichiarare un blocco (`blocked_by_task_id`, gestibile manualmente
dal drawer e alla creazione): finché il blocker non è `done` (o archiviato), il task in
`todo` ASPETTA — il claim CAS lo rifiuta, il tick lo salta, nessun chip `in coda`
strandato; la card mostra "in attesa di: <blocker>". Self-block e cicli SHALL essere
rifiutati. Quando il blocker raggiunge `done` (PATCH umano o approve di review), i
dipendenti in `todo` SHALL essere rilanciati subito (stesso trattamento dell'ingresso
in todo). Opt-in per task (`reuse_blocker_context`): al dispatch il dipendente SHALL
riusare la **conversazione dell'agent del blocker** (stesso topic, stessa cwd del
topic, niente topic/worktree freschi) — il contesto costruito dal blocker è spesso
esattamente ciò che serve al dipendente.

#### Scenario: un task bloccato aspetta il blocker
- **GIVEN** task B bloccato da task A (aperto), entrambi con auto-dispatch attivo
- **WHEN** B entra in `todo`
- **THEN** B resta in todo senza claim né chip, con l'indicazione "in attesa di: A"

#### Scenario: il done del blocker sblocca i dipendenti
- **GIVEN** B in `todo` bloccato da A
- **WHEN** A raggiunge `done` (drag umano o approve della review)
- **THEN** B viene dispatchato senza attese ulteriori

#### Scenario: riuso del contesto del blocker
- **GIVEN** B bloccato da A con `reuse_blocker_context` attivo, e A consegnato dal suo agent
- **WHEN** B viene dispatchato
- **THEN** l'agent di B riparte nel TOPIC di A (stessa conversazione) con il kickoff di B
- **AND** nessun topic né worktree nuovi vengono creati

### Requirement: KANBAN-08 — Task annidati (subtask a cascata)

Un task SHALL poter contenere sottotask a profondità illimitata (`parent_task_id`
self-referential, FK). Il parent SHALL essere impostato solo alla creazione (niente
re-parenting), rendendo i cicli impossibili per costruzione. Il parent SHALL vivere sulla
stessa board del figlio. Un task con sottotask aperti SHALL NOT poter passare a `done`
(qualsiasi attore, update o approvazione). L'archiviazione di un parent SHALL archiviare
ricorsivamente l'intero sottoalbero. I sottotask NON SHALL comparire come card sulle
colonne (né board di progetto né board generale: il feed è root-only) — vivono
nell'albero del dettaglio del padre e nel contatore di card (`↳ fatti/totali`); il
detail SHALL mostrare i sottotask come **albero** (espansione lazy, profondità
illimitata) con quick-add e navigazione padre↔figlio. Il dispatcher NON SHALL mai
claimare uno step come task indipendente (un sottotask in `todo` non accoda niente e
non mostra chip): il lavoro di uno step appartiene all'agent del suo root.

I sottotask del task assegnato a un agent sono la sua **checklist di step**: l'agent
dispatched SHALL crearli come piano visibile e SHALL poterli marcare `done` lui stesso
— unico carve-out al gate KANBAN-05, ristretto ai **discendenti stretti** del task
legato al suo topic (`assigned_topic_id`). Il deliverable (il task assegnato) resta
dietro il gate umano; il gate `open_subtasks` sull'approve garantisce che alla consegna
tutti gli step risultino smarcati.

Ogni sottotask ha il **proprio thread** di discussione (agent e umano possono
commentare lo step specifico). Un commento umano su un task il cui root di dispatch
(il più vicino antenato — o il task stesso — con `assigned_topic_id`) è in `review`
SHALL ri-kickare lo stesso agent con il testo e il riferimento allo step — stessa
semantica della risposta sul task principale: la risposta specifica non è mai un
commento passivo mentre il chip dice "serve te".

#### Scenario: gli step non sono card
- **GIVEN** un task con sottotask
- **WHEN** l'umano guarda le colonne (progetto o board generale)
- **THEN** vede solo il task root col contatore `↳ n/m`; gli step compaiono solo
  nell'albero del dettaglio
- **AND** uno step trascinato in `todo` non avvia nessun agent e non mostra chip

#### Scenario: sottotask annidati a più livelli
- **GIVEN** un task A
- **WHEN** viene creato B con parent A, e C con parent B
- **THEN** `get_task(A)` elenca B e `get_task(B)` elenca C

#### Scenario: il parent non si chiude con figli aperti
- **GIVEN** un task con un sottotask non-done
- **WHEN** qualcuno tenta `done` (update o approve)
- **THEN** l'operazione è rifiutata (`open_subtasks`) finché i figli non sono completati
  o archiviati

#### Scenario: archive a cascata
- **GIVEN** un albero A → B → C
- **WHEN** A viene archiviato
- **THEN** B e C risultano archiviati

#### Scenario: l'agente spezza un task grande
- **GIVEN** un agent che lavora il task T
- **WHEN** chiama `create_task(text=..., parent_task_id=T)`
- **THEN** il sottotask nasce in `backlog` sotto T (l'umano decide se e quando mandarlo
  in lavorazione)

#### Scenario: l'agente smarca i propri step
- **GIVEN** il task T assegnato all'agent A (topic bound) con step S figlio di T
- **WHEN** A chiama `update_task(task_id=S, status='done')`
- **THEN** S passa a `done` (carve-out: S è un discendente stretto di T)
- **AND** lo stesso update su T stesso resta rifiutato (`agent_cannot_complete`)

#### Scenario: il carve-out non attraversa i task altrui
- **GIVEN** un task U non discendente del task assegnato all'agent A
- **WHEN** A tenta `update_task(task_id=U, status='done')`
- **THEN** l'operazione è rifiutata (`agent_cannot_complete`)

#### Scenario: rispondere sul thread di uno step ri-kicka l'agent
- **GIVEN** il task T assegnato all'agent A, in `review`, con step S figlio di T
- **WHEN** l'umano commenta sul thread di S
- **THEN** T torna `in_progress` e A riparte con il testo e il riferimento a S
- **AND** lo stesso commento con T già `in_progress` resta una nota nel thread di S

#### Scenario: aggiungere uno step a un task in review È l'assegnazione
- **GIVEN** il task T assegnato all'agent A, in `review`
- **WHEN** l'umano crea un sottotask sotto T (o sotto un suo step)
- **THEN** T torna `in_progress` e A riparte con il riferimento al nuovo step —
  nessun commento "fai anche X" richiesto
- **AND** con T in lavorazione il nuovo step atterra nell'albero e il resume prompt
  istruisce A a rileggere il task (get_task) prima di riprendere

### Requirement: KANBAN-09 — Superficie di review del task (output + albero + thread)

Il dettaglio task SHALL essere un drawer laterale di default (la board resta visibile)
espandibile in una superficie di review a due colonne: a sinistra meta, albero dei
sottotask e thread; a destra l'**output** del task. Un task SHALL poter portare un
`output_url` (solo http/https — mai file:/javascript:), impostabile dall'agent via
`update_task(output_url=...)` o dall'umano, renderizzato in un iframe sandboxed nel
pannello di review; senza output il pannello SHALL offrire il deep-link alla tab
dell'agent. Il thread commenti SHALL essere renderizzato come chat (messaggi dell'umano
a destra, agent/system a sinistra con autore e ora) — minimale: niente avatar né
reazioni. Le azioni di review (Approva/Rifiuta) SHALL essere disponibili anche dal
dettaglio, con la stessa semantica della card (reject con testo = resume dello stesso
agent).

#### Scenario: l'agent allega un output reviewabile
- **GIVEN** un agent che ha un dev server o una pagina da mostrare
- **WHEN** chiama `update_task(task_id=T, output_url="http://localhost:5173")` e consegna in review
- **THEN** il pannello di review del task mostra quella URL in un iframe
- **AND** una URL non-http(s) è rifiutata (`invalid_input`)

#### Scenario: drawer di default, review espansa a scelta
- **GIVEN** un task aperto dal board
- **WHEN** l'umano non ha espanso il dettaglio
- **THEN** il dettaglio è un drawer a destra e la board resta visibile
- **AND** l'espansione (persistente per client) mostra albero+thread a sinistra e output a destra

L'intestazione del dettaglio SHALL mostrare il progetto del task come **selettore**:
l'indice delle board risolvibili dal server (stessa UNION di path del dispatcher,
`GET /api/all-boards/projects`) per spostare il task su un'altra board — l'intero
sottoalbero viaggia insieme; un sottotask SHALL NOT spostarsi da solo e un task con un
agent vivo SHALL restare fermo (motivo visibile). In coda al selettore: **Apri
progetto** (apre/foca la finestra del progetto) e **Nuovo progetto…** (scaffold nel
workspace — dir + CLAUDE.md, 409 su collisione — poi sposta il task lì). Titolo e
descrizione SHALL essere editabili inline dal dettaglio senza layout shift.

#### Scenario: spostare un task su un'altra board
- **GIVEN** un task con sottotask sulla board A
- **WHEN** l'umano sceglie la board B dal selettore del progetto
- **THEN** task e sottoalbero compaiono sulla board B (root in coda) e spariscono da A
- **AND** entrambe le board si aggiornano live

#### Scenario: lo spostamento è guardato
- **GIVEN** un sottotask, o un task con agent attivo
- **WHEN** l'umano tenta lo spostamento
- **THEN** l'operazione è rifiutata con il motivo (si sposta il root / prima chiudi il giro)

La board SHALL offrire un **composer flottante** in basso: pill compatta,
visibilmente staccata dal bordo inferiore, che a fuoco sale ed espande con transizione
(mai tagliata), con toggle plan-first, progetto implicito dalla board (nella vista
cross-project il selettore è lo STESSO componente Menu del dettaglio task — lista
board + "Nuovo progetto…" — non un `<select>` nativo) e nessuna scelta di modello
(automatico). Il task nasce in Todo (segnale di dispatch); titolo = prima riga,
descrizione = il resto del testo (il titolo non si ripete attaccato sotto sé stesso
nel dettaglio) — è l'agent stesso, al primo turno, a rifinire titolo e descrizione
(`update_task(text, description)`). Il thread del dettaglio SHALL
mostrare un indicatore animato mentre l'agent lavora, con lo stop accanto. La
sessione dell'agent SHALL comparire **a fette fra i commenti**: sopra ogni
risposta, un blocco "Ragionamento" collassato con la SOLA porzione di sessione
fra il commento precedente e quello (read-only, stesso renderer markdown della
chat); la coda dopo l'ultimo commento è la fetta "in corso". Il deep-link alla
tab attiva dell'agent vive nell'header del dettaglio, e chiudere quella tab
NON SHALL fermare la sessione (il turno appartiene al dispatcher: si
interrompe solo con lo stop esplicito o per timeout del provider).

Il thread SHALL essere anche lo **storico dello stato**: ogni transizione
(update umano o agent, claim del dispatcher, release, decisione di review)
scrive un evento `kind='status'` ("from→to", autore = chi l'ha spostato) reso
come riga di timeline fra i commenti — mai come bolla, e mai conteggiato come
"ultima parola dell'agent" (gate `review_needs_summary` e chip
delivered/needs_input filtrano su `kind='comment'`). Lo stato SHALL essere
modificabile anche dall'header del dettaglio (selettore con i 5 stati, stesse
guardie server del drag). Il pannello di output in modalità wide SHALL
comparire SOLO quando `output_url` esiste — mai un riquadro vuoto.

Il task SHALL esporre l'**effort dell'agent**: tempo di lavoro cumulato
(wall-clock dei turni, registrato dal dispatcher) e token consumati (delta
per turno dalle usage del transcript della sessione, best-effort) — visibili
su card e dettaglio; mentre un turno gira, il dettaglio mostra il tempo che
ci sta mettendo in tempo reale E un'**anteprima live** della coda dell'ultimo
ragionamento/output in streaming (il colpo d'occhio "come sta andando" senza
aprire nulla; il pezzo completo vive nella fetta "Ragionamento in corso").

Il drag & drop SHALL posizionare, non solo spostare: rilasciare una card su
un'altra la inserisce in quel punto (riordino nella colonna e posizione
d'arrivo cross-colonna, persistiti via `kanban_order` frazionario — un solo
PATCH, niente rinumerazioni); i refetch live SHALL essere sospesi durante il
drag e applicati al rilascio (niente colonne che saltano sotto il puntatore).

#### Scenario: composer flottante → agent
- **GIVEN** una board con auto-dispatch attivo
- **WHEN** l'umano descrive un task nel composer e invia
- **THEN** il task nasce in Todo con titolo derivato dalla prima riga e parte l'agent
- **AND** l'agent rifinisce titolo/descrizione sul primo turno

#### Scenario: ragionamento a fette fra i commenti
- **GIVEN** un task con agent assegnato e più risposte nel thread
- **WHEN** l'umano espande il blocco "Ragionamento" sopra una risposta
- **THEN** appare SOLO la porzione di sessione fra il commento precedente e quella
  risposta (read-only, si aggiorna live col thread)
- **AND** la coda di sessione dopo l'ultimo commento appare come fetta "in corso"

#### Scenario: lo storico dello stato vive nel thread
- **GIVEN** un task passato da todo → in_progress (dispatcher) → review (agent) → done (umano)
- **WHEN** l'umano apre il dettaglio
- **THEN** il thread mostra, in ordine, le righe di transizione con autore e ora
- **AND** le righe di stato non compaiono mai come "ultimo commento" sulla card review

#### Scenario: stato modificabile dal dettaglio aperto
- **GIVEN** il dettaglio di un task aperto
- **WHEN** l'umano sceglie un altro stato dal selettore nell'header
- **THEN** il task si sposta (stesse guardie del drag: open_subtasks su done, ecc.)
- **AND** la transizione appare nel thread come evento

#### Scenario: niente pannello output vuoto
- **GIVEN** un task SENZA output_url in modalità wide
- **WHEN** l'umano guarda il dettaglio
- **THEN** nessun riquadro/iframe di output è visibile (la colonna sinistra occupa tutto)

#### Scenario: effort visibile
- **GIVEN** un task lavorato da un agent per più turni
- **WHEN** l'umano guarda card o dettaglio
- **THEN** vede tempo cumulato e token (es. "⏱ 7m · 12.3k tok"), aggiornati a ogni fine turno
- **AND** mentre l'agent lavora il dettaglio mostra il tempo corrente che scorre

#### Scenario: il drop posiziona la card
- **GIVEN** una colonna con più card
- **WHEN** l'umano trascina una card sopra un'altra (stessa colonna o un'altra)
- **THEN** la card atterra in QUEL punto e l'ordine sopravvive al refetch (kanban_order persistito)
- **AND** durante il drag la board non salta (refetch sospesi fino al rilascio)

#### Scenario: la tab dell'agent si apre dall'header e si chiude senza danni
- **GIVEN** un task con agent al lavoro
- **WHEN** l'umano apre la tab della sessione dall'header del dettaglio e poi la chiude
- **THEN** il turno dell'agent prosegue (nessun abort) e il task resta in lavorazione
- **AND** riaprire la tab dal dettaglio mostra la stessa sessione
