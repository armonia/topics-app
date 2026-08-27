## Purpose

Come il lavoro di un agente arriva davvero su `main`, e come si dice se ci è
arrivato. È il pezzo che sta fra «la card è in Done» e «il codice è nel
prodotto», e finora era l'unico pezzo del percorso di un task a non essere
descritto da nessuna parte: nelle spec non compariva né «land» né «automerge»,
e `KANBAN-11` copre soltanto la verifica delle *rivendicazioni* di un rapporto
di consegna — cioè quello che l'agente DICE, non quello che è successo.

## Background

Un agente non lavora su `main`: lavora in una worktree, su un ramo `topics/*`.
Fra quel ramo e il prodotto ci sono tre domande distinte, e i moduli di questa
capability rispondono a una ciascuna:

- **Che cosa c'è su questo ramo?** (`own-commits`, `task-diff-range`,
  `branch-inventory`, `delivery-branch-ref`) — quali commit sono suoi e non
  ereditati da `main`, e quale intervallo di diff mostrare a chi rivede.
- **Ci è arrivato?** (`branch-status`, `landing-audit`, `landing-verdict`) — e
  la risposta non è un booleano: uno squash-land cancella l'ancestralità, quindi
  «il ramo è dentro main» e «il contenuto del ramo è dentro main» sono due
  domande diverse e solo la seconda è quella giusta.
- **Portacelo.** (`task-automerge`, `landing-queue`) — il gesto che unisce, e la
  fila che lo serializza.

MISURATO IL 25/08/2026, ed è il motivo per cui questa capability nasce con dei
numeri dentro: su 286 carte `done` con un commit di consegna registrato dal
sistema, 213 (il 74%) puntano a un oggetto che nel repo non esiste più. Il land
fa `git branch -D`, il land è uno squash, e da lì il commit dell'agente non è
raggiungibile da nessun ref: `git fsck --unreachable` ne trova zero. Il percorso
funziona; è la sua TRACCIA che evapora, e senza traccia «consegnato» non è più
una cosa che si possa verificare a posteriori.

## Requirements

### Requirement: LAND-01 — «Atterrato» si legge dal CONTENUTO, non dall'ancestralità

Il sistema SHALL rispondere a «questo ramo ha ancora qualcosa da perdere?» con
uno di tre stati — `gone`, `merged`, `unmerged` — e SHALL considerare `merged`
un ramo in DUE casi distinti, non uno solo:

1. la punta del ramo è un antenato git di `main` (merge classico, fast-forward);
2. il ramo è stato portato con uno SQUASH: la sua punta non è un antenato, ma
   ogni file SORGENTE che ha toccato è già byte-per-byte identico su `main`.

Il secondo caso non è una raffinatezza: lo squash è la strada NORMALE di questo
prodotto, quindi senza di esso nessun ramo atterrato risulterebbe mai atterrato,
e worktree e rami si accumulerebbero per sempre.

Il confronto SHALL ignorare i percorsi generati, i lockfile e le versioni in
lockstep (`bun.lock`, `package-lock.json`, `Cargo.lock`, `package.json`,
`tauri.conf.json`, `Cargo.toml`, e tutto sotto `public/`, `dist/`,
`node_modules/`). Ogni ramo differisce in quei file — versione auto-incrementata,
bundle ricostruito, dipendenze rilockate — e contarli renderebbe il secondo caso
impossibile da raggiungere. Un cambio di dipendenze vero si vede anche nel
sorgente, quindi ignorare il manifest non nasconde lavoro.

#### Scenario: ramo unito nel modo classico
- **GIVEN** un ramo la cui punta è antenato di `main`
- **WHEN** se ne chiede lo stato
- **THEN** lo stato SHALL essere `merged`

#### Scenario: ramo portato con squash
- **GIVEN** un ramo la cui punta NON è antenato di `main`
- **AND** ogni file sorgente che quel ramo ha cambiato è identico su `main`
- **WHEN** se ne chiede lo stato
- **THEN** lo stato SHALL essere `merged`
- **AND** questo SHALL valere anche quando il commit dell'agente non esiste più
  come oggetto, purché il suo contenuto sia riconoscibile su `main`

#### Scenario: solo rumore generato
- **GIVEN** un ramo che, tolti i percorsi generati e i lockfile, non cambia
  nessun file sorgente
- **THEN** lo stato SHALL essere `merged`: non c'è niente da perdere

#### Scenario: il ramo non c'è
- **GIVEN** un nome di ramo vuoto, o un ref che non risolve
- **THEN** lo stato SHALL essere `gone`
- **AND** «non c'è» e «non ho potuto guardare» NON SHALL essere lo stesso
  valore: chi compone un messaggio di abbandono deve poterli distinguere,
  perché il primo è un allarme e il secondo è ignoranza

#### Scenario: il gemello riconosciuto dall'oggetto del commit
- **GIVEN** un commit ricopiato su `main` dal land, con lo stesso oggetto e lo
  stesso istante di autore
- **WHEN** se ne cerca il gemello
- **THEN** la ricerca SHALL essere a stringa fissa e non a espressione regolare:
  l'oggetto di un commit è prosa e contiene parentesi, backtick e accenti, che
  come regex sarebbero un'altra domanda — e a volte un errore

### Requirement: LAND-02 — I commit PROPRI, e non quelli della sessione accanto

Il sistema SHALL isolare i commit che appartengono a un task da quelli che il
suo ramo ha semplicemente ereditato, e SHALL farlo sottraendo esplicitamente gli
altri rami locali (`main..<ramo> --not <altri>`), non con `merge-base`. Un
worktree nasce dall'`HEAD` del checkout condiviso e non da `main`: quello che
`merge-base` chiama «il lavoro di questo ramo» include il lavoro di chiunque
altro fosse parcheggiato lì.

Ogni funzione di questa famiglia SHALL distinguere TRE risposte e mai due:
il valore, `0`/`[]`/`false` come esito VERIFICATO, e `null` come «non
contabile» — ramo assente, `main` che non risolve, cartella che non è un repo,
git che ha sbagliato. Collassare «non lo so» su «zero» trasforma l'ignoranza in
una misura, e la misura in un'accusa.

Il commit di RESIDUO che la potatura del worktree lascia — soggetto letterale
`Residuo non committato, messo al sicuro dalla potatura` — NON SHALL contare
come lavoro proprio, e il filtro SHALL essere a stringa fissa.

La gamma di diff da mostrare a chi rivede SHALL avere tre sorgenti in ordine di
autorità — `worktree`, `landed-merge`, `delivery-commit` — e SHALL dichiarare
quale ha usato, perché solo la prima include l'albero di lavoro.

#### Scenario: un ramo che eredita lavoro di un'altra sessione
- **GIVEN** un ramo nato dall'`HEAD` condiviso, con commit propri e commit altrui
- **WHEN** se ne elencano i commit o se ne misura il diff
- **THEN** SHALL comparire solo i commit propri, e la base SHALL essere il padre
  del più vecchio commit proprio — non il merge-base con `main`

#### Scenario: zero commit propri, verificato
- **GIVEN** un ramo che non ha commit propri
- **THEN** la risposta SHALL essere `[]` / `0` / `{commit: null, filesChanged: 0}`
- **AND** NON SHALL essere `null`, e NON SHALL essere il diff di qualcun altro

#### Scenario: non contabile
- **GIVEN** un ramo cancellato, un `main` che non esiste, o una cartella che non
  è un repository
- **THEN** la risposta SHALL essere `null`
- **AND** un `HEAD` staccato SHALL dare `null`, non zero

#### Scenario: un commit radice
- **GIVEN** un commit senza genitore
- **THEN** il confronto SHALL partire dall'albero vuoto ottenuto da git stesso,
  e NON da una costante sha1 — un repository sha256 non ce l'ha

#### Scenario: il ramo si chiama come un file esistente
- **GIVEN** un ramo il cui nome coincide con un percorso presente nell'albero
- **THEN** la domanda SHALL essere normalizzata a `refs/heads/<nome>`, così che
  git non debba indovinare se si intende il file o il ramo

### Requirement: LAND-03 — Si pubblica il ramo CONSEGNATO, e la deriva si dichiara

Il sistema SHALL scegliere il ramo da portare su `main` preferendo, quando
esiste, quello registrato sulla card al momento della consegna, e non la punta
del worktree vivo. La catena `task → topic → worktree` si rompe da sola —
ri-dispatch, GC, liberazione del checkout — e il ramo registrato è ciò che le
sopravvive.

Ogni scostamento fra ciò che è stato consegnato e ciò che si sta portando SHALL
essere DICHIARATO invece di essere risolto in silenzio: ramo consegnato che non
esiste più, commit di consegna non più raggiungibile dopo una riscrittura,
N commit aggiunti dopo la consegna.

La risoluzione NON SHALL mai ripiegare sulla punta di `HEAD` del worktree: è
esattamente il difetto che l'isolamento dei commit propri esiste per non
ripetere.

Un ramo registrato che non esiste più SHALL dare «niente da guardare», non
«verificato: nessun commit proprio»: sono due risposte diverse e solo la seconda
autorizza un giudizio.

L'inventario dei rami SHALL abbinare un ramo a un task per ramo di consegna
prima che per worktree, e NON SHALL mai abbinare per somiglianza di nome: un
abbinamento sbagliato è peggio di nessun abbinamento.

#### Scenario: il worktree non c'è più
- **GIVEN** una card con un ramo di consegna registrato e nessun worktree vivo
- **THEN** il ramo SHALL essere risolto dalla card, e la cartella SHALL restare
  assente — mai ereditata dal ripiego

#### Scenario: il ramo vivo e quello consegnato divergono
- **GIVEN** un worktree vivo su un ramo diverso da quello consegnato, entrambi esistenti
- **THEN** SHALL essere pubblicato quello CONSEGNATO
- **AND** la differenza SHALL comparire come nota di deriva

#### Scenario: commit aggiunti dopo la consegna
- **GIVEN** un commit di consegna che è antenato della punta pubblicata, con N
  commit più recenti
- **THEN** la deriva SHALL dire quanti commit sono stati aggiunti DOPO la consegna

#### Scenario: nessun ramo da nessuna parte
- **GIVEN** una card senza worktree e senza ramo registrato, o con un ramo fatto
  di soli spazi
- **THEN** la risoluzione SHALL rispondere «nessuno», e NON SHALL interrogare git

### Requirement: LAND-04 — Portarlo su `main` senza toccare il lavoro di nessun altro

Il land SHALL essere una fusione, non uno schiacciamento del ramo dentro un
commit anonimo: `git merge --no-ff` anche quando sarebbe possibile un
fast-forward, perché il commit di merge è la traccia che rende l'atterraggio
verificabile a posteriori. Quando il ramo porta commit misti — propri ed
ereditati — SHALL essere pubblicato per `cherry-pick` dei soli commit propri,
conservando autore e messaggio originali.

Il land NON SHALL mai fondere sul checkout condiviso quando quel checkout non è
già su `main`: SHALL creare una worktree usa-e-getta pinnata a `main`, e SHALL
rimuoverla sempre, anche quando la fusione fallisce. Se il checkout È su `main`,
SHALL pretendere un albero pulito.

Un ramo INDIETRO rispetto a `main` SHALL essere riallineato fondendo `main`
DENTRO il ramo — mai il contrario — e il riallineamento SHALL avvenire prima
del controllo sulle collisioni di migration, così che i due lati vengano
confrontati dopo essere stati messi in pari. Un worktree con lavoro non
committato NON SHALL essere riallineato: non si fonde il WIP di qualcun altro.

Ogni motivo per cui il land non è avvenuto SHALL avere un CODICE, e il codice
SHALL decidere dove torna la card: i codici che descrivono una colpa del ramo
(commit non isolabili, commit estranei) riaprono la card all'agente con
un'istruzione di `git rebase main` — mai `git merge main` —; ogni altro codice,
compreso uno sconosciuto, la lascia all'umano in `review`. «Non c'era niente da
portare» e «il codice è fuori da `main`» NON SHALL essere la stessa risposta.

Il land NON SHALL fare `push`: è un'operazione locale.

#### Scenario: fusione pulita
- **GIVEN** un ramo avanti rispetto a `main`, senza conflitti
- **THEN** il land SHALL usare `--no-ff`, e il risultato SHALL essere `merged`

#### Scenario: conflitto
- **GIVEN** una fusione che entra in conflitto
- **THEN** SHALL essere eseguito `merge --abort` in ogni caso
- **AND** `main` NON SHALL essersi mosso
- **AND** un conflitto in fase di riallineamento SHALL nominare i file, non dire
  genericamente «conflitto»

#### Scenario: commit non isolabili
- **GIVEN** un ramo avanti rispetto a `main` di cui git non sa dire quali commit
  siano propri
- **THEN** il land SHALL fermarsi PRIMA di toccare `main`
- **AND** il motivo SHALL dire sia che non si sa quali siano i suoi, sia che non
  c'è niente da portare — sono due fatti e nessuno dei due basta da solo

#### Scenario: collisione di migration
- **GIVEN** un ramo e `main` che introducono una migration con lo stesso NOME
- **THEN** il land SHALL fermarsi prima di qualunque merge o cherry-pick
- **AND** due migration con lo stesso numero ma nomi diversi, o ereditate dallo
  stesso lato, NON SHALL contare come collisione

#### Scenario: il ramo non esiste più
- **GIVEN** una card il cui ramo è stato potato
- **WHEN** si tenta il land
- **THEN** SHALL essere cercata una prova che il lavoro sia già dentro, nell'ordine:
  discendenza del commit di consegna, identità del suo CONTENUTO su `main`, un
  commit di merge che nomina la card, un commit su `main` con il titolo esatto
  della card (confronto a stringa fissa, e un titolo vuoto non combacia con nulla)
- **AND** solo se nessuna prova passa SHALL essere dichiarato «ramo mancante»

#### Scenario: un cherry-pick che non ha su cosa appoggiarsi
- **GIVEN** un cherry-pick che fallisce perché manca un commit di base
- **THEN** l'esito SHALL distinguere questo caso da un conflitto vero, e dirlo

### Requirement: LAND-05 — Il verdetto di atterraggio accusa solo quando ha una prova

Il sistema SHALL tenere su ogni card chiusa uno di quattro stati —
`landed`, `unlanded`, `unverifiable`, `superseded` — e SHALL trattarli come
asimmetrici: `unlanded` è l'unico che ACCUSA, e ogni dubbio SHALL cadere su
`unverifiable`. Un commit potato, un progetto che non risolve, un verdetto non
decidibile o una supersessione sospetta SHALL dare `unverifiable`, mai
`unlanded`.

`superseded` NON SHALL mai essere prodotto dall'audit: lo scrive soltanto un
gesto umano esplicito, e l'audit SHALL lasciare in pace le card che lo portano.
Un rifiuto NON SHALL scriverlo nemmeno se richiesto.

L'audit SHALL poter RITIRARE un'accusa: una card marcata `unlanded` SHALL
restare fra i candidati anche quando non ha un commit registrato, altrimenti
l'accusa resta in piedi per sempre proprio nel caso in cui è stata scritta per
primo.

Prima di accusare, il sistema SHALL fare una seconda domanda — più costosa e
pagata SOLO su chi la prima dà per fuori — che cerca il contenuto del ramo
dentro `main` per identità delle righe, non per discendenza. Uno squash-land,
un cherry-pick, o una riga finita in un altro file devono poter assolvere.

Il verdetto NON SHALL mai essere `landed` quando la fusione dice sì e `main`
dice di no: se `main` non risponde, la risposta è `unverifiable`.

L'audit SHALL trasmettere un aggiornamento solo per le card il cui stato è
CAMBIATO, e SHALL dire nel log quando non ha risolto niente, invece di tacere.

#### Scenario: uno squash-land non è un'accusa
- **GIVEN** un ramo il cui contenuto è su `main` ma la cui discendenza dice di no
- **THEN** il verdetto SHALL essere `landed`

#### Scenario: il commit non c'è più
- **GIVEN** una card il cui commit di consegna è stato potato
- **THEN** il verdetto SHALL essere `unverifiable`
- **AND** un commit di merge che nomina la card SHALL poterla assolvere lo stesso
- **AND** quel merge NON SHALL ribaltare un `unlanded` già provato da un commit,
  né ripagare un `landed` già dato

#### Scenario: `main` ha rifatto lo stesso lavoro
- **GIVEN** un ramo i cui file sono stati tutti riscritti su `main` dopo la sua
  data, e il cui merge entrerebbe in conflitto
- **THEN** il verdetto SHALL essere «superato», e SHALL nominare il commit che
  ha superato — quello che tocca PIÙ file, e a parità il più recente
- **AND** un ramo che aggiunge in fondo a un file toccato altrove NON SHALL
  essere dichiarato superato

#### Scenario: la soglia è una misura, non un'opinione
- **GIVEN** il confronto per contenuto fra ramo e `main`
- **THEN** la decisione SHALL richiedere un numero minimo di righe distintive
  cercate, sotto il quale la risposta è «non decidibile» e non «fuori»

### Requirement: LAND-06 — Una fila per checkout, e nessun land in parallelo

Il land SHALL essere serializzato per repository: tutte le fusioni toccano lo
stesso checkout, quindi due land insieme si guastano a vicenda. La fila SHALL
essere FIFO dentro la propria chiave, e chiavi diverse SHALL poter scorrere in
parallelo.

Due richieste di land per lo STESSO task SHALL restituire lo STESSO biglietto
invece di accodarne un secondo: il doppio clic è un gesto solo.

Un lavoro che esplode SHALL chiudere il PROPRIO biglietto con l'errore e
lasciare che la fila prosegua.

La finestra dei biglietti SHALL essere limitata, ma un biglietto ANCORA APERTO
NON SHALL mai essere scartato da quel limite.

#### Scenario: raffica
- **GIVEN** N richieste di land accodate sulla stessa chiave
- **THEN** SHALL uscire N esiti, e nessuno SHALL sovrapporsi a un altro

#### Scenario: doppio clic
- **GIVEN** due richieste per lo stesso task, la prima ancora in corso
- **THEN** la seconda SHALL ricevere il biglietto della prima

### Requirement: LAND-07 — Il verdetto si legge sulla SINGOLA card, e chi lo legge può agirci

Un totale in cima alla board NON SHALL essere l'unico posto in cui compare un
verdetto di mancato atterraggio: un totale non dice QUALE card. La card in `done`
SHALL dirlo da sé, e SHALL nominare il ramo su cui il lavoro è rimasto.

Il pannello di dettaglio SHALL ripetere l'avviso in cima E SHALL offrire
l'AZIONE che lo risolve. Un avviso senza il gesto corrispondente è una diagnosi
consegnata a chi non può curarla: il bottone che porta il lavoro su `main` era
recintato dentro lo stato di review, quindi la banda diceva «landa il ramo» e non
c'era niente da premere.

Una card in `done` il cui lavoro È su `main` NON SHALL portare nessun allarme.
Questa è la terza asserzione, e senza di lei le prime due passerebbero anche con
un avviso incollato su OGNI card — una board che grida sempre è l'altro modo di
mentire.

#### Scenario: lavoro non atterrato
- **GIVEN** una card in `done` il cui lavoro non è su `main`
- **THEN** la card SHALL dirlo e nominare il ramo, e il dettaglio SHALL offrire il gesto che risolve

#### Scenario: controllo negativo
- **GIVEN** una card in `done` il cui lavoro è su `main`
- **THEN** NON SHALL comparire nessun allarme

### Requirement: LAND-08 — La regola che autorizza a CANCELLARE si prova su repository veri

La regola che dichiara un ramo eliminabile SHALL essere provata su repository
VERI e minuscoli, non su finzioni: è l'unico posto dove si può sbagliare in modo
CARO.

Il caso che conta SHALL essere il ramo ATTERRATO PER SCHIACCIAMENTO, che il
criterio di antenato comune chiama vivo per sempre e che solo il criterio per
CONTENUTO riconosce: se quel caso si rompe, il mucchio dei rami non cala mai.

Il caso SIMMETRICO SHALL essere provato con la stessa cura: del LAVORO VERO letto
come atterrato significa cancellare qualcosa che serviva.

#### Scenario: un ramo atterrato per schiacciamento
- **GIVEN** un ramo il cui contenuto è già su quello principale
- **THEN** SHALL essere dichiarato eliminabile

#### Scenario: lavoro non ancora atterrato
- **GIVEN** un ramo con lavoro assente da quello principale
- **THEN** NON SHALL essere dichiarato eliminabile

### Requirement: LAND-09 — Il commit di consegna SHALL restare raggiungibile dopo il land

Il land schiaccia e poi cancella il ramo (`worktree-manager.ts`, `git branch -D`):
da quel momento il commit dell'agente non è raggiungibile da nessun ref, e la
prima potatura di git se lo porta via. Misurato il 22/08 su questa board: 213
`delivery_commit` su 286 puntano a un oggetto che nel repo non esiste più, e
`git fsck --unreachable` non restituisce niente.

Al momento in cui la consegna viene REGISTRATA, il sistema SHALL piantare un ref
che tiene vivo l'oggetto — `refs/consegne/<taskId>` sullo sha consegnato — PRIMA
di scrivere la colonna: la colonna è un puntatore, il ref è ciò che tiene in vita
la cosa puntata, e nell'ordine inverso un incidente in mezzo lascia quaranta
caratteri di niente.

Il ref SHALL essere piantato da OGNI porta che registra una consegna (la cattura
verso review e la passata di backfill), altrimenti resterebbero vive solo le
consegne fotografate col worktree ancora in piedi, cioè non quelle a rischio.

Un ref piantato non SHALL impedire una consegna: un errore di git si ingoia e la
card resta registrata comunque.

Il ref SHALL cadere quando la card è `done` da più della finestra di ritenzione
(default 90 giorni, la stessa di `gc.pruneExpire`; `0` = mai). Tutto ciò che non
si può datare — card sconosciuta al database, `done` senza data — SHALL essere
TENUTO: lasciar cadere è irreversibile, tenere costa 41 byte.

#### Scenario: consegna registrata, ramo cancellato, gc passato
- **GIVEN** una card consegnata e il suo ref di consegna piantato
- **WHEN** il ramo viene cancellato e git pota gli oggetti irraggiungibili
- **THEN** `git cat-file -t <delivery_commit>` SHALL rispondere `commit`

#### Scenario: senza il ref, sulla stessa sequenza
- **GIVEN** una card consegnata senza ref piantato
- **WHEN** il ramo viene cancellato e git pota gli oggetti irraggiungibili
- **THEN** il commit di consegna NON SHALL essere più leggibile

#### Scenario: card chiusa da più della finestra
- **GIVEN** una card `done` da più giorni della finestra di ritenzione
- **THEN** il suo ref di consegna SHALL essere lasciato cadere

#### Scenario: card che il database non conosce
- **GIVEN** un ref di consegna il cui task non è in questo database
- **THEN** il ref NON SHALL essere lasciato cadere
