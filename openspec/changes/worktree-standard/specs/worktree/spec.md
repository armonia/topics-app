## ADDED Requirements

### Requirement: WORKTREE-STD-01 — La radice delle worktree e i suoi tetti sono impostazioni della macchina

La radice in cui nascono le worktree SHALL risolversi, in quest'ordine, da env `TOPICS_WORKTREES_DIR`, dall'impostazione `app_settings.worktree_root`, dal default `<casa di Topics>/worktrees`; un valore vuoto a un passo SHALL cadere al successivo. L'impostazione SHALL essere un percorso assoluto fuori da `/tmp`: un valore relativo o in un'area temporanea SHALL essere rifiutato dalla rotta e ignorato dal risolutore. Cambiare la radice SHALL valere per le worktree nuove senza riavvio; quelle esistenti SHALL restare dove sono e una riga con percorso nella vecchia radice SHALL restare rimovibile da Topics. Il tetto di worktree per progetto (default 20), il pavimento di disco libero (default 12 GB, che sostituisce la costante del dispatcher), la modalità di `CARGO_TARGET_DIR` (`shared` | `per-worktree`, default `shared`), il permesso di pulire worktree fatte altrove (`off` | `merged`, default `off`) e i giorni dopo cui un ramo non unito è fermo (default 7) SHALL essere impostazioni, tutte vuote di default con il comportamento di prima.

#### Scenario: l'ordine di risoluzione
- **GIVEN** un'impostazione `worktree_root` valorizzata e l'env `TOPICS_WORKTREES_DIR` valorizzata
- **WHEN** si risolve la radice
- **THEN** SHALL vincere l'env; senza env SHALL vincere l'impostazione; con l'impostazione vuota SHALL vincere `<casa>/worktrees`

#### Scenario: un valore sbagliato non passa
- **GIVEN** la richiesta `PUT /api/app-settings` con `worktreeRoot: "/tmp/wt"` o `"wt"`
- **THEN** la risposta SHALL essere 400 sul campo `worktreeRoot` e il valore salvato SHALL restare quello di prima

### Requirement: WORKTREE-STD-02 — I checkout usa-e-getta stanno nella radice, sotto `_scratch`

I checkout temporanei di land, realign, misura di integrazione e controlli dei nodi SHALL nascere in `{radice}/_scratch/{land|realign|integrazione|node-checks}/{id}` e NON SHALL usare la cartella temporanea di sistema. All'avvio del server, prima di qualunque lavoro, SHALL essere tolto ciò che il processo precedente ha lasciato in `land`, `realign`, `integrazione` e (col suo pool) `node-checks`, dal disco e da `git worktree list`; anche i controlli dei nodi lasciati nella vecchia cartella temporanea SHALL essere tolti una volta. Due server con case diverse NON SHALL spazzare i checkout l'uno dell'altro.

#### Scenario: ciò che il processo prima ha lasciato sparisce all'avvio
- **GIVEN** una worktree registrata in `{radice}/_scratch/land/<id>` lasciata da un processo ucciso
- **WHEN** parte la spazzata d'avvio
- **THEN** la cartella SHALL non esistere più e `git worktree list` SHALL non nominarla; una worktree sotto `{radice}/<progetto>/` SHALL restare intatta

### Requirement: WORKTREE-STD-03 — Il GC guarda la radice e le righe insieme, e non rimuove mai lavoro vivo

Il GC SHALL unire la lettura della radice (`{radice}/*/*`, esclusa `_scratch`), le righe del DB e `git worktree list --porcelain -z` dei progetti noti, e classificare ogni cartella: unita e pulita (reap), ferma da più dei giorni impostati (archive-then-free), orfana con `.git` (registrata e poi giudicata), fantasma senza `.git` e fuori da git (rimossa, età minima 24 ore), riga senza cartella, errori compresi (riga chiusa), fuori radice (solo inventario, rimozione solo su richiesta con anteprima). Il GC NON SHALL mai rimuovere una worktree lockata da altri, sporca, con commit non raggiungibili da un altro ref, con card attiva, né una cartella senza riga o una riga in errore più giovane di 24 ore, e SHALL scrivere `refs/topics/archive/<task>` (`wt-<id>` se la riga non ha task) prima di liberare o abbandonare un checkout e rimuovere solo con `git worktree remove` (il `rm` vale solo per i fantasmi: senza `.git`, non elencati da git, a due livelli sotto la radice, mai un link). `create` SHALL scrivere il marcatore `.git/worktrees/<id>/topics-owner` (mai `git config`) e prendere `git worktree lock --reason topics:<nome>`, che `delete` toglie prima di rimuovere; un lock con un'altra ragione NON SHALL mai essere tolto e `delete` lo rifiuta. Una riga che fallisce 3 passate di fila SHALL essere lasciata stare fino al riavvio. Il GC SHALL girare 120 s dopo l'avvio, ogni 30 minuti e a ogni `create` oltre il tetto, e `POST /__daemon/worktree-gc?dryRun=1` SHALL elencare per cartella classe, azione e peso senza toccare niente.

#### Scenario: l'anteprima non cambia niente
- **GIVEN** una radice con una worktree unita, una sporca e una fantasma
- **WHEN** si chiama il GC con `dryRun=1`
- **THEN** la risposta SHALL dare classe e azione di ciascuna e il disco e il DB SHALL restare identici

#### Scenario: la barra del disco
- **GIVEN** la radice reale dopo un giro di GC
- **WHEN** gira `bun scripts/worktree-orphans.ts --check`
- **THEN** SHALL uscire 1 se resta un fantasma, un orfano non registrato o una riga senza cartella, o se la scansione supera 2 secondi

### Requirement: WORKTREE-STD-04 — I tetti per progetto e il target di Rust condiviso

Oltre il tetto di worktree per progetto il GC SHALL prima alleggerire (slim) le worktree in review o backlog non vive, poi rimuovere la più vecchia tra quelle ammesse. Con `cargo_target_mode = shared` l'ambiente dell'agente SHALL ricevere `CARGO_TARGET_DIR={radice}/_cache/cargo/{slug}`, uno per progetto; con `per-worktree` NON SHALL ricevere nulla.

#### Scenario: oltre il tetto
- **GIVEN** un progetto con tetto 2 e tre worktree ammesse alla rimozione di età diverse
- **WHEN** gira il GC
- **THEN** SHALL restare in numero il tetto e SHALL essere stata rimossa la più vecchia, dopo lo slim delle ferme

#### Scenario: il target condiviso
- **GIVEN** `cargo_target_mode = shared`
- **WHEN** parte un agente su una worktree del progetto `p`
- **THEN** il suo ambiente SHALL avere `CARGO_TARGET_DIR` uguale a `{radice}/_cache/cargo/p`

### Requirement: WORKTREE-STD-05 — Una worktree non è mai un progetto

`canonicalProjectFor(path)` SHALL fare `realpath` del percorso, leggere la common dir git e restituire l'id del progetto il cui `path` ha la stessa common dir; la dispatcher, l'adozione di una sessione, l'aggancio automatico e `POST /api/projects` SHALL usarla, così che un percorso di worktree (o un alias di cartella) NON SHALL più creare un progetto con la sua board. Una cartella sparita SHALL riconoscersi dal segmento `{radice}/{slug}/`.

#### Scenario: tre vie, lo stesso progetto
- **GIVEN** un progetto per un repo, una sua worktree, un link simbolico al repo e una worktree la cui cartella non esiste più
- **WHEN** si chiede il progetto canonico di ciascuno
- **THEN** SHALL tornare sempre l'id del progetto del repo

### Requirement: WORKTREE-STD-06 — I repo fratelli si accorpano o si separano, senza toccare le card

`projects.parent_id` e `projects.merge_mode` (`accorpa` | `separa`, default `accorpa`) SHALL stare sul progetto figlio, con un interruttore nel menu del progetto e nelle sue impostazioni. La board del padre SHALL includere le card del padre e dei figli `accorpa`, ciascuna col figlio come etichetta; la sidebar SHALL mostrare i topic dei figli `accorpa` sotto il padre; `separa` SHALL lasciare tutto com'è. Nessuna riga di `tasks` e nessun `project_path` esistente SHALL cambiare; la migrazione SHALL assegnare `parent_id` ai progetti-worktree già presenti dalla common dir o dal segmento della radice.

#### Scenario: accorpa e separa
- **GIVEN** un progetto padre con 3 card e un figlio con 9, entrambi su `accorpa`
- **WHEN** si guarda la board del padre, poi si imposta il figlio su `separa`
- **THEN** la board SHALL mostrare 12 card con l'etichetta del figlio su 9, poi 3; la tabella `tasks` SHALL risultare identica byte per byte

### Requirement: WORKTREE-STD-07 — Le worktree fuori radice si adottano o si spostano con anteprima

«Adotta» SHALL creare una riga `mode: "reuse"` così che il GC la veda. «Sposta» SHALL usare `git worktree move` e `repair` e SHALL rifiutare una worktree sporca, con sottomoduli o con sessione viva, dando prima un'anteprima di cosa farebbe. Dopo lo spostamento `git worktree list` SHALL combaciare con la riga. La UI SHALL contare le worktree esistenti fuori radice («fuori radice: N»).

#### Scenario: lo spostamento rifiutato
- **GIVEN** una worktree fuori radice con un file modificato
- **WHEN** si chiede di spostarla
- **THEN** SHALL rispondere col motivo e restare dov'è; pulita e senza sessione viva SHALL spostarsi e la riga SHALL indicare il nuovo percorso

### Requirement: WORKTREE-STD-08 — Una porta di registrazione per i worktree fatti da altri, aperta solo dal token degli hook

`POST /api/worktrees/register` (`{path, creator, session?, branch?, name?}`) SHALL registrare un worktree creato da un altro strumento ed SHALL essere idempotente sul percorso: la seconda chiamata SHALL restituire la stessa riga senza crearne un'altra. Un repository che nessun progetto conosce SHALL avere risposta 202 `{class:"inventory"}` e NON SHALL scrivere niente, né nel DB né nel `.git` di quel repository. Dentro la radice SHALL nascere una riga `ready` con `source` = creatore e `session_ref`, e il marcatore v2 SHALL essere scritto o completato; fuori dalla radice SHALL nascere una riga `reuse` e NON SHALL essere scritto alcun marcatore. Un checkout principale, un percorso relativo o un creatore `topics` o sconosciuto SHALL essere rifiutati con 400. `GET /api/worktrees/placement?repo=` SHALL restituire `{root, slug, projectId}` applicando l'impostazione della radice; `POST /api/worktrees/unregister` SHALL dimenticare la riga di una cartella che non c'è più e SHALL rifiutare con 409 una cartella ancora presente. Le tre rotte SHALL richiedere il token degli hook (`claude-hooks/hook-token`) e una richiesta indirizzata a questa macchina; una credenziale delegata di nodo o un ospite SHALL essere rifiutati con 403 anche col token giusto, e senza token o con un token sbagliato la risposta SHALL essere 401, sempre prima di qualunque effetto. La tabella `worktrees` SHALL avere `source TEXT NOT NULL DEFAULT 'topics'` e `session_ref TEXT`; le righe esistenti SHALL leggersi `topics`. Adottare una sessione avviata in un worktree sotto la radice SHALL riuscire se quel percorso ha una riga o un marcatore, e SHALL restare rifiutato per una cartella che non ha né l'una né l'altro.

#### Scenario: chi può aprire la porta
- **GIVEN** una richiesta di registrazione valida
- **WHEN** arriva senza token, con un token sbagliato, da una credenziale delegata, da un ospite o indirizzata a un altro host
- **THEN** la risposta SHALL essere 401 o 403 e nessuna riga né marcatore SHALL essere scritto; col token degli hook da questa macchina SHALL nascere la riga, una volta sola

#### Scenario: un repository ignoto
- **GIVEN** un worktree di un repository che nessun progetto conosce
- **WHEN** si chiede di registrarlo
- **THEN** la risposta SHALL essere 202 `inventory` e il DB e la cartella amministrativa del worktree SHALL restare identici

### Requirement: WORKTREE-STD-09 — Marcatore v2, lock per creatore e i due archivi

Il marcatore `topics-owner` SHALL accettare i campi opzionali `creator`, `session {id, transcript?}` e `machine`; un marcatore v1 SHALL continuare a leggersi e un creatore ignoto SHALL leggersi `adopted`. Il motivo di un lock SHALL nominare chi l'ha preso (`<creatore>:<etichetta>`) e solo i prefissi registrati (`topics:`, `claude-code:`) SHALL avere una regola: un lock con un prefisso che nessuno ha registrato NON SHALL mai essere tolto. Un lock `claude-code:<sessione>` SHALL essere tolto solo se il marcatore dice `creator: claude-code` con la stessa sessione, il transcript non cambia da `worktree_abandon_days`, l'albero è pulito, ogni commit è su un remote e il worktree ha più di 24 ore; un fatto che non si legge vale no. Una cartella senza riga sotto la radice con un marcatore v2 di un progetto noto SHALL essere registrata subito, senza aspettare 24 ore. Quando decide se un commit è già archiviato il GC SHALL leggere entrambi gli spazi, `refs/topics/archive/*` e i tag `archive/wt-*`.

#### Scenario: il lock di una sessione finita
- **GIVEN** due worktree con lock `claude-code:`, uno con transcript fermo da 10 giorni e uno vivo, entrambi puliti e pushati
- **WHEN** il GC applica la regola
- **THEN** SHALL togliere il lock del primo e lasciare quello del secondo; un lock `codex:` SHALL restare in ogni caso

### Requirement: WORKTREE-STD-10 — Le regole di percorso valgono anche su Windows

Il confronto fra una cartella e i cwd vivi (terminali, sottoagenti, processi avviati da Topics) SHALL usare `isInsideDir` con le regole della piattaforma, mai un separatore `/` aggiunto a mano. `canonicalPath` SHALL usare il realpath nativo su Windows e il confronto fra percorsi SHALL ignorare le maiuscole lì, così due grafie dello stesso percorso SHALL portare alla stessa riga. `POST /api/worktrees/relocate` SHALL accettare un percorso assoluto di Windows (`C:\…`) e rifiutare quello relativo al disco (`C:repo`). Ogni `git worktree add` su Windows SHALL portare `-c core.longpaths=true`. Su Windows un `EBUSY` o `EPERM` nella rimozione SHALL valere «vivo»: la riga resta, il giro dopo riprova, nessun secondo `--force` né `rm`. Ogni regola SHALL ricevere la piattaforma come parametro, così che sia provata su qualunque macchina.

#### Scenario: un cwd di Windows sotto la cartella
- **GIVEN** un terminale vivo con cwd `C:\…\worktrees\repo\x\packages\a`
- **WHEN** il GC chiede se qualcuno è dentro `C:\…\worktrees\repo\x` con piattaforma `win32`
- **THEN** la risposta SHALL essere sì

### Requirement: WORKTREE-STD-11 — Il nodo riferisce, il primario decide la policy, il nodo esegue

Ogni server Topics SHALL restare l'unico che scrive la propria tabella `worktrees` e tocca il proprio disco; il primario SHALL tenere solo un riepilogo per macchina in `machines.worktree_summary` (`{supported, summary:{root, count, bytes, rootFreeGb, foreign, ghosts, orphans, scanMs, at}}`), scritto dal giro di heartbeat e solo quando cambia. `GET /api/version` SHALL dichiarare `worktreeStandard: 1`; un nodo che non lo dichiara SHALL essere registrato come vecchio e saltato senza chiamarlo e senza errore, e la UI SHALL dirlo. Sul nodo: `GET /api/nodes/worktrees[?list=1]` SHALL rispondere subito con l'ultima misura (nulla finché non c'è la prima; una misura scaduta ne avvia una nuova in background, una alla volta); `PUT /api/nodes/worktree-policy` (`root`, `maxPerProject`, `diskFloorGb`, `gcForeign`, `abandonDays`, `cargoTargetMode`, `dryRun?`) SHALL scrivere nelle impostazioni del nodo con le stesse regole di `PUT /api/app-settings`, e una policy fuori schema (chiave ignota, tipo sbagliato, valore rifiutato, corpo vuoto o non oggetto) SHALL dare 400 senza scrivere niente; `POST /api/nodes/worktrees/gc` SHALL lanciare la passata del nodo, e con `dryRun=1` SHALL restituire l'anteprima senza scrivere niente. Nessuna rotta SHALL rimuovere un percorso ricevuto dal chiamante: l'unica rimozione è la passata del GC del nodo col suo contratto di sicurezza. Le tre rotte SHALL accettare solo la credenziale del primario che tiene il canale del nodo o il proprietario della macchina; una credenziale delegata SHALL essere rifiutata con 403 prima di qualunque effetto, anche col ruolo di proprietario, e così un ospite. Sul primario `GET /api/machines/worktrees` SHALL dare una riga per macchina (questa per prima, misurata qui) e `PUT /api/machines/:id/worktree-policy` / `POST /api/machines/:id/worktree-gc` SHALL controllare la forma della policy prima di chiamare il nodo e inoltrare con la credenziale del nodo, mai con una delegata. Impostazioni > Worktree SHALL mostrare per ogni macchina worktree, GB, spazio libero sotto la radice e «fuori radice».

#### Scenario: chi può chiedere
- **GIVEN** le tre rotte del nodo
- **WHEN** arriva una credenziale delegata (anche con ruolo di proprietario), un ospite o un nodo che non tiene il canale
- **THEN** la risposta SHALL essere 403 e nessuna misura, policy o passata SHALL partire

#### Scenario: anteprima e fuori schema
- **GIVEN** una policy con `dryRun: true`, una con una chiave ignota e una con `root: "/tmp/wt"`
- **WHEN** il primario le manda al nodo
- **THEN** la prima SHALL rispondere prima/dopo senza scrivere, le altre due SHALL dare 400 e le impostazioni del nodo SHALL restare identiche

#### Scenario: un nodo vecchio
- **GIVEN** un nodo la cui `/api/version` non dichiara `worktreeStandard`
- **WHEN** gira l'heartbeat o si chiede una policy o una passata
- **THEN** il nodo SHALL non ricevere nessuna chiamata di worktree, la riga SHALL dire «nodo vecchio» e la risposta SHALL essere 200 `skipped`

### Requirement: WORKTREE-STD-12 — Il bundle che porta un repo a un nodo non resta sul primario

`node-pool` (`deploy/cloud-node/node-pool`, `sync_repo`) SHALL togliere il bundle locale in ogni esito, anche quando `scp` fallisce o scade, e il nodo SHALL togliere il suo appena lo script finisce. All'inizio di ogni `giro` e di ogni `hook` SHALL togliere dalla cartella di stato i `*.bundle` il cui processo non c'è più o più vecchi di un'ora, lasciando quelli di un trasferimento vivo.

#### Scenario: scp fallito
- **GIVEN** un `sync_repo` il cui `scp` esce non zero
- **THEN** la cartella di stato SHALL non contenere alcun `.bundle`; un bundle di un processo morto SHALL sparire al giro dopo, uno di un processo vivo e recente SHALL restare

### Requirement: WORKTREE-STD-13 — L'hook WorktreeCreate / WorktreeRemove di Claude Code mette i worktree nella radice

`scripts/claude-hooks/worktree-hook.sh create` SHALL leggere dal payload di Claude Code `name`, `cwd`, `session_id` e `transcript_path`, creare il worktree in `{radice}/{slug}/{nome}` (radice e slug da `GET /api/worktrees/placement`, oppure `TOPICS_WORKTREES_DIR` o `{TOPICS_HOME}/worktrees` e il nome della cartella del repository quando il server non risponde) sul ramo `worktree-<nome>` da `origin/HEAD` (dopo un fetch di al più 5 secondi; `HEAD` senza remote), copiare i file di `.worktreeinclude` che sono anche ignorati da git, scrivere il marcatore v2 con `creator: claude-code`, sessione, transcript e macchina, prendere il lock `claude-code:<sessione>`, registrarlo con `POST /api/worktrees/register` e stampare il percorso come ultima riga dello stdout, tutto il resto su stderr. Un nome SHALL essere ridotto alla regola `^[a-z][a-z0-9-]{0,63}$` (`Feature/X+Y` → `feature-x-y`); una cartella altrui con lo stesso nome SHALL far scegliere `-2`; la stessa richiesta ripetuta SHALL ristampare lo stesso percorso senza un secondo worktree. Con Topics spento il worktree SHALL nascere lo stesso; con la radice non scrivibile SHALL nascere in `<repo>/.claude/worktrees/<nome>`. `remove` SHALL scrivere prima il tag `archive/wt-<nome>` sull'HEAD e, se non si rilegge uguale, NON SHALL rimuovere niente; poi SHALL togliere cartella e ramo `worktree-<nome>` (solo se punta ancora all'HEAD archiviato) e chiamare `unregister`. Su un checkout principale o su un lock con un prefisso diverso da `claude-code:` SHALL uscire 1 senza toccare niente. Le sessioni Claude che Topics avvia (chat, board, terminali) SHALL portare la coppia di hook nel loro unico `--settings`, sincrona, con timeout 120 e 60 secondi, salvo `claude_worktree_hooks = off` (default `topics`); `install-claude-hooks.ts install --worktrees` SHALL aggiungerla una volta sola al `settings.json` globale e `uninstall` SHALL toglierla.

#### Scenario: Topics spento
- **GIVEN** un repository e `TOPICS_HOME` temporanei, nessun server
- **WHEN** Claude Code chiama l'hook con `name: "Feature/X+Y"`
- **THEN** l'ultima riga dello stdout SHALL essere `{TOPICS_HOME}/worktrees/{slug}/feature-x-y`, il marcatore SHALL dire `creator: claude-code` e `git worktree list` SHALL mostrarlo con il lock `claude-code:<sessione>`

#### Scenario: rimozione
- **GIVEN** quel worktree
- **WHEN** Claude Code chiama `remove`
- **THEN** il tag `archive/wt-feature-x-y` SHALL puntare al suo HEAD e cartella e ramo SHALL essere spariti; sul checkout principale o su un lock `codex:` l'uscita SHALL essere 1 e la cartella SHALL restare

### Requirement: WORKTREE-STD-14 — Una porta per ogni altro strumento: `topics-worktree` e l'hook git `post-checkout`

`scripts/topics-worktree` SHALL usare la stessa libreria dell'hook: `add <percorso del repo|progetto> [nome]` SHALL creare `{radice}/{slug}/{nome}` col marcatore v2 del creatore dato da `TOPICS_WORKTREE_CREATOR` (default `adopted`) e senza lock, `register <percorso>` SHALL registrare un worktree esistente, `list` SHALL elencare i worktree sotto la radice col loro creatore. Un progetto per nome SHALL richiedere il server (`GET /api/worktrees/placement?project=` restituisce anche `repo`), un percorso no. L'hook git opzionale `scripts/git-hooks/post-checkout-register` SHALL registrare il nuovo worktree di un `git worktree add` nudo (HEAD precedente tutto zeri, `.git` file), SHALL ignorare ogni altro checkout e il clone, SHALL saltare i worktree che l'hook di Claude Code crea da sé (`TOPICS_WORKTREE_REGISTER=skip`) e SHALL uscire 0 in ogni caso, anche senza server: non SHALL mai bloccare git.

#### Scenario: un `git worktree add` a mano
- **GIVEN** `core.hooksPath` con `post-checkout-register` e un server Topics
- **WHEN** si fa `git worktree add -b x <cartella>`
- **THEN** il server SHALL ricevere una sola registrazione con quel percorso; senza server git SHALL uscire 0 e la cartella SHALL esserci
