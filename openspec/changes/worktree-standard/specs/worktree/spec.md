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
