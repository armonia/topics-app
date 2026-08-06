## ADDED Requirements

### Requirement: LAYOUT-PIN-00 — Un progetto ha UNA sola chiave di pin

Un progetto SHALL avere una sola chiave di pin, qualunque sia la superficie da cui viene
fissato (riga della sidebar o tab). Il sistema SHALL normalizzare le chiavi già salvate
al caricamento, deduplicando le voci che rappresentano lo stesso progetto.

#### Scenario: fissare dalla tab lo mostra fra i fissati
- **GIVEN** un progetto aperto come tab, non ancora fissato
- **WHEN** l'utente lo fissa dalla tab
- **THEN** il progetto compare nel blocco fissati della sidebar

#### Scenario: nessun doppione dopo la normalizzazione
- **GIVEN** uno stato salvato che contiene lo stesso progetto sia in forma grezza sia in forma codificata
- **WHEN** l'applicazione carica quello stato
- **THEN** il progetto compare una volta sola fra i fissati

### Requirement: LAYOUT-PIN-01 — Il blocco Fissati è una griglia di tessere, senza intestazione

Il blocco dei fissati SHALL essere reso come una **griglia di tessere affiancate**, e NON
come una lista di righe a tutta larghezza. Il blocco SHALL NOT mostrare alcuna
intestazione testuale («Fissati» / «Pinned») in **nessuno** dei modi di vista
(gruppi, timeline, grouped, state). Il contenitore SHALL conservare
`data-testid="sidebar-pinned-section"` e ogni tessera SHALL restare un `treeitem` con
nome accessibile pari al nome dell'elemento.

#### Scenario: nessuna etichetta in nessun modo di vista
- **GIVEN** almeno un elemento fissato
- **WHEN** l'utente passa fra i modi di vista della sidebar (timeline, grouped, state, gruppi)
- **THEN** in ognuno il blocco fissati è visibile come griglia di tessere
- **AND** in nessuno compare il testo «Fissati» o «Pinned» come intestazione di sezione

#### Scenario: le tessere chiuse stanno affiancate
- **GIVEN** quattro elementi fissati su una sola riga di layout
- **WHEN** la sidebar viene renderizzata
- **THEN** le quattro tessere occupano la stessa riga, con il medesimo `top` di viewport
- **AND** l'altezza totale del blocco è inferiore alla somma di quattro righe di sidebar

#### Scenario: il nome accessibile sopravvive alla tessera icon-only
- **GIVEN** un progetto fissato che espone una favicon reale
- **WHEN** la sua tessera è resa con la sola icona, senza titolo visibile
- **THEN** dentro `sidebar-pinned-section` esiste un `treeitem` il cui nome accessibile è il nome del progetto

### Requirement: LAYOUT-PIN-02 — Identità della tessera: icona reale, tinta, e nessun placeholder sintetico

Una tessera SHALL mostrare l'**icona reale** del progetto (risolta da
`GET /api/projects/icon`) **senza ripeterne il titolo** quando quell'icona esiste. Quando
l'icona non esiste, la tessera SHALL mostrare il nome troncato e SHALL NOT mostrare alcun
placeholder sintetico (monogrammi, iniziali, glifi generici). Una tessera SHALL portare
una **tinta di identità** statica solo quando quella tinta proviene da una sorgente reale:
il colore dominante della propria icona, o il colore di tipo già definito per chat,
terminali e browser. Un progetto privo di icona SHALL essere reso in piatto, senza tinta:
nessun colore SHALL essere assegnato o derivato per differenziare. La tinta SHALL NOT
essere animata: l'animazione a corona resta riservata al segnale di attività.

#### Scenario: progetto con favicon → solo icona
- **GIVEN** un progetto fissato che espone una favicon
- **WHEN** la sua tessera è chiusa
- **THEN** la tessera mostra l'icona e non mostra il titolo del progetto

#### Scenario: progetto senza icona → nome, mai un monogramma né un colore assegnato
- **GIVEN** un progetto fissato privo di favicon e di manifest
- **WHEN** la sua tessera è chiusa
- **THEN** la tessera mostra il nome troncato
- **AND** non compare alcuna iniziale o glifo generato al posto dell'icona
- **AND** la tessera non porta alcuna tinta: resta sulla superficie neutra

#### Scenario: identità e attività restano due segnali distinti
- **GIVEN** due elementi fissati, di cui uno con un turno agente in corso
- **WHEN** entrambe le tessere sono visibili
- **THEN** entrambe portano la propria tinta statica
- **AND** solo quella con lavoro in corso porta l'indicatore di attività animato

### Requirement: LAYOUT-PIN-03 — Le righe si compongono in drag & drop, con le misure in diretta

L'utente SHALL poter trascinare una tessera per sceglierne la **riga** e la **posizione**
nella riga. Il numero di tessere per riga SHALL essere determinato dal contenuto della
riga stessa, senza controlli separati. Durante il trascinamento sopra una riga bersaglio,
le tessere di quella riga SHALL ridimensionarsi **in diretta** alla misura che avranno al
rilascio. Una zona di drop sotto l'ultima riga SHALL creare una riga nuova. Il drag di una
tessera verso la griglia dei pane SHALL continuare ad aprire l'elemento come prima di
questa change.

#### Scenario: spostare una tessera su un'altra riga
- **GIVEN** un layout con due tessere sulla riga 0 e una sulla riga 1
- **WHEN** l'utente trascina la tessera della riga 1 dentro la riga 0
- **THEN** al rilascio la riga 0 contiene tre tessere e la riga 1 non esiste più

#### Scenario: le misure si vedono prima di lasciare
- **GIVEN** una riga con tre tessere
- **WHEN** l'utente ci trascina sopra una quarta tessera senza rilasciarla
- **THEN** le tre tessere presenti si stringono alla larghezza che avranno in quattro
- **AND** al posto d'inserimento compare una tessera fantasma

#### Scenario: nasce una riga nuova
- **GIVEN** un layout con una sola riga
- **WHEN** l'utente trascina una tessera sulla zona di drop sotto l'ultima riga e rilascia
- **THEN** il layout ha due righe e la tessera trascinata è l'unica della seconda

#### Scenario: il drag verso la griglia dei pane non si rompe
- **GIVEN** un topic fissato la cui tab è chiusa
- **WHEN** l'utente trascina la sua tessera dentro la griglia dei pane e rilascia
- **THEN** il topic si apre nella griglia, esattamente come dal comportamento pre-esistente

### Requirement: LAYOUT-PIN-04 — Il click espande una fascia sotto la riga della tessera

Il click su una tessera SHALL aprire una fascia a tutta larghezza **immediatamente sotto
la riga che contiene quella tessera**, e non in coda alla sezione. Per un progetto la
fascia SHALL contenere le sue tab (chat, terminali, browser). Con più tessere aperte, le
fasce SHALL dividersi lo spazio verticale della sezione e le tessere chiuse SHALL
riadattarsi. Lo stato di apertura SHALL NOT essere persistito fra sessioni.

#### Scenario: la fascia si inserisce sotto la riga giusta
- **GIVEN** un layout con due righe e un progetto fissato sulla riga 0
- **WHEN** l'utente clicca la tessera di quel progetto
- **THEN** la fascia compare fra la riga 0 e la riga 1
- **AND** il suo `top` è maggiore di quello della riga 0 e minore di quello della riga 1

#### Scenario: sotto un progetto escono le sue tab
- **GIVEN** un progetto fissato con almeno una chat e un terminale
- **WHEN** l'utente clicca la sua tessera
- **THEN** la fascia elenca quella chat e quel terminale

#### Scenario: due fasce si dividono lo spazio
- **GIVEN** una tessera già espansa
- **WHEN** l'utente clicca una seconda tessera
- **THEN** entrambe le fasce sono visibili e si dividono l'altezza della sezione
- **AND** le tessere rimaste chiuse restano visibili

#### Scenario: l'espansione non sopravvive al reload
- **GIVEN** una tessera espansa
- **WHEN** l'utente ricarica l'applicazione
- **THEN** tutte le tessere sono chiuse
- **AND** la disposizione delle righe è quella salvata

### Requirement: LAYOUT-PIN-05 — Il layout viaggia col pin e si riconcilia da solo

La disposizione (quali id, su quale riga, in quale ordine) SHALL essere persistita
insieme ai fissati, sullo stesso canale (`localStorage` + `ui-state` sul server + WS), così
da seguire l'utente fra i device. Il layout SHALL NOT essere autorevole sull'insieme dei
fissati: `pinnedItems` resta l'unica fonte di verità su *cosa* è fissato. Un client privo
di layout salvato SHALL derivarne uno dall'ordine di pin, senza errori. La scrittura dello
stato sidebar SHALL essere condizionata alla versione da cui è stata derivata: un
aggiornamento che parte da una versione superata SHALL essere rifiutato e riprovato sulla
versione corrente, invece di sovrascriverla.

#### Scenario: la disposizione sopravvive al reload
- **GIVEN** un layout composto a mano su due righe
- **WHEN** l'utente ricarica l'applicazione
- **THEN** le stesse tessere sono sulle stesse righe, nello stesso ordine

#### Scenario: un nuovo pin entra nel layout senza romperlo
- **GIVEN** un layout salvato su due righe
- **WHEN** l'utente fissa un nuovo elemento
- **THEN** la sua tessera compare in coda senza spostare le altre

#### Scenario: togliere il pin toglie la tessera
- **GIVEN** un elemento fissato presente nel layout
- **WHEN** l'utente lo rimuove dai fissati
- **THEN** la sua tessera sparisce dalla griglia
- **AND** le tessere rimaste conservano riga e ordine

#### Scenario: due device che riordinano insieme non si cancellano la disposizione
- **GIVEN** due client con lo stesso stato sidebar
- **WHEN** entrambi modificano la disposizione entro la stessa finestra di scrittura
- **THEN** la seconda scrittura viene rifiutata come derivata da una versione superata
- **AND** viene riapplicata sulla versione corrente, così nessuna delle due disposizioni viene persa in silenzio

#### Scenario: payload senza layout non rompe nulla
- **GIVEN** uno stato sidebar salvato da una versione precedente, privo del campo di layout
- **WHEN** l'applicazione lo carica
- **THEN** le tessere sono disposte nell'ordine di pin
- **AND** nessun errore viene sollevato

### Requirement: LAYOUT-PIN-06 — Il fissaggio è una scorciatoia, non un lucchetto

Una tab fissata SHALL essere chiudibile come qualunque altra, da ogni strada (bottone,
menu contestuale, scorciatoia da tastiera). Chiudendola il fissaggio SHALL restare, la sua
tessera SHALL restare nel blocco fissati, e un click su quella tessera SHALL riaprirla
ripristinandola. Solo togliendo il pin la tessera SHALL sparire.

#### Scenario: una tab fissata si chiude
- **GIVEN** una chat fissata con la sua tab aperta
- **WHEN** l'utente la chiude dal menu contestuale della tab
- **THEN** la tab si chiude
- **AND** la sua tessera è ancora nel blocco fissati

#### Scenario: la tessera la riapre
- **GIVEN** una chat fissata la cui tab è stata chiusa
- **WHEN** l'utente clicca la sua tessera
- **THEN** la tab si riapre
- **AND** la chat non risulta archiviata

#### Scenario: togliere il pin è il gesto che smonta la scorciatoia
- **GIVEN** una tessera fissata
- **WHEN** l'utente toglie il pin dal menu contestuale della tessera
- **THEN** la tessera sparisce dal blocco fissati

#### Scenario: ogni tipo può essere tolto dai Fissati dalla sua tessera
- **GIVEN** una chat, un terminale e un browser fissati
- **WHEN** l'utente apre il menu contestuale di ciascuna tessera
- **THEN** ognuno offre la voce per togliere il pin
