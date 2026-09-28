# Chat — il lavoro in background di un turno chiuso si vede

Estende il lifecycle già specificato in `openspec/specs/chat/spec.md`
(«A background agent's line opens no turn»), che dice cosa il server fa di quel
lavoro ma non come lo si vede.

## ADDED Requirements

### Requirement: BGVIS-01 — Una chat in background ha un glifo suo, diverso da «risponde» e da «aspetta te»

Quando una chat non ha un turno aperto ma il suo ultimo turno ha lasciato lavoro
in background (riga `state:"background"` di `/api/topics/streaming`), la riga di
sidebar, la sua tab e, a cartella chiusa, il roll-up del progetto SHALL mostrare
il glifo `background`: lo stesso anello di `OrbitLoader`
(`client/src/components/Layout/StreamingIndicator.tsx:94`), arco **grigio**
(`text-app-text-tertiary`) che gira **lento**, reso da `LoaderSlot` con
`data-loader-state="background"`.

È un terzo stato e non va confuso con gli altri due: l'anello blu che gira dice
«sta rispondendo, l'invio si accoda», l'ambra ferma dice «tocca a te». Qui
nessuna delle due è vera: la chat è libera e il lavoro gira da sé.

Precedenza, sulla stessa riga o sullo stesso progetto: `waiting` (ambra) >
`working` (blu) > `background` (grigio). Con `prefers-reduced-motion` l'arco
SHALL stare fermo, come `.animate-orbit-spin` (`client/src/index.css:2900`).

Il tooltip SHALL dire quanti lavori e che la chat è libera (chiavi i18n it/en).
`ProjectElapsed` (`Sidebar/TopicTree.tsx:1295`) NON SHALL contare il lavoro in
background: misura il turno più vecchio in corso, e questo non è un turno.

Dove cambiarla: scelta 1 del blocco «Da decidere». Con «no» il glifo diventa lo
stesso `working` blu, e cade lo scenario «non si confonde».

#### Scenario: la riga di sidebar di una chat in background
- **GIVEN** `/api/topics/streaming` che risponde una sola riga
  `{topicId: T, state: "background", tasks: [2 task]}`
- **WHEN** la sidebar mostra la chat T
- **THEN** la riga di T contiene `[data-loader-state="background"]`
- **AND** non contiene `[data-loader-state="working"]` né `[data-loader-state="waiting"]`

#### Scenario: la tab e il progetto chiuso dicono lo stesso
- **GIVEN** la chat T in background, aperta in una tab, dentro il progetto P
- **WHEN** la cartella di P è chiusa in sidebar
- **THEN** la tab di T e la riga di P mostrano `[data-loader-state="background"]`

#### Scenario: un turno vero vince sul background
- **GIVEN** il progetto P con la chat T in background e la chat U che sta rispondendo
- **WHEN** la cartella di P è chiusa
- **THEN** la riga di P mostra `[data-loader-state="working"]`

### Requirement: BGVIS-02 — Il background non entra negli insiemi di streaming

Il lavoro in background SHALL essere uno stato **a parte** nello store dei
segnali (`client/src/state/signals.ts`). La risposta del poll
(`client/src/state/useSignalsSync.ts:110-139`) SHALL scrivere, nello stesso
giro, `backgroundWorkSessions` (per sessione, letto dal composer, invariato) e
il lavoro per topic `{sessionKey, tasks, lastSignalAt}` letto dai glifi, dalla
riga in chat e dagli agenti attivi. `dropBackgroundWork(sessionKey)`
(`signals.ts:627`) SHALL svuotare entrambi.

Una chat in background NON SHALL entrare in `liveStreamTopics` né in
`hydratedStreamTopics`, e `useTopicLoading` (`signals.ts:1041`) SHALL restare
falso per lei. Altrimenti `reconcileServerStreams` e il composer la
tratterebbero come un turno in volo: invio bloccato o accodato, e una
riapertura fantasma del turno.

#### Scenario: l'invio resta libero
- **GIVEN** la chat T in background, composer con del testo
- **WHEN** si preme invio
- **THEN** il messaggio parte come in una chat a riposo (`decideComposerAction`
  → `send`, `client/src/components/Chat/composerAction.ts:78`), non si accoda

#### Scenario: lo Stop spegne tutto subito
- **GIVEN** la chat T in background, composer vuoto
- **WHEN** si preme lo Stop del composer e la route risponde `ok`
- **THEN** glifo, riga in chat e riga fra gli agenti attivi spariscono senza
  aspettare il poll successivo

### Requirement: BGVIS-03 — Le chat in background contano fra gli agenti attivi

`activeAgentRowsFrom` (`client/src/state/signals.ts:1313`) SHALL restituire,
oltre a `working`, `awaitingInput` e `finished`, un gruppo `background`: una riga
per chat (mai per task), solo per le chat a schermo (`visibleTopicSignalIds`),
mai anche in `working`. `Sidebar/AgentLines.tsx` SHALL mostrarlo sotto
un'intestazione propria («In background»), righe con
`data-testid="background-agent-row"`.

Il numero sul pulsante del menu (`Sidebar/IdentityBlock.tsx:189`) e la coda
della riga «Agenti attivi» SHALL contare `working + background`, calcolati da
una sola funzione sulle stesse righe, così numero ed elenco non possono
divergere (STATUSLINE-05).

Dove cambiarla: scelta 2 del blocco «Da decidere». Con «no» il gruppo resta
nell'elenco ma il numero torna `working.length`, come per `awaitingInput` e
`finished`.

#### Scenario: una chat in background è un agente attivo
- **GIVEN** la chat T con la sessione S in background, nessun turno aperto
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `background` contiene una riga `{id: T, kind: "topic"}`
- **AND** `working` non contiene T
- **AND** il numero sul pulsante del menu vale 1

#### Scenario: una chat archiviata non conta
- **GIVEN** la chat T in background ma archiviata
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `background` è vuoto

### Requirement: BGVIS-04 — In chat una riga dice chi si sta aspettando

Il server SHALL aggiungere alla riga `background` di `/api/topics/streaming` i
campi `tasks: {type, description}[]` e `lastSignalAt`, letti da `pp.background`
(`server/providers/claude/background-work.ts:59-70`) con una sonda nuova del
provider accanto a `backgroundState` (`server/providers/claude-code.ts:2786`) e
riportati da `backgroundStatusRows` (`server/providers/background-probes.ts:95`,
tipo `StreamingStatusRow`). Una `description` vuota SHALL ripiegare su `type`,
come fa già `claude-code.ts:2902`. La sonda SHALL riportare i task solo quando
`backgroundState` vale `running` (`hasLiveTasks`,
`server/providers/claude/background-work.ts:172`), e `[]` in `wake-queued`: una
lista oltre `BACKGROUND_WORK_CAP_MS` è già data per persa dal server e non va
mostrata come lavoro in corso. Un cron di sessione armato entro lo stesso tetto
(card 8b53d9d1) SHALL comparire fra i `tasks` come `{type: "cron", description:
"<schedule> (cron)"}`, e `lastSignalAt` non SHALL mai precedere l'armo: senza,
una chat che aspetta solo il suo cron mostrerebbe «sta per riprendere» per due
ore. Nessuna scrittura: DB, processo e orologi non cambiano.

La chat SHALL mostrare, sopra il composer accanto a `SubAgentsStrip`
(`client/src/components/Chat/ChatPane.tsx:1848`), una riga
`data-testid="background-work-line"`: «In attesa di N lavori in background:»
seguita dai nomi, troncati. Con `tasks` vuoto (stato `wake-queued`, il task ha
risposto e la CLI sta per riprendere) la riga SHALL dire che la chat sta per
riprendere. Oltre `WORK_STALE_AFTER_MS` (`client/src/state/workLongevity.ts:22`,
10 min) da `lastSignalAt` la riga SHALL aggiungere da quanto non arrivano
notizie, con lo stesso trattamento «stale» di `LabeledLoader`.

La riga NON SHALL portare un secondo Stop: lo Stop è già quello del composer a
campo vuoto (`composerAction.ts:79`), e due comandi per la stessa cosa si
leggono come due cose diverse.

#### Scenario: la riga elenca i task
- **GIVEN** `/api/topics/streaming` intercettato con `page.route`, una riga
  `background` per la chat T con i task «Verifica build» e «Monitor deploy»
- **WHEN** si apre T
- **THEN** `[data-testid="background-work-line"]` è visibile e contiene entrambi i nomi

#### Scenario: la riga sparisce quando il lavoro finisce
- **GIVEN** la chat T con la riga visibile
- **WHEN** il poll successivo non riporta più T
- **THEN** la riga sparisce, e anche il glifo `background`

#### Scenario: il server porta i task
- **GIVEN** un provider finto registrato che riporta la sessione S in background
  con due task, uno senza `description`
- **WHEN** si chiama `backgroundStatusRows`
- **THEN** la riga di S ha `tasks` di lunghezza 2, e il task senza descrizione
  porta il suo `type` come nome
- **AND** ha `lastSignalAt` numerico
