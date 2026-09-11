## ADDED Requirements

### Requirement: LAYOUT-34 — «Ingrandisci» ha tre inneschi, e nessuno dei tre ruba un gesto gia' assegnato

Una conversazione SHALL poter riempire la superficie di tiling con un gesto, e
tornare indietro con lo stesso gesto. Gli inneschi SHALL essere tre: il doppio
clic sulla linguetta della tab, la voce «Ingrandisci» / «Riduci» nel menu
contestuale della tab (nella sezione degli split, dietro lo stesso cancello di
«Dividi a destra»), e ⌘E. NON SHALL esserci un bottone nuovo nella barra tab:
un'icona permanente su ogni barra e' chrome che si paga per sempre per un gesto
che si impara una volta. I tre inneschi GEMELLI che ingrandiscono la sola cella,
col modificatore, stanno in LAYOUT-40: sono lo stesso comando con un ambito piu'
piccolo, non un secondo comando.

Il doppio clic SHALL essere **stratificato sotto** il fissaggio dell'anteprima
che quel gesto ha gia': su una tab in anteprima fissa e basta, e solo su una tab
gia' fissata ingrandisce. Il significato dichiarato del gesto non cambia, scala:
la fissi, poi la isoli.

Una BOZZA non e' un'anteprima. E' aperta permanente, quindi `preview` e' falso, e
senza una regola esplicita cadrebbe nel ramo dell'ingrandimento mentre oggi il
doppio clic la marca soltanto. Una pane bozza NON SHALL essere ingrandibile.

Su una tab NON attiva il gesto fa DUE cose, e vanno dichiarate entrambe perche'
una prova che ne veda una sola e' verde per la ragione sbagliata: il primo dei
due clic attiva la pane e azzera il badge delle notifiche, e solo dopo la cella
si ingrandisce.

Il predicato di disponibilita' SHALL essere strutturale e valutato su CELLE, non
su pane, cosi' una chat che condivide la cella con la propria browser resta
ingrandibile. Ma il metro NON SHALL essere il set derivato: SHALL essere la CELLA
DELL'ANCORA, cioe' «esiste almeno una cella viva fuori dalla cella che ospita la
tab». Col metro sul set derivato il comando sparirebbe proprio dove serve di piu':
una chat con due browser e il terminale di un sotto-agente in una griglia a quattro
celle copre gia' tutto, e la funzione si spegnerebbe da sola nel suo caso migliore.

Quando il set derivato copre gia' tutte le celle vive il comando NON SHALL
sparire: DEGRADA. Il doppio clic semplice e la voce «Ingrandisci» fanno allora
quello che farebbe il modificatore di LAYOUT-40, cioe' ingrandiscono la sola cella
dell'ancora. L'innesco non e' mai un no-op silenzioso: o restringe la superficie a
qualcosa di piu' piccolo di quello che si vede adesso, o non c'e' proprio niente da
restringere, e allora il comando non compare.

Le due voci di menu di LAYOUT-40 SHALL restare ENTRAMBE offerte ogni volta che il
comando esiste, caso degradato compreso, dove fanno la stessa identica cosa.
Farne sparire una proprio li' rimetterebbe il contenuto del menu a dipendere dal
set derivato, cioe' dall'unico insieme che nessuna banda mostra: e' il difetto che
la degradazione toglie, rimesso dentro in piccolo.

Resta un caso solo in cui non si offre, ed e' quello in cui non esiste nessuna
cella da togliere: una superficie a cella sola. Li' il comando NON SHALL essere
offerto in nessuno dei suoi inneschi, col modificatore o senza. «Non offerto» NON
vuol dire «gesto inerte»: il doppio clic sulla linguetta SHALL continuare a fare
quello che fa oggi, cioe' fissare una tab in anteprima (TAB-SYNC-03) e marcare una
bozza come toccata. Quello e' il livello sotto, non e' mai stato dello zoom, ed e'
gia' coperto da contratti vivi che una superficie a cella sola esercita per
costruzione.

Sotto i 768px il comando NON SHALL esistere: li' una cella sola e' gia' la vista
di default, e il ramo desktop non viene nemmeno reso. Il predicato e' lo stesso
di LAYOUT-PRED-01.

#### Scenario: il gesto stratificato non ruba il fissaggio
- **GIVEN** una tab in ANTEPRIMA
- **WHEN** si fa doppio clic sulla sua linguetta
- **THEN** la tab SHALL essere fissata
- **AND** NON SHALL ingrandirsi

#### Scenario: una tab gia' fissata
- **GIVEN** una tab fissata e non-bozza in un layout a piu' celle
- **WHEN** si fa doppio clic sulla sua linguetta
- **THEN** la cella che la ospita SHALL riempire la superficie meno la cornice
- **AND** ripetendo il gesto SHALL tornare la griglia di prima

#### Scenario: una BOZZA non e' un'anteprima
- **GIVEN** una tab bozza, aperta permanente, con `preview` falso
- **WHEN** si fa doppio clic sulla sua linguetta
- **THEN** la bozza SHALL essere marcata come toccata, come oggi
- **AND** NON SHALL ingrandirsi, e il testo nel campo SHALL restare

#### Scenario: doppio clic su una tab di un'ALTRA cella
- **GIVEN** il fuoco su una cella diversa e un badge non letto sulla tab bersaglio
- **WHEN** si fa doppio clic su quella linguetta
- **THEN** la pane SHALL diventare attiva
- **AND** il badge SHALL sparire
- **AND** solo dopo la sua cella SHALL ingrandirsi

#### Scenario: il gesto non si offre solo quando non c'e' niente da togliere
- **GIVEN** una superficie a cella sola
- **THEN** ne' «Ingrandisci» ne' «Ingrandisci solo questa» SHALL comparire nel menu della tab
- **AND** ⌘E e ⌥⌘E NON SHALL ingrandire niente: la superficie SHALL restare senza cornice
- **AND** il doppio clic sulla linguetta, col modificatore o senza, SHALL fare quello che fa oggi: fissare una tab in anteprima, marcare una bozza come toccata

#### Scenario: il set copre gia' tutte le celle vive, e il gesto DEGRADA
- **GIVEN** una griglia a quattro celle vive dove una chat, le sue due browser e il terminale di un suo sotto-agente le occupano tutte
- **THEN** la voce «Ingrandisci» SHALL comparire nel menu della tab della chat
- **AND** accanto a lei SHALL comparire anche «Ingrandisci solo questa», che qui fa la stessa cosa
- **WHEN** si fa doppio clic su quella linguetta
- **THEN** SHALL restare visibile la SOLA cella che ospita la chat
- **AND** SHALL sparire le altre tre
- **AND** ripetendo il gesto SHALL tornare la griglia di prima

#### Scenario: sotto i 768px
- **GIVEN** una finestra sotto la soglia delle colonne
- **THEN** il comando NON SHALL esistere in nessuno dei suoi inneschi, col modificatore o senza
- **AND** il doppio clic sulla linguetta SHALL fare quello che fa oggi

### Requirement: LAYOUT-35 — Ingrandire cambia i PESI, non la forma dell'albero

L'ingrandimento SHALL essere ottenuto portando a peso zero e a `display:none` le
celle che non ospitano il set, lasciando che la cella superstite riempia la
superficie. NON SHALL usare un portale, `position: fixed`, `role="dialog"`, ne'
spostare nodi nell'albero React. L'albero delle righe, dei gruppi, delle pile e
dei pesi persistiti NON SHALL essere toccato: nessuna riconciliazione, nessuna
scrittura di persistenza, nessun tombstone.

Ne consegue l'invariante che va provato per primo: **entrare e uscire dallo zoom
NON SHALL rimontare nulla**. Un terminale non perde il suo PTY, una pagina non si
ricarica, una bozza non si svuota.

Le celle fuori zoom SHALL ricevere tre segnali e non uno: peso zero (cosi' il
divisore adiacente sparisce da solo), `display:none` sul wrapper di cella (cosi'
al ritorno scatta il ripristino dell'ancora di lettura della chat, che e' legato
al passaggio di `clientHeight` da 0 a un'altezza, e cosi' quelle celle escono da
tab-order e dall'albero di accessibilita'), e l'assenza di box propagata alle
pane che contengono (cosi' un xterm a viewport zero smette di misurare).

La cornice SHALL avere una misura dichiarata, non «un po' di margine»:
`--pane-zoom-inset`, mai sotto i 20px, ed e' il numero che una prova legge invece
di scegliere un punto a occhio. La banda SHALL avere un fondo dipinto, uguale con
i pannelli fluttuanti accesi e spenti; e la card ingrandita SHALL avere spigoli
quadri, perche' la maschera nativa non arrotonda nessun angolo che non sia a filo
finestra e una card tonda mostrerebbe una pagina squadrata dentro l'angolo.

Il velo SHALL essere l'unico elemento che copre la banda, SHALL essere fuori dal
percorso di tabulazione e nascosto all'albero di accessibilita', e SHALL portare
i propri attributi di NON-trascinamento: la prima banda in alto occupa il posto
che a riposo e' barra del titolo, e senza quegli attributi il «clic fuori»
diventerebbe un trascinamento della finestra.

Nessuna geometria SHALL essere animata. La sola opacita' del velo puo' esserlo, e
NON SHALL esserlo per chi ha chiesto meno movimento.

Mentre lo zoom e' attivo i divisori NON SHALL essere maniglie: ridimensionare
committerebbe pesi calcolati contro una banda che nel modello include anche le
celle a peso zero. E qualunque comando che RIORGANIZZI la griglia (dividere,
reimpostare, disporre, annullare un cambio di layout, iniziare a trascinare una
tab) SHALL uscire dallo zoom prima di applicarsi, cosi' la griglia che si vede e'
sempre quella su cui il comando agisce.

La cella ingrandita NON SHALL riservare lo spazio delle pastiglie native ne'
cambiare l'altezza della propria barra: non e' a filo finestra, le luci di sistema
stanno sopra la cornice. Il comando per riaprire la colonna SHALL vivere dentro
la cornice, cosi' resta raggiungibile anche ingrandendo una cella che non e'
quella in alto a sinistra.

#### Scenario: le celle fuori zoom non si rimontano
- **GIVEN** un terminale con un marcatore scritto, e una chat con una bozza nel campo, in una cella diversa
- **WHEN** si entra e si esce dallo zoom
- **THEN** l'elenco delle foglie e dei gusci di pane SHALL essere identico a prima
- **AND** il marcatore SHALL essere ancora leggibile e la bozza ancora nel campo
- **AND** i divisori SHALL essere tanti quanti prima

#### Scenario: uscita dalla cornice
- **GIVEN** lo zoom attivo e la misura dichiarata della cornice
- **WHEN** si clicca a meta' della banda
- **THEN** lo zoom SHALL chiudersi
- **AND** quel clic NON SHALL raggiungere la griglia sotto

#### Scenario: la cornice non trascina la finestra
- **GIVEN** lo zoom attivo su desktop
- **WHEN** si preme e si trascina sulla banda superiore
- **THEN** la finestra NON SHALL muoversi
- **AND** nessun elemento della cornice SHALL restare senza il proprio attributo di zona di trascinamento

#### Scenario: le celle collassate escono dalla tastiera
- **GIVEN** lo zoom attivo
- **WHEN** si tabula dall'inizio della superficie
- **THEN** nessun elemento delle celle fuori zoom SHALL ricevere il fuoco

#### Scenario: chi ha chiesto meno movimento
- **GIVEN** la preferenza di movimento ridotto
- **WHEN** si entra nello zoom
- **THEN** nulla SHALL essere animato

#### Scenario: geometria e trascinamento durante lo zoom
- **GIVEN** lo zoom attivo
- **WHEN** si prova a trascinare un divisore
- **THEN** la geometria NON SHALL cambiare, e uscendo lo zoom la griglia SHALL essere quella di prima
- **WHEN** invece si inizia a trascinare una tab, o si sceglie «Dividi», «Reimposta pannelli» o «Disponi»
- **THEN** lo zoom SHALL chiudersi PRIMA che il comando si applichi

#### Scenario: il comando per riaprire la colonna resta raggiungibile
- **GIVEN** la colonna chiusa e una cella che non e' quella in alto a sinistra
- **WHEN** la si ingrandisce
- **THEN** il comando di riapertura SHALL essere visibile dentro la cornice
- **AND** la cella ingrandita NON SHALL riservare lo spazio delle pastiglie native

#### Scenario: pannelli fluttuanti accesi
- **GIVEN** la modalita' fluttuante
- **WHEN** si ingrandisce
- **THEN** la cornice SHALL avere la larghezza dichiarata e un fondo dipinto, non un buco sul materiale nativo
- **AND** gli angoli della card SHALL essere quadri, come con il fluttuante spento

### Requirement: LAYOUT-36 — Si ingrandisce una CONVERSAZIONE, non una cella

L'ambito dell'ingrandimento SHALL essere la conversazione ancorata piu' le tab
che quella conversazione ha aperto: le pane browser che portano il suo contesto,
e i terminali dei suoi sotto-agenti. Ingrandire la sola cella lascerebbe fuori
proprio la meta' che l'agente ha appena prodotto, visto che l'auto-split manda la
browser in un gruppo accanto alla chat.

L'insieme SHALL essere derivato da identita' che gia' esistono e sono durevoli:
l'uguaglianza fra l'id della pane browser e il contesto della topic, il contesto
registrato sulla topic, e la sessione padre dei terminali. NON SHALL essere
introdotto nessun campo nuovo sulla pane: uscirebbe dallo snapshot e rientrerebbe
cancellato dalla whitelist di sanificazione, che e' un'asimmetria gia' pagata due
volte in questo repo.

Se la tab ancorata non e' una chat, l'ancora SHALL essere quella pane sola: il
maximize classico e' il caso degenere, non una funzione a parte.

L'insieme SHALL essere VIVO, ricalcolato a ogni render: una tab che l'agente apre
mentre si guarda entra da sola, che e' precisamente il momento in cui uno
snapshot congelato mentirebbe.

Il registro delle aperture che vive solo nella sessione della finestra SHALL
entrare in UNIONE e mai in sottrazione: dopo un riavvio dell'app l'insieme puo'
essere piu' piccolo, e il caso piu' piccolo e' comunque lo zoom della sola cella,
che e' una risposta sensata. Il prezzo va dichiarato qui perche' l'utente non ha
modo di vederlo: non esiste nessuna banda che elenchi le pane del set.

Aprire una pane NUOVA che non appartiene al set SHALL far uscire dallo zoom. Una
pane nasce visibile: e' l'unica regola che copre con una riga sola tutte le vie
di apertura, comprese quelle che non toccano il fuoco.

Lo zoom RIVELA, non riorganizza. Se due pane del set stanno nella stessa cella si
vede una cella con due tab, e i vicini di pila di una cella ingrandita vengono
con lei anche se non sono del set: spostare una pane fra celle sarebbe un cambio
di genitore React, cioe' un remount, cioe' PTY resettata e pagina ricaricata.

#### Scenario: la conversazione porta con se' cio' che ha aperto
- **GIVEN** una chat che ha fatto aprire all'agente una pane browser in una cella accanto
- **WHEN** si ingrandisce la chat
- **THEN** SHALL restare visibili la cella della chat e quella della browser
- **AND** SHALL sparire tutte le altre

#### Scenario: una tab che nasce mentre si guarda
- **GIVEN** lo zoom attivo su una conversazione
- **WHEN** l'agente apre una nuova browser per quella conversazione
- **THEN** la sua cella SHALL comparire dentro lo zoom
- **AND** lo zoom NON SHALL chiudersi

#### Scenario: una tab che NON e' della conversazione
- **GIVEN** lo zoom attivo
- **WHEN** si apre una pane nuova che non appartiene al set, per una qualunque via
- **THEN** lo zoom SHALL chiudersi
- **AND** in nessun caso la pane nuova SHALL nascere dentro una cella collassata

#### Scenario: riaprire una tab chiusa
- **GIVEN** lo zoom attivo e, chiusa poco prima senza avere il fuoco, una tab che non appartiene al set
- **WHEN** la si riapre con la scorciatoia
- **THEN** lo zoom SHALL chiudersi
- **AND** la pane riaperta SHALL essere visibile nella griglia tornata intera

### Requirement: LAYOUT-37 — Si esce da quattro vie, e lo stato di riposo e' «non ingrandito»

L'uscita SHALL essere possibile dal clic sulla cornice, dal gesto ripetuto, da
Escape, e automaticamente quando l'ingrandimento non ha piu' senso. Uscire SHALL
essere sempre senza perdita: e' azzerare un id, non ricostruire un layout.

**Escape resta dell'agente.** Il contenitore dello zoom NON SHALL essere una
superficie modale, quindi Escape SHALL prima interrompere un turno in streaming e
solo dopo chiudere lo zoom. Chi ingrandisce una chat lo fa per guardare l'agente
lavorare: togliergli il tasto che lo ferma e' il contrario dello scopo. Con un
turno vivo restano le altre tre vie, tutte a un clic. Un dialogo o una tavolozza
aperta SHALL avere la precedenza su entrambi.

Lo stato SHALL essere effimero, in memoria, per finestra, e uno per superficie:
uno zoom dentro un progetto annidato non cancella quello della griglia esterna.
NON SHALL essere persistito ne' sincronizzato. Lo stato dei pannelli e' condiviso
per chiave e trasmesso a tutti i dispositivi: uno zoom sincronizzato sarebbe una
modale che si apre da sola sul telefono perche' hai fatto doppio clic sul Mac. E
ogni scrittura armerebbe un invio dell'intero snapshot per un toggle.

L'uscita al cambio di Spazio e' VOLUTA e va scritta come tale, non scoperta: la
superficie si rimonta con la chiave dello Spazio, e sollevare lo stato piu' in
alto per «aggiustarla» farebbe attraversare lo zoom fra gruppi diversi.

Il set di celle SHALL essere potato a ogni render contro le celle vive: se
sparisce una pane del corredo il set si restringe, se sparisce l'ANCORA si esce.

#### Scenario: Escape resta dell'agente
- **GIVEN** una conversazione ingrandita con un turno in streaming
- **WHEN** si preme Escape
- **THEN** il turno SHALL essere interrotto
- **AND** lo zoom SHALL restare aperto

#### Scenario: Escape senza turno vivo
- **GIVEN** lo zoom attivo, nessun turno in streaming e nessun dialogo aperto
- **WHEN** si preme Escape
- **THEN** lo zoom SHALL chiudersi

#### Scenario: un modale sopra lo zoom
- **GIVEN** lo zoom attivo e la tavolozza dei comandi aperta
- **WHEN** si preme Escape
- **THEN** SHALL chiudersi la tavolozza
- **AND** lo zoom SHALL restare aperto

#### Scenario: l'ancora sparisce
- **GIVEN** lo zoom attivo
- **WHEN** la conversazione ancorata viene chiusa da qui, da un altro dispositivo, o spostata in un altro Spazio o in un'altra finestra
- **THEN** lo zoom SHALL chiudersi

#### Scenario: il fuoco va altrove
- **GIVEN** lo zoom attivo
- **WHEN** il fuoco si sposta su una pane che sta in una CELLA fuori dal set
- **THEN** lo zoom SHALL chiudersi
- **WHEN** invece si cambia tab DENTRO una cella del set
- **THEN** lo zoom NON SHALL chiudersi

#### Scenario: cambio di Spazio
- **GIVEN** lo zoom attivo
- **WHEN** si passa a un altro Spazio e si torna
- **THEN** nessuno dei due SHALL risultare ingrandito

#### Scenario: ricaricamento
- **GIVEN** lo zoom attivo
- **WHEN** si ricarica
- **THEN** lo stato di riposo SHALL essere «non ingrandito»
- **AND** nessuna cornice SHALL comparire sulla griglia non ancora idratata

#### Scenario: lo zoom non viaggia
- **GIVEN** due dispositivi sullo stesso account con la stessa griglia
- **WHEN** si ingrandisce su uno
- **THEN** sull'altro NON SHALL cambiare niente
- **AND** NON SHALL partire nessuna scrittura dello stato dei pannelli

### Requirement: LAYOUT-38 — Lo zoom non e' una superficie modale, e le viste di sistema lo sanno

Il contenitore dello zoom e il suo velo NON SHALL soddisfare il selettore delle
superfici modali ne' quello delle coperture native, attributi di ruolo compresi.
Non e' una preferenza di stile: qualunque contenitore che intersechi una pane
browser nativa la congela in una fotografia, e una modale vera mostrerebbe un
fermo-immagine della pagina che dice di ingrandire. Un test SHALL fallire il
giorno in cui qualcuno aggiunge un marcatore modale a uno dei due, e SHALL essere
scritto in una forma che veda anche gli ATTRIBUTI, non i soli nomi di classe.

Dentro lo zoom la vista nativa SHALL restare viva e interattiva, e SHALL seguire
il nuovo rettangolo. Il congelamento resta GEOMETRICO e va dichiarato per quello
che e': la pane ingrandita occupa quasi tutta la superficie, quindi ogni menu,
dropdown o suggerimento aperto la interseca e la congela, e la scongela
chiudendosi. Il menu contestuale della tab e' uno dei tre inneschi: il ciclo
congela, clic su «Ingrandisci», scongela e' il percorso NORMALE.

Fuori dallo zoom quello che la superficie di tiling DICE e' una cosa sola, ed e'
l'unica di sua competenza: una cella collassata non ha box. Il segnale SHALL
essere emesso come tale, cioe' nessun rettangolo positivo per quella cella e
l'assenza di box propagata alle pane che ospita, e sopra la cornice NON SHALL
comparire nessuna vista nativa di una cella collassata.

Che cosa la vista nativa FA con quel «niente box» sta in `NATIVEPARK-01` e
`NATIVEPARK-02`, nel delta di `remote-browser`, e non si riscrive qui: il
parcheggio come chiavistello, le cinque vie di ritorno che restano no-op, la
decisione di congelamento presa senza rettangolo invece che su una geometria
stantia, lo spegnimento dietro un guscio antenato nascosto, l'eccezione della pane
che un agente sta guidando, e il ritorno senza rimontaggio. Vive li' perche' vale
anche dove lo zoom non arriva (una tab di sfondo, una riga nascosta sotto i
768px, il tiling dentro il cassetto di un task), e perche' la stessa regola
raccontata in due spec approvate diverge al primo emendamento.

Il cassetto di un task monta lo stesso tiling e NON SHALL offrire lo zoom: e' gia'
una superficie sovrapposta, e due «fuori» annidati non sono un'interfaccia. Il suo
tiling SHALL pero' propagare l'assenza di box come ogni altra superficie, gusci
ANTENATI compresi e non solo la tab attiva del proprio gruppo: e' il segnale che
oggi non arriva, ed e' la sola meta' di quel cambio che il layout decide.

#### Scenario: lo zoom NON e' una superficie modale
- **GIVEN** il contenitore dello zoom e il suo velo
- **THEN** nessuno dei due SHALL soddisfare il selettore delle superfici modali ne' quello delle coperture native
- **AND** il controllo SHALL leggere anche gli attributi di ruolo, non i soli nomi di classe

#### Scenario: una vista di sistema DENTRO lo zoom
- **GIVEN** una pane browser nativa nella cella ingrandita
- **WHEN** lo zoom si apre
- **THEN** la vista SHALL seguire il nuovo rettangolo e restare interattiva
- **WHEN** un menu o un suggerimento la copre
- **THEN** il congelamento SHALL avvenire, e SHALL rientrare alla chiusura

#### Scenario: una cella collassata dichiara di non avere box
- **GIVEN** lo zoom attivo e una pane browser nativa in una cella collassata
- **THEN** il wrapper di quella cella SHALL essere fuori dal layout e la sua pane SHALL ricevere l'assenza di box
- **AND** per quella cella la superficie NON SHALL emettere nessun rettangolo positivo
- **AND** nessuna vista nativa SHALL comparire sopra la cornice

#### Scenario: dentro il cassetto di un task il comando non esiste, ma l'assenza di box si propaga
- **GIVEN** il cassetto di un task aperto con il suo tiling, e una sua browser dietro un guscio antenato nascosto
- **THEN** il comando «Ingrandisci» NON SHALL esistere li' dentro, in nessuno dei suoi inneschi
- **AND** il guscio nascosto SHALL propagare l'assenza di box fino a quella pane, invece di fermarsi alla tab attiva del proprio gruppo

### Requirement: LAYOUT-39 — Chi resta montato mentre una cella e' collassata, e chi no

Collassare una cella NON SHALL azzerare l'elenco delle pane visibili della
superficie: quell'elenco e' il pavimento del tetto di residenza, e senza pavimento
dopo pochi secondi le celle nascoste verrebbero davvero smontate, cosi' che
uscire dallo zoom troverebbe celle da ricostruire. L'assenza di box SHALL essere
un asse SEPARATO dalla residenza, propagato al solo strato che tiene vive le pane.

La garanzia va scritta nella forma vera, perche' quella comoda promette piu' di
quanto il codice dia: **la tab ATTIVA di ogni cella collassata resta montata**.
Le tab di sfondo oltre il tetto della loro classe restano sfrattabili, esattamente
come oggi quando la loro cella e' visibile, e uscendo dallo zoom si rimontano. E'
il tetto che funziona come sempre, non una regressione dello zoom.

Una pane di progetto in cella collassata riceve l'assenza di box come oggi la
riceve una pane di progetto su una tab di sfondo, e le sue pane interne perdono il
pavimento: e' identico in tipo a un comportamento in produzione da mesi.

Il segnale «questa pane ha un box» NON SHALL essere confuso con «nessun guscio
antenato e' nascosto»: e' un'implicazione a senso unico. Il contratto SHALL essere
scritto come «se non e' viva allora non ha box», mai come uguaglianza. E dove una
superficie nasconde righe e celle con il solo `display:none` senza propagare
niente, il segnale SHALL essere propagato anche li': altrimenti sotto i 768px
una pane con box zero resta pavimento del tetto di residenza, sul dispositivo
con meno memoria. Che poi la sua vista nativa vada SPENTA e non soltanto
parcheggiata lo dichiara `NATIVEPARK-02`, e qui non si riscrive: di quel cambio
questo requisito risponde della sola propagazione del segnale.

Una prova che conti i gusci in aggregato NON SHALL essere considerata copertura:
con una sola cella non esiste nessuna cella collassata e il conteggio e' identico
con e senza zoom. La prova SHALL avere almeno tre celle, piu' tab per cella e piu'
pane di sfondo di quante il tetto ne ammetta, e SHALL asserire per id.

#### Scenario: le celle collassate non ci ricascano
- **GIVEN** lo zoom tenuto per dieci secondi, con almeno tre celle e piu' tab di sfondo di quante il tetto ne ammetta
- **THEN** la tab ATTIVA di ogni cella collassata SHALL essere ancora montata
- **AND** l'asserzione SHALL essere per id, non un conteggio aggregato

#### Scenario: le tab di sfondo oltre il tetto
- **GIVEN** lo stesso scenario
- **WHEN** si esce dallo zoom
- **THEN** le tab di sfondo sfrattate SHALL rimontarsi, e questo NON SHALL essere trattato come un difetto dello zoom

#### Scenario: una cella nascosta sotto i 768px
- **GIVEN** una finestra sotto la soglia delle colonne, con una pane browser nativa in una cella che non e' quella visibile
- **THEN** quella cella SHALL propagare l'assenza di box fino alla pane
- **AND** quella pane NON SHALL essere pavimento del tetto di residenza

### Requirement: LAYOUT-40 — Ingrandimento della sola cella: un modificatore, e un solo stato di zoom

Un modificatore sul gesto SHALL ingrandire la SOLA cella che ospita la tab,
ignorando il set derivato di LAYOUT-36. Gli inneschi SHALL essere tre, gemelli di
quelli di LAYOUT-34: ⌥ tenuto durante il doppio clic sulla linguetta, ⌥⌘E da
tastiera, e una voce di menu contestuale DISTINTA, «Ingrandisci solo questa»,
accanto a «Ingrandisci».

La ragione sta nella richiesta, che dice «soltanto per quella chat, EVENTUALMENTE
delle tab che ha aperto»: «eventualmente» non e' «sempre e senza scampo». Il set
derivato e' un'ottima risposta di default e una pessima unica risposta: senza il
modificatore si potrebbe scegliere QUALE conversazione isolare, mai QUANTO, e chi
vuole leggere la sola chat con la browser dell'agente fuori dai piedi non avrebbe
nessun modo di chiederlo.

NON SHALL esistere due modalita' di zoom. Esiste UNO stato di zoom, quello di
LAYOUT-37, con un insieme di celle diverso: lo stato SHALL portare, accanto
all'ancora, l'AMBITO scelto dal gesto. Tutto il resto vale identico e non si
sdoppia: stessa cornice e stesso velo (LAYOUT-35), stesse quattro vie di uscita e
stessa potatura (LAYOUT-37), stesse regole per le viste native (LAYOUT-38), stessa
residenza (LAYOUT-39). Non c'e' un secondo velo, un secondo Escape, un secondo
predicato.

L'ambito SHALL essere fissato all'INGRESSO e NON SHALL cambiare da solo mentre lo
zoom e' aperto. Il set di celle resta derivato e potato a ogni render, ma la
SCELTA fra i due ambiti no: e' quella che rende leggibile un insieme che nessuna
banda di chip mostra. Ne segue una differenza osservabile che va scritta, o il
primo che la incontra la chiama difetto: una browser che l'agente apre mentre si
guarda entra da sola nello zoom di conversazione (LAYOUT-36) e NON entra in quello
di sola cella; li' e' una pane nuova fuori dal set, quindi vale la regola
universale e lo zoom si chiude. E' il prezzo dichiarato di aver chiesto «solo
questa».

Mentre lo zoom e' attivo tutti gli inneschi RIDUCONO, col modificatore o senza, e
il menu SHALL offrire la sola voce «Riduci». Due voci che fanno la stessa cosa sono
rumore, e un innesco che RI-AMBITA senza uscire sarebbe un terzo stato che nessuno
legge dallo schermo: si tornerebbe indietro con un gesto diverso da quello con cui
si e' entrati. Chi vuole cambiare ambito esce e rientra col gesto che vuole: due
gesti, nessuno stato nascosto.

Il modificatore NON SHALL scavalcare nessuno dei cancelli di LAYOUT-34. La
stratificazione sul fissaggio dell'anteprima viene prima: su una tab in anteprima
anche ⌥ + doppio clic FISSA e basta. Una bozza NON SHALL essere ingrandibile
nemmeno col modificatore. Sotto i 768px il comando non esiste. Su una superficie a
cella sola non si offre, e li' ⌥ + doppio clic fa quello che farebbe il doppio
clic da solo: il livello sotto, cioe' fissare un'anteprima o marcare una bozza.

Il modificatore SHALL restare distinguibile su OGNI percorso che consegna la
chord, compreso il monitor nativo che la inoltra oltre una pane browser a fuoco,
cioe' esattamente la situazione «chat piu' browser aperta dall'agente» per cui
questa funzione esiste. In nessun caso una chord col modificatore SHALL arrivare
come quella SENZA: chiedere la sola cella e ottenere l'ambito intero, in silenzio,
e' peggio di un tasto morto, ed e' l'unica forma VIETATA.

Un percorso che non sappia portare il modificatore NON SHALL per questo far
sparire l'innesco da tastiera. La chord col modificatore SHALL restare dichiarata
nel registro delle scorciatoie e nella finestra che le elenca su tutte le
piattaforme: e' li' che si impara, e sulla sponda macOS arriva. Resta un'asimmetria,
e SHALL essere ammessa per iscritto invece di essere corretta a spese d'altro:
sulla sponda Windows la decisione di inoltro scarta OGNI chord con Alt prima
ancora di guardare la propria tabella, perche' Alt e' del sistema e del menu, e
allargare quel varco per una scorciatoia di comodo costerebbe piu' di quanto renda.
Li', con una pane browser NATIVA a fuoco, ⌥⌘E non raggiunge il renderer e non
ingrandisce niente: la chord passa alla pagina, com'e' sempre stato. L'ambito di
sola cella si chiede allora col ⌥ + doppio clic o con la voce di menu, che valgono
su ogni piattaforma e non passano da nessuna tabella nativa. E' una delle ragioni
per cui il modificatore ha tre inneschi e non uno.

#### Scenario: il modificatore ingrandisce la sola cella
- **GIVEN** una chat che ha fatto aprire all'agente una pane browser in una cella accanto, in una griglia a piu' celle
- **WHEN** si fa doppio clic sulla linguetta della chat tenendo ⌥
- **THEN** SHALL restare visibile la sola cella che ospita la chat
- **AND** SHALL sparire anche la cella della browser
- **AND** ripetendo il gesto, col modificatore o senza, SHALL tornare la griglia di prima

#### Scenario: ⌘E e ⌥⌘E non sono la stessa cosa
- **GIVEN** la stessa griglia, con il fuoco sulla chat
- **WHEN** arriva ⌘E
- **THEN** SHALL restare visibili la cella della chat e quella della sua browser
- **WHEN** invece, dalla stessa griglia, arriva ⌥⌘E
- **THEN** SHALL restare visibile la sola cella della chat

#### Scenario: due voci distinte per entrare, una sola per uscire
- **GIVEN** una tab fissata e non-bozza in una griglia a piu' celle
- **THEN** il menu contestuale SHALL offrire «Ingrandisci» e «Ingrandisci solo questa» come due voci DISTINTE
- **WHEN** si sceglie una qualunque delle due
- **THEN** il menu SHALL offrire la sola voce «Riduci»

#### Scenario: il modificatore non ruba il fissaggio e non tocca le bozze
- **GIVEN** una tab in ANTEPRIMA e, nella stessa barra, una tab bozza
- **WHEN** si fa ⌥ + doppio clic sulla linguetta dell'anteprima
- **THEN** la tab SHALL essere fissata e NON SHALL ingrandirsi
- **WHEN** si fa ⌥ + doppio clic sulla linguetta della bozza
- **THEN** la bozza SHALL essere marcata come toccata, NON SHALL ingrandirsi, e il testo nel campo SHALL restare

#### Scenario: una tab che nasce mentre si guarda la sola cella
- **GIVEN** lo zoom di sola cella attivo su una chat
- **WHEN** l'agente apre per quella conversazione una nuova browser, che atterra in un'altra cella
- **THEN** lo zoom SHALL chiudersi
- **AND** la pane nuova NON SHALL nascere dentro una cella collassata

#### Scenario: l'ambito non cambia sotto le mani
- **GIVEN** lo zoom di conversazione attivo, con la cella della chat e quella della sua browser
- **WHEN** la browser viene chiusa e la sua cella sparisce
- **THEN** lo zoom SHALL restare aperto sull'ambito di CONVERSAZIONE, potato alla sola cella superstite
- **AND** una browser riaperta per quella stessa conversazione SHALL rientrare nel set

#### Scenario: la chord col modificatore non arriva degradata
- **GIVEN** la decisione di inoltro delle chord verso la webview della UI, interrogata con il modificatore di Opzione premuto
- **THEN** NON SHALL produrre l'evento della chord SENZA modificatore
- **AND** la decisione SHALL essere una funzione pura interrogabile da un test sulle DUE sponde native, non solo su quella che ha gia' la tabella

#### Scenario: sulla sponda Windows la chord col modificatore non arriva, e si dice
- **GIVEN** la decisione di inoltro della sponda Windows, interrogata sulla chord dello zoom con Alt premuto
- **THEN** SHALL lasciare la chord alla pagina, senza inoltrarla e senza ingoiarla
- **AND** la chord col modificatore SHALL comunque risultare dichiarata nel registro delle scorciatoie
- **AND** il ⌥ + doppio clic e la voce «Ingrandisci solo questa» SHALL restare disponibili

### Requirement: LAYOUT-41 — La chord dello zoom SHALL attraversare una pane browser nativa, e l'elenco che lo decide e' UNO

Il comando che ingrandisce una conversazione esiste soprattutto per il layout
«chat piu' browser aperta dall'agente», che e' anche l'unico in cui il fuoco puo'
stare DENTRO una pane browser nativa, dove la tastiera e' della pagina e non del
renderer. La chord SENZA modificatore SHALL quindi essere dichiarata inoltrabile,
cosi' che il percorso nativo la consegni alla webview della UI invece di lasciarla
alla pagina. Non e' un dettaglio del registro: una scorciatoia che si spegne
dentro il proprio caso d'uso e' una scorciatoia che non c'e', e il resto di
LAYOUT-34 resterebbe vero con due inneschi su tre. La gemella col modificatore, e
il limite che la sponda Windows le impone, stanno in LAYOUT-40.

La dichiarazione SHALL essere UNA SOLA, letta da tutte e due le sponde native: non
esiste un elenco per il Mac e uno per Windows. Ne segue su Windows un effetto che
e' VOLUTO e va scritto invece che scoperto: da quel momento la stessa chord,
digitata con una pagina a fuoco, viene inoltrata alla UI e INGOIATA invece di
raggiungere la pagina, cioe' li' ingrandisce esattamente come sul Mac. E' il
genere di cambio che la prova di «queste chord restano della pagina» deve
AFFERMARE e non mancare per omissione: quella prova SHALL nominare la chord dello
zoom fra le inoltrate, o resterebbe verde solo perche' non la cita.

Il cancello che confronta registro e allowlist generata prova la COERENZA fra i
due, mai la COPERTURA: una riga priva della dichiarazione di inoltro non emette
niente, il file committato combacia e il cancello resta verde. La prova di questo
requisito SHALL quindi stare sulle due sponde e in una passata a mano col fuoco
dentro una pane browser nativa, e SHALL essere dichiarata per quello che e'.

#### Scenario: la chord senza modificatore attraversa una pagina a fuoco
- **GIVEN** la decisione di inoltro nativa, interrogata sulla chord dello zoom senza modificatore
- **THEN** SHALL inoltrarla alla webview della UI e ingoiare l'originale
- **AND** la chord SHALL risultare nell'elenco delle inoltrate generato dal registro

#### Scenario: la prova delle chord che restano alla pagina nomina quella dello zoom
- **GIVEN** la prova che elenca le chord che, con una pagina a fuoco, restano alla pagina
- **THEN** la chord dello zoom SHALL comparire fra le INOLTRATE, non fra quelle che restano
- **AND** la prova SHALL diventare rossa il giorno in cui quella chord torna a raggiungere la pagina
