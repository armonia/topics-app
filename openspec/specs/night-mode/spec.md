## Purpose

Il turno di notte: la board continua a dispacciare mentre nessuno è alla
macchina, e si spegne da sola prima che qualcuno torni. È l'unico cancello che
misura la PRESENZA di una persona invece dello stato del lavoro.

## Background

VIENE DA UNO SCRIPT ESTERNO. Era `~/jarvis/master/bin/master-night.sh`, lanciato
a mano prima di andare a dormire. Portarlo dentro Topics ha cambiato una cosa
sola, ed è la cosa che conta: uno script si lancia e va, un cancello si CHIEDE
prima di ogni dispatch — quindi può anche rispondere «non adesso».

NON È UN CRON, ED È IL PUNTO. Partire alle 23:00 in punto significa partire
addosso a chi sta ancora lavorando. Aspettare la quiete è più lento e non ha
un'ora garantita di inizio, ma non mangia la macchina di nessuno. Il prezzo è
dichiarato: il turno potrebbe non partire mai, se la macchina non si libera.

DUE CANCELLI DI CARICO, MISURE OPPOSTE, APPOSTA. `KANBAN-16` (task pesante)
guarda il carico prodotto dai NOSTRI agenti, perché frenare un pesante per colpa
di Xcode sarebbe un freno per il lavoro di qualcun altro. Il turno di notte
guarda il carico di SISTEMA, perché la domanda qui è l'opposto: «c'è qualcuno che
sta usando questa macchina?». Il carico altrui è esattamente il segnale.

## Requirements

### Requirement: NIGHT-01 — Il turno di notte lo accende una persona, e lo spegne l'orologio

Il turno di notte SHALL essere acceso ESPLICITAMENTE su una board da una persona,
e NON SHALL mai attivarsi da sé.

Il turno SHALL avere un'ora di fine, e alla scadenza il sistema SHALL SPEGNERE
l'interruttore, non limitarsi a ignorarlo. Un turno che scade restando acceso
ripartirebbe da solo la notte dopo senza che nessuno l'abbia chiesto.

La scadenza SHALL essere calcolata dal momento dell'ACCENSIONE, non dalla
mezzanotte: un turno acceso alle 23:00 con fine alle 10:00 finisce domani
mattina, non fra undici ore nel passato. Acceso esattamente all'ora di fine, la
scadenza SHALL essere il giorno dopo — un turno di ventiquattro ore, non un
turno nullo.

Un'ora di fine MALFORMATA NON SHALL diventare «nessuna scadenza» per errore
silenzioso: SHALL essere rifiutata dalla validazione, mai propagata come valore
non numerico. Senza ora di fine il turno non scade, e questa SHALL essere una
scelta esplicita di chi lo accende, non il risultato di una stringa sbagliata.

#### Scenario: turno a cavallo della mezzanotte
- **GIVEN** il turno acceso alle 23:00 con fine dichiarata alle 10:00
- **THEN** la scadenza SHALL essere le 10:00 del giorno seguente

#### Scenario: la scadenza arriva a macchina occupata
- **GIVEN** un turno scaduto, la macchina carica e sessioni umane vive
- **THEN** l'interruttore SHALL essere spento comunque

### Requirement: NIGHT-02 — Si dispaccia solo a macchina libera E senza nessuno al lavoro

Prima di ogni dispatch automatico su una board in turno di notte, il sistema
SHALL valutare, IN QUEST'ORDINE: la scadenza, la presenza di persone al lavoro,
il carico della macchina.

L'ordine SHALL essere questo e non un altro: valutare il carico per primo
significa che su una macchina permanentemente occupata il turno resta in attesa
per sempre, invece di spegnersi all'ora che gli era stata data.

QUALUNQUE sessione umana viva SHALL bloccare il dispatch, indipendentemente dal
carico. Una macchina scarica con una persona davanti non è una macchina libera.

La soglia di carico SHALL essere PER CORE, non assoluta: la stessa soglia su una
macchina a quattro core e su una a venti descrive due situazioni diverse. Un
numero di core non valido NON SHALL azzerare né far esplodere la soglia.

La decisione SHALL portare con sé un MOTIVO leggibile, e il motivo SHALL essere
scritto dal server: tradurlo di nuovo lato client produrrebbe due versioni della
stessa frase che divergono.

#### Scenario: macchina scarica, una persona al lavoro
- **GIVEN** carico ampiamente sotto soglia e una sessione umana attiva
- **THEN** il dispatch SHALL essere rimandato, e il motivo SHALL nominare la sessione

#### Scenario: la soglia segue i core
- **GIVEN** lo stesso carico su una macchina a quattro core e su una a dodici
- **THEN** SHALL poter dare due decisioni diverse

### Requirement: NIGHT-03 — Una sola fonte per il cancello e per quello che si vede a schermo

Lo stato mostrato dalla card del turno di notte SHALL essere prodotto dalla
STESSA valutazione che decide il dispatch. Due strade separate permetterebbero
alla schermata di dire «sta dispacciando» mentre il dispatcher aspetta, e questa
è una bugia che nessuno può smentire guardando.

La card SHALL distinguere TRE stati che si somigliano e non sono lo stesso:
«non ho ancora chiesto», «il server non risponde», «il server dice di aspettare».
Una risposta assente con l'interruttore acceso SHALL valere ATTESA, mai via
libera.

Un turno SCADUTO NON SHALL essere mostrato come via libera: è uno stato di
spegnimento, e va detto come tale.

Con l'interruttore spento NON SHALL essere fatta nessuna interrogazione: chiedere
lo stato di un turno che non c'è aggiunge carico proprio a ciò che si sta
misurando. Per la stessa ragione l'interrogazione periodica SHALL essere LENTA.

Al cambio di interruttore lo stato precedente SHALL sparire SUBITO, senza un
passaggio in cui si legge ancora la risposta del turno di prima.

Il conto alla rovescia SHALL dire «meno di un minuto» sotto il minuto, invece di
arrotondare a zero: «0 min» su un turno ancora vivo si legge come «finito».

La richiesta di stato SHALL rispondere anche quando il dispatcher non è
collegato — turno spento — invece di fallire.

#### Scenario: il server non risponde
- **GIVEN** l'interruttore acceso e nessuna risposta dal server
- **THEN** la card SHALL mostrare attesa, mai via libera

#### Scenario: interruttore spento
- **GIVEN** il turno di notte spento su questa board
- **THEN** NON SHALL partire nessuna interrogazione periodica

### Requirement: NIGHT-04 — La decisione è pura, e il freno manuale è un'altra cosa

La regola che decide SHALL ricevere orologio, carico e numero di sessioni come
ARGOMENTI. Una regola che legge l'orologio vero produce prove che passano solo
di notte, cioè prove che nessuno vede fallire.

Il freno manuale di una board e il turno di notte SHALL restare distinti: il
freno è secco e NON si spegne da sé, il turno di notte SÌ. Fonderli
significherebbe che una board messa in pausa a mano riparte da sola all'alba.

#### Scenario: la stessa ora, due macchine
- **GIVEN** la stessa ora fornita alla regola con carichi diversi
- **THEN** SHALL produrre decisioni diverse senza leggere l'orologio di sistema
