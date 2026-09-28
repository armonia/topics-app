# Chat: diramare in una nuova chat

Aggiunge il ramo che vive in una chat SUA, con gli strumenti, accanto ai rami
nella stessa chat di CHAT-03 e CHAT-CONV-01, che restano invariati. Modifica
CODEX-02 per il primo turno di un ramo Codex.

## ADDED Requirements

### Requirement: CHAT-FORK-01 — Diramare crea una chat NUOVA con la stessa storia, e l'originale non cambia

`POST /api/topics/:id/fork` (`server/routes/fork.ts`, nuovo) SHALL creare, in
UNA transazione:

- un topic nuovo, con un `sessionKey` suo, che eredita dall'originale
  `provider`, `model`, `effort`, `autonomyLevel`, `fastMode`, `topicsRouting`,
  `projectPath`, `worktreeId`, `systemPrompt`, `contextFiles`,
  `disabledContextSources`, `color` e `icon`. NON SHALL ereditare
  `pinnedMessages`, `mcpPolicy`, `muted`, `browserState`, `initialMessage` né
  l'obiettivo. Il nome è `name` del corpo, o `«<nome> (ramo)»` se manca;
- la copia del RAMO ATTIVO dell'originale (`loadActiveThread(sk, { withBlocks: true })`,
  `server/utils.ts:1300`) dalla radice al punto del ramo compreso, con id nuovi,
  `parentId` rimappati sulla riga copiata precedente e `branchIndex` 0, e per
  ogni riga contenuto, blocchi, strumenti, allegati, pensiero, autore, orari e
  consumo. Le righe `partial` NON SHALL essere copiate;
- una riga in `chat_forks` con la madre, il suo nome, l'ultima riga copiata e
  il modo del runtime (CHAT-FORK-03).

Il punto del ramo SHALL essere l'ultima risposta `assistant` finita del ramo
attivo.

Le righe dell'originale NON SHALL cambiare: né i messaggi, né
`active_branches`, né la riga della sua sessione presso il fornitore.

La rotta SHALL rifiutare, PRIMA di scrivere qualunque cosa:

- topic inesistente: 404;
- coordinatore globale (`isGlobalOrchestratorSession`): 403
  `orchestrator_topic_invariant`, come `server/routes/edit.ts:248-253`;
- turno in corso sull'originale (`isStreaming`): 409 `turn_in_progress`;
- runtime senza strada (CHAT-FORK-03 dice `null`): 409 `fork_unsupported`;
- nessuna risposta finita nel ramo attivo: 400 `nothing_to_fork`.

Riuscita: 201 col topic proiettato (con `forkedFrom`, CHAT-FORK-05) e il
broadcast `topic:created`.

Dove cambiarla: scelta 1 (il punto del ramo), scelta 3 (`projectPath` e
`worktreeId`: con il «no» il ramo riceve una worktree nuova dal ramo git della
madre), scelta 4 (il 409 `turn_in_progress`).

#### Scenario: stessa storia, e l'originale resta com'era
- **GIVEN** un topic con 3 turni (6 righe) nel ramo attivo e una risposta alternativa non attiva sotto il secondo prompt
- **WHEN** si chiama `POST /api/topics/:id/fork`
- **THEN** la risposta è 201 e `GET /api/history/<sessionKey del ramo>` dà 6 righe con gli stessi ruoli e contenuti, nello stesso ordine, e nessun id in comune con l'originale
- **AND** `GET /api/history/<sessionKey dell'originale>` dà le stesse righe, con gli stessi id, di prima della chiamata

#### Scenario: il ramo eredita come lavora, non cosa ricorda la pagina
- **GIVEN** un topic con modello, effort, autonomia, progetto e worktree scelti, un messaggio fissato e `mcpPolicy` `bridge-only`
- **WHEN** lo si dirama
- **THEN** il topic nuovo ha lo stesso modello, effort, autonomia, `projectPath` e `worktreeId`
- **AND** ha `pinnedMessages` vuoto e `mcpPolicy` nullo

#### Scenario: una riga a metà non si copia
- **GIVEN** un ramo attivo che finisce con una risposta finita seguita da una riga `partial` rimasta da uno stream perso
- **WHEN** lo si dirama
- **THEN** la copia finisce alla risposta finita, e la riga `partial` non c'è

#### Scenario: durante un turno non si dirama
- **GIVEN** un topic con un turno in corso
- **WHEN** si chiama la rotta
- **THEN** la risposta è 409 con `code: "turn_in_progress"`
- **AND** il numero di topic e le righe dell'originale non cambiano

#### Scenario: il coordinatore non si dirama
- **GIVEN** la chat del coordinatore globale
- **WHEN** si chiama la rotta
- **THEN** la risposta è 403 con `code: "orchestrator_topic_invariant"`

### Requirement: CHAT-FORK-02 — La sessione Claude Code del ramo nasce da quella della madre, fissata al punto del ramo

Per un ramo con runtime `claude-cli`, alla creazione la rotta SHALL leggere
l'id di sessione della madre (`claude_code_sessions`) e il suo transcript
(`claudeTranscriptPath`, `server/lib/claude-transcript-path.ts:83`), prendere
come `parent_at` l'`uuid` dell'ultima riga `type: "assistant"` non
`isSidechain`, coniare l'uuid del ramo e scrivere
`claude_code_sessions(sessionKey del ramo, uuid del ramo)` con `import_offset`
nullo. Se la madre non ha sessione, o il transcript non c'è, o non contiene una
risposta, `parent_ref` SHALL restare nullo: il ramo parte fresco e il suo primo
messaggio porta il riepilogo del database (CCLI-06), cioè la storia copiata.

Allo spawn (`server/providers/claude-code.ts:2427-2512`), con `parent_ref`
presente e il transcript DEL RAMO assente, l'argv SHALL finire con
`--resume <madre> --resume-session-at <parent_at> --fork-session --session-id <ramo>`
(`buildClaudeArgs`, `server/providers/claude/args.ts:374`), SENZA il prologo
di riepilogo (`needsHistoryReplay` falso, `claude-code.ts:2570`): la memoria
arriva dalla CLI, e il riepilogo la duplicherebbe. Con il transcript del ramo
presente l'argv SHALL finire con `--resume <ramo>` e SENZA `--fork-session`:
rifare il fork su un id che esiste è un errore della CLI (misurato il 28/09,
«Session ID … is already in use.», exit 1).

Se l'avvio del ramo è rifiutato perché la sessione madre non c'è più (i motivi
di `SESSION_NOT_FOUND_PATTERNS`, `claude-code.ts:616`) o perché la CLI non
conosce `--fork-session` o `--resume-session-at`, il recupero
(`markMissingSessionRecovery`, `claude-code.ts:3318`) SHALL azzerare
`parent_ref` e `parent_at` del ramo oltre a dimenticarne la sessione. Il turno
SHALL ripartire fresco col riepilogo, UNA volta, senza riprovare il fork.

Le due bandiere SHALL stare in `CRITICAL_CLAUDE_FLAGS`
(`server/providers/claude/cli-compat.ts:80`) e nello snapshot dell'argv
(CCLI-07).

#### Scenario: il primo avvio del ramo dirama
- **GIVEN** un ramo con `parent_ref` = P, `parent_at` = U, uuid del ramo C, e nessun transcript per C
- **WHEN** si monta l'argv del suo spawn
- **THEN** l'argv contiene, in quest'ordine, `--resume P --resume-session-at U --fork-session --session-id C`
- **AND** il primo messaggio NON porta il prologo di riepilogo

#### Scenario: dal secondo avvio è una chat qualunque
- **GIVEN** lo stesso ramo, con il transcript di C ormai su disco
- **WHEN** si monta l'argv di un nuovo spawn
- **THEN** l'argv finisce con `--resume C`
- **AND** non contiene `--fork-session` né `--resume-session-at`

#### Scenario: la madre non aveva una sessione
- **GIVEN** un topic Claude Code con messaggi e nessuna riga in `claude_code_sessions` (per esempio una storia seminata)
- **WHEN** lo si dirama e si manda il primo messaggio nel ramo
- **THEN** lo spawn del ramo usa `--session-id` senza `--fork-session`
- **AND** il primo messaggio porta il riepilogo della storia copiata

#### Scenario: la madre è sparita fra il clic e il primo messaggio
- **GIVEN** un ramo con `parent_ref` valorizzato, e il transcript della madre cancellato
- **WHEN** il primo spawn del ramo viene rifiutato con «No conversation found with session id»
- **THEN** `parent_ref` del ramo diventa nullo
- **AND** lo spawn successivo usa `--session-id` col riepilogo, e non contiene `--fork-session`

#### Scenario: sul filo l'originale non cambia
- **GIVEN** una chat Claude Code vera con due turni, e lo `shasum` del suo transcript
- **WHEN** la si dirama e si fa un turno nel ramo
- **THEN** lo `shasum` del transcript della madre è lo stesso
- **AND** il ramo risponde su un fatto detto solo nella madre

### Requirement: CHAT-FORK-03 — Ogni runtime ha la sua strada, e chi non ce l'ha non offre la voce

Una funzione pura `forkModeFor(providerName)` in `shared/chat-fork.ts` SHALL
essere l'unica tabella, letta dal server e dal client:

- `claude-code` e `claude-code-team` → `claude-cli` (CHAT-FORK-02);
- `codex` → `codex-cli` (CODEX-02);
- `topics` (anche il vecchio `topics:<modello>`), `claude`, `openai` →
  `db-history`: rileggono la storia della propria sessione dal database a ogni
  turno (il nativo con `nativeHistorySource`,
  `server/providers/native/history-source.ts:22`, blocchi e strumenti
  compresi), quindi la storia copiata è la loro memoria e non serve altro;
- ogni altro nome, cioè `openclaw` e gli agenti ACP → `null`: tengono una
  sessione loro fuori da Topics, e un `sessionKey` nuovo partirebbe vuoto sotto
  una chat che mostra la storia.

Il server SHALL decidere sul fornitore RISOLTO del topic
(`server/providers/resolve-topic-provider.ts`), non sulla colonna. Il client
con `provider` nullo SHALL mostrare la voce e lasciar decidere il server.

#### Scenario: la tabella
- **WHEN** si chiama `forkModeFor` con `claude-code`, `claude-code-team`, `codex`, `topics`, `topics:opus`, `claude`, `openai`, `openclaw`, `jcode`
- **THEN** le risposte sono `claude-cli`, `claude-cli`, `codex-cli`, `db-history`, `db-history`, `db-history`, `db-history`, `null`, `null`

#### Scenario: il ramo nativo ricorda
- **GIVEN** un topic sul runtime nativo diramato dopo 2 turni
- **WHEN** il nativo legge la storia del ramo (`nativeHistorySource` sul `sessionKey` del ramo)
- **THEN** riceve le 4 righe copiate, con le chiamate agli strumenti delle risposte

#### Scenario: un fornitore senza strada
- **GIVEN** un topic su `openclaw`
- **WHEN** si chiama la rotta
- **THEN** la risposta è 409 con `code: "fork_unsupported"`
- **AND** la barra dei suoi messaggi non ha `msg-action-fork`

### Requirement: CHAT-FORK-04 — La voce sul messaggio e `/fork [testo]` aprono il ramo, e il testo ne è il primo messaggio

Nella barra delle azioni del messaggio (`MessageBubble.tsx`, accanto a
Rigenera, `:420-429`) SHALL esserci un bottone `data-testid="msg-action-fork"`,
icona `GitBranch` di lucide, con `title` e `aria-label` tradotti («Dirama in una
nuova chat»). SHALL comparire solo sull'ULTIMA riga del ramo attivo quando è
una risposta `assistant` non `partial`: durante un turno l'ultima riga è la
risposta in corso, e la voce non c'è. NON SHALL comparire sul coordinatore né
quando `forkModeFor` dice `null`.

Il composer SHALL offrire `/fork` (voce in `SLASH_COMMANDS`,
`client/src/components/Chat/slashCommands.ts:33`, gestita in
`handleSlashCommand`, `ChatPane.tsx:965`). `/fork` NON SHALL essere in
`CLI_BUILTINS` (`server/context/adapt.ts:93`): non arriva mai alla CLI.

Voce e comando SHALL fare la stessa cosa: chiamare la rotta di CHAT-FORK-01,
aprire il ramo come tab permanente col fuoco (`topics:open-topic` con la
proiezione del server, `client/src/hooks/usePanelLifecycle.ts:1547-1583`) e,
se `/fork` ha un testo, spedirlo come primo messaggio del ramo con
`sendMessage(<sessionKey del ramo>, testo)`, la stessa strada di ogni invio.
Senza testo il ramo si apre col composer vuoto.

Un rifiuto SHALL comparire come esito del comando, tradotto per codice
(`turn_in_progress` → «Aspetta la fine del turno»; `fork_unsupported` →
«Questa chat non si può diramare»), e NON SHALL spedire niente né aprire tab.

Dopo il ramo le due chat SHALL andare ognuna per conto suo: un turno in una non
cambia la storia né la sessione dell'altra.

Dove cambiarla: scelta 1 (su quale riga sta la voce), scelta 2 (come si apre
il ramo), scelta 4 (voce assente e risposta di `/fork` durante un turno).

#### Scenario: la voce sta sull'ultima risposta finita
- **GIVEN** una chat con 2 turni finiti
- **WHEN** si passa sulla prima e sull'ultima risposta
- **THEN** `msg-action-fork` c'è solo sull'ultima
- **AND** non c'è su nessun messaggio dell'utente

#### Scenario: diramare dalla voce
- **GIVEN** una chat con 2 turni seminati (4 messaggi)
- **WHEN** si preme `msg-action-fork` sull'ultima risposta
- **THEN** la sidebar ha un topic nuovo «<nome> (ramo)», aperto e col fuoco, che mostra gli stessi 4 messaggi
- **AND** `GET /api/history` della chat d'origine dà ancora 4 messaggi

#### Scenario: `/fork` con un testo
- **GIVEN** una chat con 1 turno finito
- **WHEN** si scrive `/fork prova un'altra strada` e si invia
- **THEN** si apre il ramo, e il suo primo messaggio dopo la storia copiata è «prova un'altra strada»
- **AND** nella chat d'origine quel testo non compare

#### Scenario: `/fork` durante un turno
- **GIVEN** una chat con un turno in corso
- **WHEN** si invia `/fork`
- **THEN** compare «Aspetta la fine del turno»
- **AND** non nasce nessun topic e non si apre nessuna tab

### Requirement: CHAT-FORK-05 — Il ramo dice da dove viene, senza scriverlo nella conversazione

`Topic` SHALL portare
`forkedFrom?: { topicId: string | null; name: string; atMessageId: string }`,
proiettato dal server da `chat_forks` su `GET /api/topics`,
`GET /api/topics/:id` e `topic:created`, e assente per i topic che non sono
rami.

`MessageList` SHALL disegnare, subito dopo la riga `atMessageId`, un divisore
`data-testid="fork-origin-divider"` con «Diramata da <nome>». Il nome SHALL
aprire la chat d'origine (`topics:open-topic`); se l'origine non esiste più il
nome resta testo, senza collegamento. Se la riga `atMessageId` viene cancellata
nel ramo (CHAT-CONV-02) il divisore sparisce, senza errori.

Il divisore NON SHALL essere una riga di `messages`: non entra nella storia
consegnata al fornitore (HISTBUILD-01), nell'esportazione (CHAT-CONV-03) né nei
conteggi dei messaggi.

#### Scenario: il segno sta dove finisce la storia copiata
- **GIVEN** un ramo nato da «Refactor login» dopo 2 turni, con un turno nuovo fatto nel ramo
- **WHEN** si apre il ramo
- **THEN** `fork-origin-divider` sta fra la seconda risposta e il terzo prompt, e dice «Diramata da Refactor login»
- **AND** premendo il nome si apre «Refactor login»

#### Scenario: il segno non è conversazione
- **GIVEN** lo stesso ramo
- **WHEN** si esporta la conversazione e si conta `GET /api/history` del ramo
- **THEN** il file e il conteggio non contengono «Diramata da»

## MODIFIED Requirements

### Requirement: CODEX-02 — Il turno riprende con `codex exec resume`, non con la cronologia ricostruita a mano

Il thread id del fornitore SHALL essere catturato dal primo evento `thread.started`
e persistito subito, prima ancora che il turno finisca: un crash o un abort a
metà turno NON SHALL perdere l'id già ricevuto.

Un turno successivo con un thread id persistito SHALL riprendere via
`codex exec resume <thread_id>` quando il rollout di quel thread esiste ancora
su disco. In quel caso SHALL essere inviato SOLO il nuovo messaggio: la
cronologia NON SHALL essere ricostruita lato client, perché il fornitore la
tiene già server-side.

Il primo turno di un RAMO (CHAT-FORK-01, riga in `chat_forks` con runtime
`codex-cli` e `parent_ref` valorizzato), che non ha ancora un thread suo, SHALL
partire con `codex exec fork <thread madre>` e il prompt da stdin, con `-` come
argomento del prompt: misurato su codex-cli 0.153.4, senza `-` `codex exec fork`
non legge stdin, crea il thread ed esce 0 senza fare il turno. Anche qui SHALL
essere inviato SOLO il nuovo messaggio; il thread nuovo arriva da
`thread.started` e si salva come ogni altro. Il fork SHALL valere solo se il
rollout della madre esiste e ha ancora la dimensione registrata al momento del
ramo (`parent_at`): una madre che ha fatto turni dopo li porterebbe nel ramo.
Altrimenti, o se il fork fallisce, `parent_ref` SHALL essere azzerato e il
turno SHALL partire fresco.

Un thread id persistito il cui rollout NON esiste più (o assente) SHALL essere
scartato, e il turno SHALL ripartire fresco con `codex exec`, tornando alla
cronologia ricostruita in markdown come SOLO in quel caso di fallback (per un
ramo, quella cronologia è la storia copiata).

#### Scenario: prima riga di un turno fresco
- **GIVEN** un turno che parte con `codex exec --json` (nessun thread id salvato)
- **WHEN** arriva l'evento `thread.started`
- **THEN** il thread id SHALL essere salvato subito, prima di ogni evento successivo

#### Scenario: turno successivo con rollout ancora presente
- **GIVEN** un thread id persistito il cui rollout esiste ancora
- **THEN** il turno SHALL usare `codex exec resume <thread_id>`
- **AND** il prompt inviato SHALL contenere SOLO il nuovo messaggio

#### Scenario: thread id persistito ma rollout sparito
- **GIVEN** un thread id persistito il cui rollout NON esiste più
- **THEN** il turno SHALL ripartire fresco con `codex exec`
- **AND** il thread id stantio SHALL essere dimenticato

#### Scenario: primo turno di un ramo Codex
- **GIVEN** un ramo senza thread suo, con `parent_ref` = T e il rollout di T della stessa dimensione di `parent_at`
- **WHEN** si monta l'argv del turno
- **THEN** l'argv è `exec fork T --json --skip-git-repo-check`, i flag condivisi con la sandbox via `-c`, e `-` in fondo
- **AND** il prompt contiene SOLO il nuovo messaggio

#### Scenario: la madre è andata avanti
- **GIVEN** lo stesso ramo, con il rollout di T più lungo di `parent_at`
- **WHEN** parte il primo turno
- **THEN** il turno parte fresco con `codex exec` e la cronologia in markdown della storia copiata
- **AND** `parent_ref` del ramo diventa nullo
