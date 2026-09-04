## Purpose

Le due lingue dell'interfaccia: quale si vede, quando arriva la seconda, e cosa
si legge nel frattempo.

## Background

DUE LINGUE, NON UNA LIBRERIA. Misurate il 04/08/2026, le stringhe sono circa
novantotto in una lingua e novantuno nell'altra. Non ci sono plurali complessi,
non c'è negoziazione di regione: un impianto generico costerebbe più di quanto
risolve.

LA SECONDA LINGUA VIVE IN UN PEZZO A PARTE. Tenerla nel pacchetto iniziale ha
fatto superare il tetto della dimensione il 15/08/2026 — misurati 55 KB grezzi,
17 KB compressi — per un catalogo che la maggioranza di chi apre l'app non
leggerà mai.

E IL PRIMO FRAME NON PUÒ ASPETTARE LA RETE.

## Requirements

### Requirement: I18N-01 — La lingua di casa c'è dal primo frame, la seconda arriva dopo

La lingua predefinita SHALL essere presente dal PRIMO fotogramma, senza chiedere
niente a nessuno. La seconda SHALL essere caricata SU RICHIESTA, da un pezzo
separato del pacchetto.

La funzione che restituisce una stringa SHALL restare SINCRONA: nessuna attesa
nel percorso di disegno.

Finché la seconda lingua non è arrivata, una chiave SHALL ripiegare sull'ALTRA
lingua e NON SHALL stampare la chiave nuda. Solo quando manca in ENTRAMBE la
chiave grezza SHALL comparire — ed è il segnale che qualcosa è stato dimenticato,
non un modo normale di funzionare.

La richiesta di caricamento SHALL essere IDEMPOTENTE: chiedere due volte NON
SHALL caricare due volte, e chiedere la lingua già presente SHALL essere un
non-fare.

Un caricamento FALLITO NON SHALL essere memorizzato come fallimento: il tentativo
successivo deve poter riuscire.

Al completamento SHALL essere avvisato chi sta guardando, o l'interfaccia resta
nella lingua di prima finché qualcosa d'altro non la ridisegna. Chi ha smesso di
ascoltare NON SHALL essere richiamato.

La scelta della lingua NON SHALL guardare le impostazioni del browser: il 13/08
ha prodotto una scheda con le due lingue mescolate in produzione.

#### Scenario: la seconda lingua non è ancora arrivata
- **GIVEN** una chiave richiesta nella lingua non ancora caricata
- **THEN** SHALL essere restituito il testo dell'altra lingua, mai la chiave

#### Scenario: due richieste di caricamento
- **GIVEN** due richieste ravvicinate della stessa lingua
- **THEN** SHALL essere caricata una volta sola

### Requirement: I18N-02 — Le stringhe di una schermata si verificano DOPO che il catalogo è arrivato

La verifica che le stringhe di una schermata esistano in entrambe le lingue SHALL
essere fatta DOPO aver atteso il catalogo, non leggendo i dizionari a mano.
Leggerli subito dopo l'avvio mostra la lingua di ripiego anche per l'altra, e la
prova passa su un difetto vero.

L'elenco delle chiavi da verificare SHALL essere scritto A MANO e non ricavato
dal codice sorgente: derivarlo proverebbe soltanto che il codice è coerente con
sé stesso, non che quelle frasi dicano qualcosa a una persona.

SHALL essere verificato che nessuna chiave esca come CHIAVE GREZZA — è
esattamente ciò che si vedrebbe a schermo — e che nessun SEGNAPOSTO resti non
sostituito, in ENTRAMBE le lingue.

SHALL essere verificato anche il CONTENUTO delle frasi che portano dei numeri:
che i numeri ci siano tutti, e che il consiglio dato sia quello giusto per quella
riga. Due frasi vicine che consigliano cose opposte sono la ragione per cui
questa verifica non si ferma alla presenza della chiave.

#### Scenario: un segnaposto non sostituito
- **GIVEN** una frase che lascia un segnaposto letterale
- **THEN** la verifica SHALL fallire

#### Scenario: una chiave assente nella seconda lingua
- **GIVEN** una chiave presente solo nella lingua predefinita
- **THEN** SHALL essere segnalata come mancante

### Requirement: I18N-03 — Le superfici della bacheca esistono DAVVERO nella seconda lingua

Tutta la suite della bacheca gira in una lingua, quindi ogni banco àncora i valori
di quella. SHALL esistere l'altra metà: un banco che DIMOSTRA che la seconda
lingua esiste davvero sulle superfici della bacheca — la barra dei filtri, il
campo di scrittura, testa e piede delle colonne, il menu di una card.

SHALL essere coperti anche i pannelli CONDIZIONALI del task — controlli, modifiche,
tentativi — che lo scanner della copertura NON vede, perché il loro testo sta
dentro espressioni composte e non fra due tag.

I DATI NON SHALL essere tradotti: i nomi delle etichette, gli stati e il testo che
scrivono gli agenti sono contenuto, non interfaccia.

#### Scenario: la bacheca nella seconda lingua
- **GIVEN** la seconda lingua selezionata
- **THEN** filtri, campo di scrittura, colonne e menu SHALL leggersi in quella lingua

#### Scenario: un nome di etichetta
- **GIVEN** un'etichetta definita dall'utente
- **THEN** NON SHALL essere tradotta

### Requirement: I18N-04 — Le superfici di chat che chiedono una decisione parlano UNA lingua sola

Il pannello dei permessi e i dialoghi distruttivi sono le superfici dove
l'utente decide: SHALL leggersi nella lingua scelta, e la lingua non scelta NON
SHALL comparire accanto, perché un pannello che mostra entrambe supera ogni
verifica sulla presenza e fallisce l'unica che conta, quella sulla chiarezza.

#### Scenario: il pannello dei permessi in inglese
- **GIVEN** la lingua inglese selezionata e una richiesta di permesso a schermo
- **THEN** i pulsanti SHALL leggersi Allow e affini
- **AND** la versione italiana NON SHALL essere presente

#### Scenario: un dialogo distruttivo in italiano
- **GIVEN** la lingua italiana e un dialogo che chiede conferma di scartare
- **THEN** NON SHALL comparire Cancel né Discard
