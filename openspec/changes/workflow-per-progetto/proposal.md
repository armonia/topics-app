# workflow-per-progetto: colonne della board configurabili, con triage, AI review e human review

## Deciso da Attilio (28/10, tutte e tre come consigliate)

1. **Un livello per progetto, con un default globale; la cartella in una fase due (scelta):** copre il caso
   di Attilio (lo stesso workflow su ogni progetto, cambiabile dove serve) e il livello cartella non ha ancora un
   caso d'uso: oggi una sottocartella è già un'altra board (`projectId` = hash del percorso). Alternativa: tre
   livelli subito, con la ricerca risalendo da cartella a progetto a globale.
2. **Da AI review chiude chi ha aperto la card, con la prova; in human review arrivano solo le card marcate
   «serve l'occhio di Attilio» (scelta):** è la regola del 28/10 («in review solo ciò che deve vedere lui»)
   e svuota la colonna di ciò che oggi gli finisce in coda per abitudine. Alternativa: ogni card passa comunque da
   human review e l'AI review resta un passaggio consultivo.
3. **Il triage solo per le card che arrivano da persone e da chat (scelta):** spesso mancano barra e
   priorità; una card aperta da un agente con titolo, barra e priorità va dritta in todo. Alternativa: tutto passa dal triage, anche le card già complete.

## Perché

Attilio, 25/10: un workflow per i topics, globale o per progetto o per cartella, con un default per noi e stati
extra: triage (raccoglie le informazioni mancanti, dà il nome, propone dipendenze e priorità, decide che farne),
AI review e human review. Il 28/10 ha fissato la regola che li lega: la colonna review contiene solo ciò che deve
vedere lui; il resto lo chiude chi ha aperto la card. Oggi le colonne sono cinque, scritte nel codice, uguali per
ogni progetto.

## Com'è oggi (letto su origin/main, v2.3.40)

- `shared/board.ts:24`: `TASK_STATUSES = ['backlog','todo','in_progress','review','done']`, il tipo ne deriva.
- Il DB ha il vincolo `CHECK(status IN (...))` su `tasks` (`001-initial.sql:139`, `server/db/test-schema.ts:43`) e su
  `scheduled_cards`. Circa 100 file fra server, shared e client citano gli stati per nome; la tray
  (`shared/tray-board.ts`, gruppi review / in_progress / todo), «Ti aspetta», l'enum del server MCP e il
  dispatcher (il `claim` prende solo `status = 'todo'`) ci si appoggiano.
- Le impostazioni per progetto stanno in `board_settings` (chiave `project_id`, riga riservata `'*'` per ciò che è
  globale): il precedente giusto per «globale con override di progetto». La card ricorda chi l'ha aperta
  (`created_by_topic_id`, migration 093), `blockedByTaskId` e `priorityAuto` esistono già, e `needs_input` è già il
  modo in cui una card chiede qualcosa all'utente.
- Un agente non porta mai a `done` (`agent_cannot_complete`, `tasks.ts` ~3890): l'unica via oggi è la review umana.

## Cosa cambia

- **Una colonna è uno «stage» sopra uno degli stati base.** Il workflow è una lista ordinata di colonne
  `{id, etichetta, stato base}`; `tasks.status` resta uno dei cinque, e una nuova colonna nullable `tasks.stage`
  dice in quale colonna sta la card. Così il vincolo del DB, la tray, il dispatcher e l'MCP non cambiano.
- **Workflow di default = le cinque colonne di oggi**, quindi nessuna board cambia finché non sceglie altro.
  Preset «Armonia»: `triage` (base backlog) → `todo` → `in_progress` → `ai_review` (base in_progress, quindi
  fuori da review, dalla tray e da «Ti aspetta») → `human_review` (base review) → `done`.
- **Dove si dichiara:** tabella `board_workflows(scope, columns_json)`, riga `'*'` globale e una riga per
  `project_id`; il progetto vince sul globale. Si sceglie nel pannello impostazioni della board (preset, non un
  editor libero).
- **Triage:** una card che vi entra è presa da un agente di triage (dispatch di classe propria, oggi il claim non
  tocca il backlog). Se manca informazione chiede con `needs_input`; poi imposta titolo, priorità e dipendenza e
  la manda in todo, lasciarla in triage o chiuderla.
- **AI review:** la fa chi ha aperto la card (`created_by_topic_id`). Se la card è marcata «serve l'occhio di
  Attilio» passa a `human_review`; altrimenti chi l'ha aperta la chiude con un commento di prova. È l'unica
  eccezione ad `agent_cannot_complete`, ristretta a queste card e a questo attore.

## Barra

Da creare insieme al codice, tutte da rieseguire uguali:

1. `bun test shared/workflow.test.ts server/services/tasks.workflow.test.ts` exit 0: senza riga, le colonne sono
   le cinque di oggi; il progetto vince sul globale; stage → stato base coerente; `ai_review` non conta come review.
2. `bun run typecheck && bun run lint` exit 0.
3. `pw-remote -- npx playwright test tests/e2e/workflow-per-progetto.spec.ts` exit 0, con video: sul preset
   Armonia la board mostra sei colonne; una card da chat entra in Triage e dopo il triage va in Todo; una consegna
   non marcata passa da AI review a Done con la prova; una marcata arriva in Human review; tray e «Ti aspetta»
   contano solo Human review.
4. Mutazione sul punto critico: far contare `ai_review` nei gruppi della tray, e il passo 3 deve uscire non-zero.
5. Ciò che è verde resta verde: `bun run test:unit` exit 0 e, su una board senza workflow, le colonne e i
   conteggi identici a prima (snapshot).

## Fuori

Il livello cartella; un editor libero di colonne e transizioni; stati veri nel DB (ricostruire `tasks` per il
CHECK e toccare ~100 file, senza che serva a nessuno dei casi sopra); migrare le card esistenti (restano senza
`stage` = colonna del loro stato); cambi alla tray e all'app mobile oltre al conteggio per stato base.

## Deciso da me

Stage sopra stato base invece di stati nuovi nel DB, preset invece di editor libero, tabella `board_workflows`
accanto a `board_settings`.

## Non ancora specificato

- Come si marca una card «serve l'occhio di Attilio» (etichetta, campo, o deciso dall'agente che la apre) e chi può
  toglierla.
- Cosa vede la tray quando una colonna ha un nome diverso dallo stato base.

## Implementato (30/10)

Codice sul ramo di questa card, a partire da `main` v2.3.43.

- `shared/workflow.ts`: i due preset (`default` = le cinque colonne di prima, `armonia` = Triage, Todo, In Progress,
  AI review, Human review, Done), la risoluzione progetto > globale > default, la colonna di una card
  (`columnOfTask`), chi aspetta una persona (`awaitsHuman`), dove nasce una card (`stageAtBirth`) e dove va una
  consegna (`stageForDelivery`).
- Migration `20261030225403-board-workflows`: `tasks.stage`, `tasks.human_ask`, tabella `board_workflows(scope,
  preset, updated_at)`. Una board senza riga non scrive mai `stage` e manda le stesse righe di prima.
- Servizio: lo stage segue lo stato e viceversa; una consegna su una card aperta da un agente o da un cron va in AI
  review, con `human_ask` va in Human review; chi l'ha aperta (`created_by_topic_id`) la chiude da AI review con la
  prova in `summary` (unica eccezione ad `agent_cannot_complete`); un agente non può mai scegliere `ai_review` e
  porta una card in Human review solo con la domanda.
- Rotte: `GET/PUT /api/boards/:id/workflow` (`*` = globale); `stage` e `human_ask` sulla PATCH umana e su quella
  dell'agente; MCP `update_task` (`stage`, `human_ask`) e `update_global_task` (`stage`, per il triage).
- «Ti aspetta», push, conteggio della scheda Board e tray contano solo ciò che aspetta una persona: una card in AI
  review non si accende (`server/attention`, `shared/tray-board.ts`).
- Board: colonne disegnate dal workflow, trascinamento fra colonne con lo stesso stato (AI review → Human review),
  scelta del preset nel pannello impostazioni (questa board: eredita / standard / triage + review; tutte le board).

### Scelte prese implementando

- **AI review ha come stato base `review`, non `in_progress`.** Con `in_progress` la card rientrava nei
  meccanismi di lavoro vivo (censimento agenti, consegna di sistema a fine turno che la riporta in review); con
  `review` tiene tutta la macchina della consegna (approvazione, riassunto, chip) e la differenza la fa un solo
  predicato, `awaitsHuman`, usato da tray, «Ti aspetta» e push.
- **La riga salva il preset, non le colonne.** Le colonne sono codice: un preset che cambia aggiorna ogni board che
  lo usa senza riscrivere righe.
- **Il triage lo fa il coordinatore, non una classe di dispatch nuova.** Una card ferma in Triage da dieci minuti
  arriva al coordinatore con lo stesso avviso delle card senza padrone (`task:unowned`), anche se l'ha aperta una
  persona; il coordinatore la sistema con `update_global_task` (titolo, priorità, dipendenza, `stage: todo`). Un
  agente di triage dedicato resta un passo successivo.
- **Una card di un agente salta il triage se nasce completa**: priorità esplicita e descrizione (dove sta la barra).
- **Si marca «serve l'occhio di Attilio» con `human_ask`**, la domanda scritta nella consegna: la decide l'agente
  che consegna, o chi ha aperto la card quando la passa a Human review.
- ~~Una consegna di sistema resta in Human review~~: corretto il 31/10, vedi sotto.

### Barra, eseguita

1. `bun test shared/workflow.test.ts server/services/tasks.workflow.test.ts`: exit 0.
2. `bun run typecheck && bun run lint`: exit 0.
3. `npx playwright test tests/e2e/workflow-per-progetto.spec.ts` (Chromium del container, `E2E_EVIDENCE=1
   E2E_VIDEO=1`): exit 0, con video.
4. Mutazione: `awaitsHuman` che conta anche `ai_review` (cioè la tray e «Ti aspetta» che contano AI review): la
   spec del passo 3 e `shared/tray-board.test.ts` escono non-zero.
5. `bun run test:unit`: due rossi miei (test che leggevano il sorgente della colonna), corretti e verdi. Restano
   quattro rossi che non dipendono da questo ramo: `command-service` è rosso anche su `main`,
   `server-restart-keeps-claude-session` cade su `EAFNOSUPPORT` (niente IPv6 nel container), `late-scan-past-cap`
   e `processes.command` da soli passano su entrambi i rami (3 su 3).

## Correzioni dopo la verifica indipendente del 31/10

Ogni punto ha il suo test in `server/services/tasks.workflow.test.ts` (blocco «review of 31/10») o in
`server/services/ai-review-notice.test.ts`; requisito `KANBAN-102` in `openspec/specs/kanban/spec.md`.

1. **Chi ha aperto la card viene avvisato.** All'ingresso in AI review, da qualunque porta, il server sveglia la
   chat di chi l'ha aperta (`created_by_topic_id`) con un messaggio della board che dice come chiuderla; se quella
   chat non può prendere un turno, o la card non ne ha una (`agent:api`, cron), sveglia il coordinatore. In ogni
   caso esce `task:ai-review` sul socket e una riga in activity_log (categoria `board`), e una nota `service` nel
   thread. Una card ferma in AI review per 30 minuti dall'ultimo tocco viene ricordata al coordinatore
   (`sweepStaleAiReview`, colonna `ai_review_reminded_at`), una volta per tocco: è anche ciò che copre un riavvio.
   File: `server/services/ai-review-notice.ts`.
2. **Il coordinatore chiude al posto di chi non ha una chat.** `update_global_task` passa `asCoordinator`: da AI
   review può chiudere con la prova, o passare a Human review con `human_ask`. La rotta globale ora accetta
   `stage` e `human_ask` (prima li rifiutava con 400, quindi anche il triage via `update_global_task` non passava).
3. **La consegna di sistema segue il workflow.** `deliverToReviewBySystem` e la domanda sui figli fermi passano da
   `stageForDelivery`: una card di macchina va in AI review; va in Human review solo se l'ultima parola
   dell'agente è una domanda per la persona (diventa `human_ask`), o se è la domanda sui figli fermi. Le tre
   `task:review-ready` di sistema (dispatcher locale, fan-out, nodo remoto) suonano solo se `awaitsHuman`.
4. **`stage: null` da un agente** vale come la colonna di default dello stato e passa dagli stessi controlli: su
   una card in AI review è un passaggio a Human review, quindi serve essere chi può chiuderla e serve `human_ask`.
5. **Il rifiuto (e l'approvazione) chiudono il giro della colonna**: `reviewDecision` azzera `stage` e
   `human_ask`, e la consegna di sistema scrive sempre lo stage che calcola.
6. **Cambiare preset ripulisce gli stage che il nuovo workflow non ha** (`applyBoardWorkflow`, usato dalla PUT):
   la card torna alla colonna di default del suo stato, lo stato di attenzione la rilegge, e `task:updated` va
   alle board. Per la riga globale vale per le board senza riga propria.
- **Chip «Spostata a mano»:** compariva su una card consegnata da un agente senza sessione sulla card (chi
  l'ha aperta dalla propria chat, o il coordinatore). Ora una consegna dichiarata da un agente non è «a mano».

Limite noto: nel banco e2e la sveglia non parte, perché la chat di prova usa il provider `topics`, non connesso
lì (409 `topics_routing_incompatible`); la spec verifica la riga in activity_log e il servizio di avviso ha i
suoi test con la rotta finta.
