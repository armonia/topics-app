## ADDED Requirements

### Requirement: NATIVEPARK-01 — Il parcheggio di una vista nativa e' un chiavistello, non un messaggio

Quando la pane di una vista nativa riceve un rettangolo NULLO, perche' la sua
cella e' stata collassata, perche' la sua tab non e' attiva, o perche' un
trascinamento e' in corso, la vista SHALL essere parcheggiata fuori schermo
conservando l'ULTIMA misura reale: cosi' la pagina non ricollassa la propria
impaginazione e resta leggibile e fotografabile da un agente. Nello stesso gesto
il rettangolo di riserva SHALL essere DIMENTICATO. Il parcheggio e' un
CHIAVISTELLO che resta chiuso, non un comando inviato una volta.

Finche' il chiavistello e' chiuso, NESSUN percorso che ridisegna i bounds SHALL
riportare la vista a schermo. Le vie vanno nominate tutte e cinque, perche'
nessuna di loro passa dal segnaposto della pane e ognuna era una via di ritorno:
lo scongelamento alla chiusura di un pannello sovrapposto, il cambio di
dispositivo emulato, il riconcilio della modalita' riletta dal ramo UA della
pagina, il ridimensionamento responsive, e la stretta di mano di una ricreazione.
Tutte e cinque SHALL essere no-op sulla geometria. Sono osservabili contando i
comandi di geometria inviati alla vista, non guardando lo schermo.

Il chiavistello SHALL essere aperto SOLO da un rettangolo POSITIVO misurato sul
segnaposto della pane, che e' la sola porta che sappia se quella pane un box ce
l'ha davvero. Nessun'altra scrittura del rettangolo di riserva SHALL poterlo
aprire: la consegna animata che accompagna lo scivolamento della colonna SHALL
rifiutare un rettangolo non positivo invece di memorizzarlo. Al primo rettangolo
vero la vista SHALL tornare esattamente li', e con quella stessa chiamata SHALL
arrivare la conferma strutturale che una ricreazione avvenuta a chiavistello
chiuso non ha potuto inviare: un guasto dichiarato mentre la cella era collassata
NON SHALL sopravvivere al ritorno della cella.

A chiavistello chiuso la vista NON SA piu' dove sta, e la decisione di
congelamento SHALL prendersi su quel «non lo so», mai sulla geometria che la
cella aveva PRIMA. Il ramo esiste gia' in `OCCLUSION-01`, che resta com'e':
senza rettangolo noto e con un pannello aperto si congela. Il congelamento in
piu' SHALL essere innocuo, perche' la vista e' gia' fuori schermo e il suo
scongelamento e' a sua volta un no-op. E' il caso opposto a essere il difetto:
una vista parcheggiata che decidesse sul rettangolo stantio SCONGELEREBBE, ed e'
esattamente la sequenza che rimetteva la pagina sopra la cornice (pannello aperto
sopra la pane, congelamento, cella collassata, pannello chiuso, ritorno a schermo
all'ultimo rettangolo reale).

Visibilita' e geometria SHALL restare due assi distinti: parcheggiare NON spegne,
spegnere NON sposta. Il risveglio che precede un'operazione guidata da un agente
tocca la sola visibilita', quindi un'operazione delegata su una pane parcheggiata
SHALL funzionare, scatto, lettura e azione comprese, con la vista che resta fuori
schermo. Era il flag di nascondimento a mascherare il difetto, non a impedirlo:
la vista tornava a schermo lo stesso, ma nascosta non si vedeva. Un'operazione
dell'agente quel flag lo toglie per poter fotografare, e da li' in avanti ogni
ridisegno dei bounds era visibile a chi guarda.

> Perche' questo requisito vive qui e non in `layout`: chi decide se una cella ha
> un box e' la superficie di tiling, chi decide cosa fa la webview nativa con
> quella risposta e' questa capability. `LAYOUT-38` dichiara che fuori dallo zoom
> la geometria resta parcheggiata; questo requisito dice che cosa vuol dire, e
> vale anche dove lo zoom non arriva: una tab di sfondo, una cella nascosta sotto
> i 768px, il tiling dentro il cassetto di un task. `NATIVEOPS-01` non e'
> emendato: nessuna mappatura, nessuna forma di errore e nessun contratto di
> operazione cambia, cambia solo dove sta la vista mentre l'operazione gira.

#### Scenario: lo scongelamento non riporta a schermo una vista parcheggiata
- **GIVEN** una vista nativa parcheggiata, e un pannello sovrapposto aperto e poi chiuso sopra la sua area
- **WHEN** scatta lo scongelamento
- **THEN** nessun comando di geometria SHALL essere inviato alla vista
- **AND** la vista SHALL restare fuori schermo

#### Scenario: le altre quattro vie di ritorno
- **GIVEN** una vista nativa parcheggiata
- **WHEN** si cambia il dispositivo emulato, si ridimensiona in responsive, il ramo UA della pagina viene riconciliato, oppure la vista viene ricreata
- **THEN** in nessuno dei quattro casi la geometria SHALL cambiare

#### Scenario: la decisione di congelamento non usa la geometria di prima
- **GIVEN** una vista parcheggiata e un pannello aperto che NON interseca il rettangolo che la sua cella occupava prima
- **THEN** la decisione SHALL essere «congela», presa senza rettangolo
- **AND** NON SHALL essere «scongela» deciso sul rettangolo stantio

#### Scenario: un'operazione dell'agente su una pane parcheggiata
- **GIVEN** una vista parcheggiata e spenta
- **WHEN** l'agente esegue su quella pane un'operazione delegata
- **THEN** l'operazione SHALL riuscire
- **AND** la vista NON SHALL tornare a schermo
- **AND** a operazione finita SHALL tornare spenta

#### Scenario: il ritorno apre il chiavistello
- **GIVEN** una vista parcheggiata la cui cella torna ad avere un box
- **WHEN** il segnaposto misura e spinge il primo rettangolo positivo
- **THEN** la vista SHALL tornare esattamente su quel rettangolo
- **AND** un guasto dichiarato da una ricreazione avvenuta a chiavistello chiuso SHALL cadere con quella stessa chiamata

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
