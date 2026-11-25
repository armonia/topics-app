## ADDED Requirements

### Requirement: NATIVEPARK-02 — Una vista dietro un guscio nascosto e' SPENTA, non solo fuori schermo

Parcheggiare fuori schermo alla misura piena nasconde la pagina a chi guarda, non
a WebKit: la visibilita' di una vista nativa si deriva dal suo flag di
nascondimento e dall'occlusione della finestra, mai dalla sua posizione. Una
pagina parcheggiata resta viva per intero, con rAF che gira e timer non
strozzati; misurato con una ventina di pane aperte, venti processi di contenuto
vivi per 6374 MB di footprint contro i circa 130 MB davvero residenti, e il
rientro di quella differenza e' cio' che faceva scattare l'interfaccia.

La visibilita' nativa di una pane browser SHALL quindi seguire DUE domande, non
una: la pane e' quella attiva della sua cella, e ogni guscio che la contiene ha
un box. Una vista il cui guscio antenato e' nascosto SHALL essere SPENTA, non
solo parcheggiata, qualunque sia la superficie che la ospita: una cella
collassata dallo zoom, una riga o una cella nascosta sotto i 768px, il tiling
dentro il cassetto di un task.

Il cassetto e' il caso che CAMBIA con questa change e va dichiarato invece di
essere scoperto: oggi una sua browser dietro una pane nascosta resta accesa, con
la vista viva e i soli bounds a zero, perche' nessuno le passa la seconda
domanda. Dopo, prende lo spegnimento. E' un miglioramento su una superficie che
questa change dichiara per il resto intatta, e la prova va scritta li' dove il
comportamento cambia.

L'eccezione esistente SHALL sopravvivere intatta: una pane che un agente sta
guidando, o che ha un'operazione delegata in volo, resta ACCESA anche mentre e'
fuori schermo, perche' una vista nascosta non si puo' fotografare ne' impaginare.
Uscita l'ultima operazione, e se nel frattempo la pane non e' tornata davvero
visibile ne' l'agente si e' attaccato, SHALL tornare spenta. In nessun momento di
quel giro la sua geometria SHALL muoversi: e' `NATIVEPARK-01` a tenerla ferma, e
i due requisiti si leggono insieme.

#### Scenario: una browser dietro un guscio nascosto
- **GIVEN** una pane browser nativa in una cella collassata, oppure in una riga nascosta sotto i 768px
- **THEN** la vista SHALL ricevere lo spegnimento
- **AND** NON SHALL restare accesa con i soli bounds a zero

#### Scenario: la browser di un cassetto dietro una superficie nascosta
- **GIVEN** il cassetto di un task con una sua browser dietro una pane nascosta
- **THEN** quella vista SHALL essere spenta, dove prima restava accesa
- **AND** il cassetto NON SHALL per questo offrire lo zoom

#### Scenario: l'agente tiene accesa la pane che sta guidando
- **GIVEN** una vista parcheggiata e spenta
- **WHEN** un agente la attacca, o parte su di lei un'operazione delegata
- **THEN** la vista SHALL tornare accesa per tutta la durata
- **AND** SHALL tornare spenta quando l'ultima operazione esce, se nel frattempo la pane non e' tornata visibile
- **AND** in nessuno di quei passaggi la sua geometria SHALL muoversi
