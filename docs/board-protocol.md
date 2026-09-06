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

**DUE LINGUE, e non e' una svista.** Dal 2026-08-15 l'ENVELOPE e' in inglese —
`buildKickoff`, il kickoff di fan-out, il resume, il sollecito, e le tre costanti
che ci finiscono dentro (`PREVIEW_RULE`, `CODE_GATES_RULE`, `VERSION_BUMP_RULE`
in `shared/board.ts`). E' un contratto di RUNTIME letto da un modello, sta nel
codice, e in questo repo il codice e' in inglese. QUESTA copia resta in italiano
perche' il suo lettore e' una persona, e lo dice la prima riga. Cio' che deve
restare allineato sono le REGOLE, non le parole: se cambi una regola in un posto,
cambiala anche nell'altro.

La lingua della RISPOSTA dell'agente non e' cambiata: `languageLine` mette sempre
una riga nell'envelope, e sull'impostazione `auto` dice esplicitamente di
scrivere all'umano nella lingua del TESTO DEL TASK. Prima quella lingua era
implicita — l'agente imitava l'italiano dell'envelope — e una traduzione senza
quella riga avrebbe cambiato in silenzio la lingua di tutta la board.

**Il CODICE e' un'altra cosa dalla board (deciso il 21/08/2026).** La riga di
lingua parla di come l'agente scrive ALL'UMANO: la board resta nella lingua del
task. Il codice no: identificatori, stringhe e COMMENTI sono sempre in inglese.
La regola sta scritta in `CODE_GATES_RULE` come sesto cancello, ed e' applicata
da `bun run check:comment-language` (`scripts/check-comment-language.ts`).

E' un ratchet, come `check:bloat` e `check:sleeps`, e per lo stesso motivo: il
giorno in cui e' nato l'albero aveva ~95.000 righe di commento in italiano in
1.974 file, e un cancello che nasce rosso viene spento entro una settimana
invece che rispettato. `scripts/comment-language-baseline.json` congela quel
numero per file: un file non elencato deve stare a ZERO, uno elencato non puo'
guadagnarne. Guarire non fallisce mai, e si registra con `--update-baseline`.
Quando l'italiano E' l'oggetto (un messaggio citato, un termine tecnico senza
equivalente, le parole esatte di qualcuno) la riga finisce con
`allow-italian: <perche>`. Per leggere il debito di un file:
`bun run scripts/check-comment-language.ts --list <path>`.

**La suite unit intera la fa girare la BOARD, non l'agente (dal 04/09/2026).**
L'envelope chiede all'agente `bun test <i file toccati e i test che li importano>`;
il `bun run test:unit` completo parte alla consegna, nel suo worktree, e l'esito
torna nel risultato di `update_task`. Prima ogni agente lanciava la suite piena
da sé (spesso con `nohup … &` per poi leggere il log), e la board la rilanciava
alla consegna: con sei agent erano fino a tre suite in parallelo sui tre slot
del gate, più le copie orfane lasciate da un turno tagliato — misurato load 115
su 12 core alle 14:40 del 04/09. Il carico sono i cancelli, non gli agent.

**Le e2e dei file toccati sono il sesto check (dal 06/09/2026).** Cinque cancelli
su sei non contenevano nessun test end-to-end, e il land e' un merge locale che
non passa dalla CI: la notte del 05/09 undici card sono arrivate verdi in review
e la CI di main si e' svegliata con undici spec e2e rosse in piu' (sidebar,
pannello git, drawer della board, permalink). `bun run check:e2e-touched`
(`scripts/check-e2e-touched.ts`) sceglie le spec legate al DIFF del ramo (la spec
stessa, chi importa il modulo, l'area, i testid) e ne fa girare al massimo otto;
in un worktree costruisce da se' il bundle del client e prende la porta derivata
dal path, quindi non tocca ne' `public/` ne' la 13334. Sta nella colonna
`review_checks` del board come gli altri, dopo `test:unit`.

**Il tetto vero e' il PIANO, non la CPU (dal 04/09/2026).** Otto agent nativi e
le chat della persona stanno sulla stessa OAuth del piano Claude: alle 13:00Z
la finestra di 5 ore era al 100% e per tre ore ogni turno rispondeva 429. Ora
il server legge l'endpoint di utilizzo (`server/providers/native/usage-window.ts`)
e con una finestra esaurita registra un hold (`server/lib/provider-hold.ts`):
niente dispatch, niente riprese, cartello con l'ora del reset in chat e nella
status bar. Con la finestra settimanale sopra il 90% il tetto degli agent va
tenuto a 2-3, altrimenti al 100% si fermano TUTTI, chat comprese, fino al
reset settimanale. `runtime.integration.test.ts` chiama l'API vera e spende
turni del piano: e' opt-in (`TOPICS_REAL_API_TESTS=1`), non gira nei gate.

**Il settimo cancello sono i NOMI (dal 04/09/2026).** `check:comment-language`
legge i commenti e non vede un identificatore: nella notte del 04/09 trentacinque
nomi italiani di test e costanti sono passati verdi da tutti i cancelli della
board e hanno reso rosso `bun run check:identifier-language`
(`scripts/check-identifier-language.ts`, ratchet in
`scripts/identifier-language-baseline.json`). L'envelope ora lo nomina come
settimo cancello: ogni nome NUOVO dichiarato deve essere una parola inglese, o
entrare in `PROJECT_WORDS` con un motivo; la baseline si riscrive solo in
discesa. Nota per chi imposta la board: i check pre-review (`reviewChecks`)
restano sei slot, e i cancelli statici vanno incatenati in uno solo
(`STATIC_RAILS_CHECK` in `server/services/review-checks.ts`) perche' la
board li esegua davvero prima del land.

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

1-bis. **Una card in review si deve poter LEGGERE senza rileggere il diff.**
   Quando un turno viene tagliato prima che l'agente commenti (riavvio del
   server, watchdog, sessione morta) la card sale in `review` con un ramo
   addosso, una descrizione vuota e un avviso di servizio come ultima riga:
   chi rivede trova un id e deve rifare da capo l'indagine che l'agente aveva
   gia' fatto. Succede: tre volte in un pomeriggio il 19/08/2026, su consegne
   che valevano fino a 265 righe.
   Chi se ne accorge lo ripara scrivendo lui descrizione e riassunto — il diff
   c'e', il lavoro non e' perso — e il controllo `review-card-is-mute` di
   `scripts/board-doctor.ts` le trova senza doverle cercare a mano.

2. **La consegna include l'ULTIMO MIGLIO.** Installer, hook, migration, deploy di
   test: fanno parte della consegna, non di un "poi qualcuno farà X". Il reviewer
   deve poter VEDERE il risultato finito, non un pezzo a metà da completare a mano.

3. **Ogni claim con EVIDENZA verificabile.** Esiti di comandi, log, `mtime`,
   conteggio dei test che passano. Una promessa ("build in corso", "dovrebbe
   funzionare") non è una consegna: è una consegna solo ciò che è verificato.

4. **Anteprima = evidenza DUREVOLE, e il ramo si sceglie con un criterio
   misurabile.** Il testo della regola **non sta più scritto qui** (ed è in
   inglese, come tutto l'envelope): è la costante
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

   **Come nasce un video ≤20s, senza tagliarlo dopo.** `tests/e2e/helpers/clip.ts`:
   `clipDiConsegna` apre un contesto DEDICATO con `recordVideo` acceso sul solo
   tratto utile. Il setup — l'app che parte, il progetto che si apre — sta nel
   `prologo`, su una pagina il cui video viene buttato; il browser è suo, perché
   `slowMo` è un'opzione di LANCIO e non di contesto e nessun `newContext` se la
   toglie di dosso. Alla fine MISURA il `.webm` (`helpers/webm-duration.ts`, EBML
   letto a mano: `ffprobe` non è garantito su nessuna macchina) e ALZA se sfora
   il tetto. Si accende con `E2E_CLIP=1`, che non è `E2E_EVIDENCE=1`:

       E2E_CLIP=1 ./node_modules/.bin/playwright test board-recapture-preview -g RECAPTURE-01

   `E2E_EVIDENCE=1` resta il modo storico — `slowMo: 300` e video su OGNI test —
   e produce clip che contengono il setup. Con quello `board-recapture-preview`
   usciva a 26,9s ed è finita tagliata a mano con `ffmpeg`, scegliendo a occhio
   l'istante di partenza: chi taglia male consegna una clip che comincia dopo il
   click, e non lo scopre nessuno. Con `E2E_CLIP=1` la stessa scena esce a
   13-15s misurati, senza nessun taglio.

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
   - **Anche il GENERE si deriva alla consegna** (`deriveKind`, stessi file dei
     commit propri). Al 12/08/2026 `task_labels` aveva 50 righe e **zero** di
     genere: il vocabolario esisteva e il filtro sulla board era già disegnato,
     ma nessuno scriveva il dato, quindi il filtro girava a vuoto. Chiederlo
     all'agente era la scommessa che aveva già perso una volta.
     · **`misura`** — la card tocca SOLO test (`tests/**`, `*.test.*`, `*.spec.*`).
     · **`chore`** — SOLO impalcatura (`package.json`, i lock, `tsconfig*`,
       `*.config.*`, `Cargo.toml`, `.github/**`).
     · **`feature`** — fra i file di prodotto ce n'è uno **nato** in questi
       commit (`A` in `--name-status`); ne basta uno.
     · **`bugfix`** — solo modifiche a codice che esisteva già.
     Test e config non spostano il genere quando c'è del prodotto sotto,
     altrimenti ogni card sarebbe `chore` per via di `bun.lock`. Una card di
     soli documenti, o senza diff, **non prende genere**: è una `decisione`, e
     `chore` su un piano sarebbe una bugia che il filtro poi propaga.
   - **Il limite, detto:** `feature`/`bugfix` guarda se un file è nato in quei
     commit, che è una misura e non una diagnosi. Una funzionalità scritta per
     intero dentro file che esistevano già esce `bugfix`. Per questo il genere si
     scrive `derived`: è un default su cui filtrare, e la correzione a mano vince.
   - **L'umano corregge sempre**, dal chip nel drawer, `invisibile` compreso — e
     una correzione a mano non viene più sovrascritta dalla consegna successiva.
     Vale per famiglia: chi chiude e che genere è sono due domande indipendenti,
     e correggere la prima non congela la seconda.
