# Delta: topics-check — Topics si accorge da solo quando non fa il suo lavoro

## ADDED Requirements

### Requirement: CHECK-01 — Un giro ogni 5 minuti misura le ore perse, senza modelli

Ogni 5 minuti il server SHALL campionare il proprio DB e tenere tre voci, ciascuna in ore perse:
card che non avanzano, posti dei nodi promessi e non usabili mentre c'è coda, automazioni
dichiarate che non superano la loro prova. Il giro SHALL NOT chiamare nessun modello. Ogni voce
rossa SHALL nominare la causa più probabile in una frase.

MISURA: `bun test server/services/topics-check.test.ts` con i casi del 21/11; zero chiamate a modelli in 288 giri.

#### Scenario: nodo che promette posti e non li dà
- **GIVEN** un nodo con 4 posti dichiarati, a 0 posti usabili per 9 ore su 12 con card in coda
- **THEN** la voce dei nodi SHALL essere rossa con «9 h» e la causa

#### Scenario: card che rimbalza
- **GIVEN** una card spostata 11 volte fra due macchine in 35 minuti
- **THEN** la voce delle card SHALL essere rossa e nominare i rimbalzi

#### Scenario: attesa voluta contro ore perse
- **GIVEN** card ferme oltre la soglia, lette con la ragione della coda della board (`queueReasonOf`)
- **THEN** un'attesa voluta (rinvio con data futura, bloccante vivo, genitore al lavoro, carico, coda che scorre) SHALL NOT contare
- **AND** piano esaurito, spesa, disco, tentativi esauriti, genitore in revisione, card senza progetto, nodo spento (anche con la corsa aperta) e catena ferma su una card in backlog SHALL contare, ciascuno con la sua causa
- **AND** l'età SHALL partire dall'ultimo ingresso in todo (evento di stato) o, per i rinvii di un nodo spento, dall'inizio della serie (`wait_since`)

### Requirement: CHECK-02 — Le prove delle automazioni sono configurazione

L'elenco delle automazioni da provare (nome, comando, giro) SHALL stare nelle impostazioni, con
default vuoto. Un comando che esce non zero o supera il suo tetto d'orologio SHALL rendere rossa
la voce delle automazioni. Senza elenco la voce SHALL essere verde e dirlo.

MISURA: test con un comando che esce 1 e uno che non finisce entro il tetto.

#### Scenario: nessuna prova dichiarata
- **GIVEN** impostazioni senza automazioni
- **THEN** la voce SHALL essere verde con «nessuna prova dichiarata»

### Requirement: CHECK-03 — Una causa nota si cura da sola, le altre aprono una card

Per ogni causa riconosciuta il giro SHALL applicare la sua cura reversibile e scriverla sulla
card o sul nodo toccato. Una causa senza cura, o una cura che non toglie il rosso al giro dopo,
SHALL aprire al massimo una card d'indagine per chiave di problema nella board scelta, entro il
tetto giornaliero. Senza board scelta SHALL NOT aprire card.

MISURA: `bun test server/services/topics-check-cures.test.ts`, una coppia di casi per cura; mutazione sulla chiave.

#### Scenario: tetto raggiunto
- **GIVEN** tetto 3 e tre card d'indagine già aperte oggi
- **THEN** il quarto problema SHALL NOT aprire una card e la riga SHALL dirlo

### Requirement: CHECK-04 — Una volta al giorno, gli stessi conti e una sola lettura AI

Una volta al giorno il giro SHALL ricalcolare le voci sulle 24 ore e fare una sola chiamata al
modello scelto con le firme d'errore nuove del giorno, le automazioni senza prova e le card
ferme. Il verdetto SHALL stare in una riga; un verdetto rosso SHALL aprire una card come CHECK-03.
Un modello non raggiungibile SHALL NOT fermare il giro dei 5 minuti.

MISURA: `bun test server/services/topics-check-daily.test.ts` con modello finto: una chiamata al giorno anche se il giro è chiamato due volte.

#### Scenario: firma d'errore già vista
- **GIVEN** una firma d'errore presente anche nei 7 giorni prima
- **THEN** SHALL NOT entrare nella lettura del giorno
