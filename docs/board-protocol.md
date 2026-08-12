# Protocollo board / dispatch

Standard di consegna per gli agenti dispatchati sul board Kanban. **Questa e' la
copia canonica.** Stava in `CLAUDE.md`, cioe' veniva iniettata in ogni chat del
progetto — comprese le tantissime che non toccano mai la board — per 3.781 byte
(~1.600 token) a OGNI richiesta del modello, non a ogni sessione.

Chi lo riceve davvero, e quando:
- **Gli agenti dispatchati**: dall'envelope di `buildKickoff`
  (`server/services/task-dispatcher.ts`), che porta gia' queste regole nel loro
  primo messaggio. Non passano di qui.
- **Chi tocca il dispatcher o l'envelope**: legge questo file. Il testo di
  `buildKickoff` deve restare allineato a cio' che segue, ed e' proprio perche'
  le copie erano due e libere di divergere che quella canonica sta ora in un
  posto solo.

Standard di consegna per gli agenti dispatchati sul board Kanban (worktree isolato
per task, un agente = un task, fino allo stato `review`). Vale sia per chi lavora
un task sia per chi tocca il codice del dispatcher/envelope: il testo dell'envelope
in `server/services/task-dispatcher.ts` (`buildKickoff`) deve restare allineato a
queste regole.

1. **Consegna = lavoro COMMITTATO sul branch.** Non "implementato": committato. Il
   server rifiuta il passaggio in `review` con worktree sporco (`review_needs_commit`,
   409 in `server/routes/tasks.ts`). Una consegna è: commit sul branch del task + UN
   commento di sintesi nel thread + spostamento in `review` fatto DALL'AGENTE
   (`update_task(status="review")`). L'umano approva; l'agente non porta mai a `done`.

2. **La consegna include l'ULTIMO MIGLIO.** Installer, hook, migration, deploy di
   test: fanno parte della consegna, non di un "poi qualcuno farà X". Il reviewer
   deve poter VEDERE il risultato finito, non un pezzo a metà da completare a mano.

3. **Ogni claim con EVIDENZA verificabile.** Esiti di comandi, log, `mtime`,
   conteggio dei test che passano. Una promessa ("build in corso", "dovrebbe
   funzionare") non è una consegna: è una consegna solo ciò che è verificato.

4. **Anteprima = evidenza DUREVOLE, e il ramo si sceglie con un criterio
   misurabile.** Il testo della regola **non sta più scritto qui**: è la costante
   `PREVIEW_RULE` in `shared/board.ts`, ed è la STESSA STRINGA che leggono
   l'envelope di kickoff, quello di resume, la descrizione di `preview_image`
   nello schema del tool MCP e il braccio `board-sim` del benchmark. Riscriverla
   in uno di quei posti è il modo in cui, fino al 10/08/2026, cinque copie
   dicevano cose diverse — con due soli rami, entrambi su UI, e una consegna
   senza superficie renderizzata (un piano, un'architettura) che finiva nel ramo
   «statica»: l'agente FOTOGRAFAVA il documento. I rami ora sono tre —
   **screenshot** (superficie renderizzata che entra in una schermata, `h/w`
   entro la soglia oltre cui la card taglia), **video ≤20s** (servono due o più
   STATI per dimostrarla), **diagramma `.svg`** (nessuna superficie renderizzata:
   si disegna la struttura) — con un cancello solo: *a 268px di larghezza devi
   ancora saper dire cosa mostra*. `server/services/task-dispatcher.test.ts`
   verifica che le copie siano ancora la stessa stringa e che non ne nasca una
   sesta.

   Attorno alla regola, ciò che la board fa da sé: il video è reso coi controlli
   (drawer) e in loop muto (card); un allegato del commento di consegna viene
   PROMOSSO ad anteprima se la card è ancora cieca (`promoteReviewPreview`), ma
   non se è troppo alto per la card — in quel caso resta una nota nel thread e la
   consegna prosegue lo stesso, perché non è un cancello di review. Una TAB del
   task (`open_browser_pane`) è solo un EXTRA dal vivo (dev server, pagina) ed è
   EFFIMERA — muore col server che la serve: la prova che resta è l'anteprima.
   Un URL o una descrizione scritti solo nel thread non bastano.

5. **Azioni sull'ambiente dell'umano: mai senza ok esplicito.** Relaunch dell'app,
   deploy in prod, uso di credenziali → prima si chiede. Le credenziali non si
   scrivono MAI in chiaro (thread, file, commit): se ne servono, ci si ferma e si
   chiede.

6. **Approve = SOLO accettare il task** (review → done, sblocca i dipendenti). Non
   fa più merge/build/reap "da sotto": il landing è un passo ESPLICITO e separato
   (scorporato 2026-07-19). Le azioni sono tre, ognuna un click umano deliberato:
   - **Approva** → accetta il task, nient'altro.
   - **Landa su main** → accetta + merge LOCALE del branch (mai push): l'agente lo
     offre come opzione a fine consegna (`comment_task(options=["Landa su main"])`,
     costante `LAND_ACTION_LABEL`) e il server la instrada a `landTask`
     (`server/routes/tasks.ts`), oppure il bottone/endpoint `POST …/tasks/:id/land`.
     Poi: tocca `client/` → rebuild bundle; `server/`/`server.ts` → live al reload;
     `desktop-tauri/` → serve rebuild+relaunch; a merge fatto → reap del worktree;
     **conflitto** → torna all'agente, che rifà la BASE del suo ramo sul main
     aggiornato (`git rebase main`) — NON un merge di main dentro il ramo — e
     rimette in review. Il divieto «non toccare main» resta (niente push, niente
     merge VERSO main): rifare la base del PROPRIO ramo non lo viola.
   - **Pubblica** (andare online) → push del branch → deploy CI. SEMPRE separato,
     mai automatico, con anteprima del diff. L'agente NON lo esegue né lo propone.

7. **Lavoro futuro fuori scope → task top-level nel backlog** (senza `parent`), mai
   nuovi subtask del task in consegna. Un task con subtask aperti non è approvabile:
   i subtask sono la checklist dello STESSO task, non un modo per rimandare lavoro.

8. **Chi chiude la card lo dice un'ETICHETTA, e l'etichetta la deriva il server.**
   Sulla coda di review dell'11/08/2026 la domanda «chi chiude questa?» si
   rispondeva a mano, card per card, aprendo il diff. Il conto, rifatto con le
   classi giuste su una trentina di card: **21 visibili, 7 decisioni, 2
   invisibili**.

   - **Tre classi, non due**, e la regola sta scritta una volta sola in
     `shared/task-labels.ts` (`deriveCloser`), applicata ai file dei commit
     PROPRI del task (`server/services/own-commits.ts` — non `main...ramo`: un
     ramo che eredita il lavoro di un altro risponderebbe per conto suo):
     · **`visibile`** — tocca `client/src/**` fuori dai `*.test.*` ⇒ **la guarda
       un umano**. Basta UN file: una superficie che si vede si guarda, il peso
       nel diff non c'entra.
     · **`decisione`** — il diff è solo documenti (`*.md`, `openspec/**`,
       `docs/**`) oppure NON c'è diff ⇒ **la decide un umano, sempre**.
     · **`invisibile`** — codice che nessuno vede (server, shared, script, test)
       ⇒ **la chiude il conduttore**, se la barra è verde per intero.
   - **`decisione` è la classe che serviva davvero.** Con due sole classi i piani
     finivano in «invisibile» e la macchina se li sarebbe chiusi da sola: il piano
     dell'amicizia fra installazioni, la ricerca sulla generative UI, l'iscrizione
     all'Apple Developer Program, la proposta openspec del browser inline. Un
     piano non è invisibile: è invisibile il suo EFFETTO, non la sua importanza.
     L'assenza di diff non è una prova di irrilevanza, è assenza di prova.
   - **La conseguenza operativa.** Una card `invisibile` con la barra VERDE per
     intero (`checksState === 'pass'`: tutti i comandi della board, non alcuni)
     la chiude il **conduttore**. `visibile` e `decisione` restano all'umano
     anche con la barra verde. «Nessun check» (`null`) non è un verde e non
     autorizza nessuno. Il predicato è `whoCloses`, e la board lo disegna sulla
     card in review.
   - **Quanto vale la scorciatoia, onestamente: 2 card su ~30.** Il grosso della
     coda è roba visiva e resta di Attilio. L'etichetta serve lo stesso — 2 card
     al giorno diventano tante in un mese, e soprattutto il FILTRO «solo le
     visibili in review» è la lista che gli serve davvero.
   - **L'agente può alzare la mano, mai abbassarla.** Con `label_task` può
     chiedere `visibile` o `decisione` (due modi di passare la card a una
     persona) e mettere le etichette di genere (`bugfix` `feature` `chore`
     `misura`, che non decidono niente). `invisibile` è **rifiutato con 403**:
     marcare invisibile il proprio lavoro sarebbe firmarsi il permesso di
     chiudersi le card da solo.
   - **L'umano corregge sempre**, dal chip nel drawer, `invisibile` compreso — e
     una correzione a mano non viene più sovrascritta dalla consegna successiva.
