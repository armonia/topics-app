## ADDED Requirements

### Requirement: DNDSPLIT-04 — La tabella dei casi vale anche al SECONDO livello, e li' l'anteprima disegna cio' che nascera'

I dodici casi di DNDSPLIT-01 puntano tutti una pane di primo livello. Il momento
in cui il sistema si rompe e' quello DOPO il primo split: la colonna e' gia'
divisa in verticale, e si prova a dividerla ancora. Ogni riga della tabella
SHALL valere anche quando il bersaglio e' una pane ANNIDATA (un membro della
pila verticale di una colonna) o il primario di una colonna che una pila ce
l'ha gia'.

Il modello persistito ha due livelli: una riga ha colonne, una colonna puo'
avere una pila, e uno slot della pila contiene UNA pane. Uno split orizzontale
dentro uno slot non e' rappresentabile, e non lo si finge. La fascia
sinistra/destra su un bersaglio annidato SHALL quindi produrre la colonna
accanto alla colonna OSPITE, e l'anteprima SHALL disegnare il contorno di
QUELLA colonna, non la meta' dello slot puntato. Il gesto resta offerto in ogni
direzione e su ogni pane; cio' che cambia e' che la promessa e' vera prima del
rilascio, invece di essere smentita dopo.

La fascia alta/bassa su un bersaglio annidato SHALL invece inserire lo slot
ADIACENTE al membro puntato, dentro la sua pila, e SHALL dividere l'altezza del
SOLO slot puntato: gli altri slot della pila SHALL conservare l'altezza che
qualcuno ha dato loro trascinando un divisore.

#### Scenario: la fascia laterale di una pane impilata promette la colonna
- **GIVEN** una colonna divisa in verticale in due pane
- **WHEN** una scheda passa sulla fascia destra della pane di sotto
- **THEN** l'anteprima SHALL coprire l'altezza dell'intera colonna ospite
- **AND** il rilascio SHALL produrre esattamente quella colonna, sull'asse `row`

#### Scenario: impilare non ridimensiona i fratelli
- **GIVEN** una colonna di due pane, la seconda ridotta a un quinto dell'altezza
- **WHEN** una terza pane viene impilata sotto la prima
- **THEN** le altezze SHALL nascere dalla divisione del SOLO slot puntato, e lo
  slot non toccato SHALL conservare il suo quinto

### Requirement: DNDSPLIT-05 — Lo stesso gesto, lo stesso layout, da qualunque parte venga la scheda

Il bordo alto/basso del corpo di una cella SHALL impilare sulla SOLA colonna
puntata, quale che sia la provenienza della scheda. Nella superficie autonoma
una scheda che viveva gia' in una cella propria veniva dirottata sul percorso
«cella intera», dove lo stesso bordo costruiva una riga a TUTTA LARGHEZZA:
stesso puntatore, stessa anteprima, due alberi diversi a seconda di una storia
che chi trascina non vede. La riga a tutta larghezza SHALL restare l'intento
delle sole strisce di contenitore e della banda fra due righe.

#### Scenario: due provenienze, un solo albero
- **GIVEN** due schede identiche, una nel gruppo principale e una gia' in una
  cella propria
- **WHEN** ciascuna viene rilasciata sul bordo inferiore della stessa cella
- **THEN** l'albero risultante SHALL essere lo stesso: una pila di colonna, non
  una riga nuova

### Requirement: DNDSPLIT-06 — Un bersaglio che non cambierebbe niente non si accende

Ogni superficie di rilascio SHALL consultare, nel `dragover`, la stessa
condizione che il `drop` applichera'. Tre bersagli la violavano: il centro del
PROPRIO gruppo (fusione gia' avvenuta), la banda fra due righe quando il
rilascio ridisegnerebbe lo stesso albero, e il bordo della cella di una scheda
sola rilasciata su se stessa. In tutti e tre l'anteprima si accendeva e il
rilascio non faceva niente.

La banda fra due righe NON SHALL sovrapporsi alla barra delle schede della riga
sottostante: e' la stessa protezione che le strisce agli estremi hanno gia'.

Lo stato «quale pane e' in volo», che le anteprime interrogano per rispondere a
queste domande, SHALL essere dimenticato sia su `dragend` sia su `drop`: il
`dragend` non arriva quando il gestore del rilascio smonta la sorgente, e da li'
in poi il gesto successivo leggerebbe una pane che non vola piu'.

I tetti di sicurezza contro la fuga (32 colonne per riga, 32 righe, 32 slot per
colonna) SHALL essere letti dal `dragover` e non dal solo rilascio. Al tetto il
rilascio esce senza cambiare niente: fino a ieri la fascia si accendeva lo
stesso, su tutte e quattro le direzioni, e il gesto moriva in silenzio. La
domanda «ci sta?» SHALL essere UNA funzione per superficie, interrogata dalle
due parti, e le sue tre diramazioni SHALL rispecchiare quelle del rilascio:
sinistra/destra contano le colonne della riga OSPITE (un bersaglio annidato
conta la sua, non zero), alto/basso contano gli slot della colonna puntata, e
una riga a tutta larghezza conta le righe.

#### Scenario: al tetto non si accende niente
- **GIVEN** una riga che ha gia' il massimo di colonne
- **WHEN** una scheda passa sulla fascia destra di una di quelle colonne
- **THEN** nessuna anteprima SHALL accendersi, e il rilascio SHALL non cambiare
  l'albero
- **AND** la fascia alta/bassa della stessa cella, che spende un tetto diverso,
  SHALL restare viva

#### Scenario: il centro del proprio gruppo resta spento
- **GIVEN** una scheda trascinata dal corpo della pane in cui gia' vive
- **WHEN** il puntatore sta nel riquadro centrale di quella pane
- **THEN** nessuna campitura di fusione SHALL accendersi

#### Scenario: la banda di gap lascia stare la barra sotto
- **GIVEN** due righe, e il puntatore sulla barra delle schede della seconda
- **WHEN** una scheda viene rilasciata li'
- **THEN** SHALL entrare in quella barra, e nessuna riga nuova SHALL nascere
