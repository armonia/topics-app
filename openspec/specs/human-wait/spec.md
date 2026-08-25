## Purpose

Il momento in cui il lavoro si ferma ad aspettare una PERSONA — e tutto ciò che
non deve succedere mentre aspetta: nessuna rete di sicurezza che lo scambi per un
blocco, nessun orologio che gli addebiti l'attesa, nessun riavvio che gli passi
sopra.

## Background

TRE COSTI MISURATI, TUTTI DALLA STESSA CONFUSIONE fra «fermo» e «rotto».

Il 7 agosto: tre chiamate ferme e un pannello che invitava a un click che non
poteva più arrivare — la rete di sicurezza aveva ucciso il turno mentre una
persona lo stava guardando.

Un turno da otto secondi di lavoro archiviato come «43m 12s»: l'attesa della
persona addebitata al modello.

Il 18 agosto: il server di produzione si è riavviato **circa 1,4 volte al minuto**
sopra un turno di chat vivo da quattordici minuti, e non ha lasciato nemmeno una
riga a dirlo. Il 20 agosto un task è stato ucciso **TRE volte, a ventisette minuti
esatti l'una dall'altra** — 17:55, 18:22, 18:51, 19:18.

## Requirements

### Requirement: HOLD-01 — Una persona in mezzo è UN fatto solo, e le reti di sicurezza lo rispettano

«C'è una persona in mezzo su questa sessione» SHALL essere UN fatto solo,
calcolato in un punto solo, e SHALL essere vero sia per una DOMANDA a schermo sia
per un PERMESSO in attesa.

Il ramo del permesso NON SHALL mancare: è quello che, mancando, faceva uccidere
un turno mentre un pannello invitava a un click che non poteva più arrivare.

Un permesso SHALL SCADERE — oltre la scadenza le reti di sicurezza tornano ad
avere i denti, o un pannello dimenticato disarma il sistema per sempre. **Una
DOMANDA invece NON SHALL scadere**: chi risponde la mattina dopo la ritrova.

L'età dell'attesa SHALL essere quella della richiesta PIÙ VECCHIA: una richiesta
appena aperta NON SHALL rimettere a zero l'orologio di una vecchia, o l'esenzione
si riarma all'infinito.

Rilasciare SHALL chiudere ENTRAMBE le sorgenti: mezza porta chiusa lascia
qualcosa a interrogare a vuoto.

Con una sorgente sola presente SHALL comunque essere restituita quella; senza
nessuna, l'età SHALL essere assente e non un numero fantasma.

#### Scenario: pannello di permesso aperto
- **GIVEN** un permesso in attesa entro la scadenza
- **THEN** SHALL contare come persona in mezzo

#### Scenario: una domanda lasciata lì la sera
- **GIVEN** una domanda aperta da molte ore
- **THEN** SHALL contare ancora come attesa

### Requirement: HOLD-02 — L'inizio e la fine dell'attesa si ANNUNCIANO, e non si annuncia il nulla

Il passaggio in attesa e l'uscita dall'attesa SHALL essere ANNUNCIATI a chi
guarda, non lasciati da scoprire interrogando.

Una chiusura su una sessione che NON stava aspettando nessuno NON SHALL
annunciare niente: un rilascio fantasma rimette la scheda su «in corso» mentre
non lo è.

Con PIÙ pannelli aperti insieme SHALL esserci UN solo annuncio di attesa, e il
rilascio SHALL arrivare solo all'ULTIMO. La riga di comando emette più richieste
nello stesso messaggio — misurate a 170 ms di distanza — e tre annunci sarebbero
tre attese finte, mentre un rilascio anticipato direbbe «libero» con due pannelli
ancora a schermo.

Un turno INTERROTTO SHALL annunciare il rilascio, o la scheda resta ferma su
«aspetta te» per sempre. Anche una richiesta SCADUTA SHALL annunciarlo.

Un ascoltatore che fallisce NON SHALL impedire l'apertura del pannello: un
indicatore rotto non deve poter bloccare la cosa che indica.

#### Scenario: tre pannelli nello stesso messaggio
- **GIVEN** più richieste di permesso aperte insieme
- **THEN** SHALL esserci un solo annuncio di attesa, e il rilascio solo all'ultima chiusura

#### Scenario: chiusura di ciò che non aspettava
- **GIVEN** una chiusura su una sessione senza attese
- **THEN** NON SHALL essere annunciato niente

### Requirement: HOLD-03 — L'attesa umana si SOTTRAE dal tempo del turno

Il tempo passato ad aspettare una persona SHALL essere contato e SOTTRATTO dalla
durata attribuita al turno. Senza, un turno da otto secondi di lavoro finisce
archiviato come quarantatré minuti, e ogni misura costruita su quel numero mente.

Attese multiple nello stesso turno SHALL SOMMARSI; attese SOVRAPPOSTE SHALL
contare il tempo di ciascuna.

Riaprire un'attesa già aperta NON SHALL perderne l'inizio vero. Chiudere
un'attesa mai aperta NON SHALL inventare tempo. Chiudere due volte NON SHALL
contare due volte.

Un turno che finisce con un'attesa ANCORA APERTA SHALL vederla chiusa dalla
chiusura finale, e ripetere quella chiusura NON SHALL raddoppiare il totale.

Un orologio che va all'indietro SHALL dare ZERO, mai un pezzo negativo.

#### Scenario: due attese sovrapposte
- **GIVEN** due attese che si sovrappongono nel tempo
- **THEN** SHALL essere contato il tempo di ciascuna

#### Scenario: l'orologio torna indietro
- **GIVEN** una chiusura con un istante precedente all'apertura
- **THEN** il contributo SHALL essere zero

### Requirement: HOLD-04 — Lo stato «sta aspettando te» si legge da ciò che è SALVATO

Sapere se una chat sta aspettando una persona SHALL essere possibile leggendo lo
stato SALVATO, non la memoria del processo: dopo un riavvio la memoria non c'è
più, e la scheda direbbe «in corso» su qualcosa che aspetta da ore.

SHALL essere trovato sia nella forma vecchia sia in quella nuova: una chat che
porta la domanda solo nella timeline nuova non SHALL sfuggire.

Un'attesa senza istante dichiarato SHALL valere comunque come ATTESA, usando
l'ora che passa chi chiede — lo STATO non si perde per un istante mancante, e
l'istante non si inventa senza un ripiego esplicito.

Un contenuto illeggibile su una riga NON SHALL far fallire la lettura di tutte le
altre chat.

#### Scenario: la domanda vive solo nella forma nuova
- **GIVEN** una chat la cui attesa è registrata solo nella timeline nuova
- **THEN** SHALL essere riconosciuta come in attesa

#### Scenario: una riga corrotta
- **GIVEN** una riga con contenuto illeggibile
- **THEN** le altre chat SHALL essere lette lo stesso

### Requirement: HOLD-05 — Prima di riavviare si guarda in TRE posti, e il tetto scade davvero

Prima di riavviare, «c'è ancora lavoro in volo?» SHALL essere chiesto a TRE
sorgenti: le carte della board, le chat che stanno scrivendo IN QUESTO processo, e
i turni visibili SOLO al ponte. I due buchi storici sono esattamente due di
queste: una chat che scrive non era vista come una carta, e un turno adottato
dopo un riavvio è invisibile a entrambe.

Solo l'assenza in TUTTE E TRE SHALL autorizzare il riavvio. Elenchi vuoti NON
SHALL contare come «qualcosa in volo».

Quando più sorgenti trattengono insieme, SHALL essere nominata la più economica e
più certa: il registro non deve costare più della decisione.

Il TETTO d'attesa SHALL essere DIVERSO secondo cosa si aspetta: una chat su un
provider che sa RIADOTTARE il proprio turno può essere interrotta presto, perché
lo ritrova; una carta o un turno non riadottabile SHALL avere il tetto lungo.

**Il tetto SHALL scadere DAVVERO.** Calcolarlo come «adesso più il tetto» a ogni
giro lo rinnova all'infinito: un ciclo con lavoro sempre presente non arriva mai
a scadenza. Il confine SHALL essere INCLUSO — AL tetto si scade, non un giro
dopo.

La promessa di riadozione SHALL essere verificata come CHIAMABILE, non come
presente: un campo che esiste ma non si può chiamare non è una promessa. Un
provider assente non promette niente.

#### Scenario: un ciclo che non si svuota mai
- **GIVEN** lavoro presente a ogni verifica
- **THEN** il tetto SHALL comunque scadere

#### Scenario: chat riadottabile contro carta
- **GIVEN** una chat riadottabile e una carta, entrambe in volo
- **THEN** SHALL essere applicato un tetto diverso a ciascuna
