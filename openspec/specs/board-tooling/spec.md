## Purpose

Gli strumenti che misurano e sorvegliano la bacheca: il banco che confronta il
lavoro dispacciato con quello fatto in chat, e il sorvegliante che dice quando
qualcosa si è incastrato.

## Background

UN BANCO CHE NON PUÒ DIVENTARE ROSSO NON MISURA NIENTE. Tre trappole, tutte
presenti: una prova che cerca l'ASSENZA di qualcosa dentro un elenco che si
accorcia da solo; un filtro che non seleziona nessun caso; e una REPLICA di
testo ricopiato da un sorgente privato, che smette di somigliare all'originale
senza che niente diventi rosso.

E UN SORVEGLIANTE CHE NON SA DIRE DI NO VIENE IGNORATO IN UN POMERIGGIO. Il
falso allarme è il difetto più probabile di un controllo proattivo, ed è quello
che nessun banco trova se si prova solo il caso che scatta.

## Requirements

### Requirement: BENCH-01 — La replica dell'envelope si àncora al sorgente VERO, e i cache-read restano fuori dal lavoro

La replica del messaggio di apertura usata dal banco è testo RICOPIATO da una
funzione privata: le sue frasi-ancora SHALL essere cercate nel SORGENTE vero. Se
l'originale cambia frase, la replica misura un messaggio che non esiste più, e il
numero di quel braccio diventa una finzione senza che niente diventi rosso.

Il conteggio del LAVORO SHALL comprendere ingresso, uscita e scrittura in
memoria, e SHALL LASCIARE FUORI le riletture dalla memoria. Sommarle «per
comodità» gonfia il totale di circa due volte e mezzo, e il confronto mente.

#### Scenario: il messaggio di apertura cambia frase
- **GIVEN** una frase-ancora non più presente nel sorgente
- **THEN** il banco SHALL fallire

#### Scenario: le riletture dalla memoria
- **GIVEN** un consumo che le comprende
- **THEN** NON SHALL entrare nel conteggio del lavoro

### Requirement: BENCH-02 — La statistica si verifica su valori calcolati A MANO

Le funzioni statistiche del confronto SHALL essere verificate contro valori
calcolati a mano, non contro sé stesse. Una mediana sbagliata o un intervallo
che si stringe da solo cambiano la CONCLUSIONE del confronto senza che nessuno se
ne accorga — ed è l'unico modo in cui un banco statistico può mentire restando
verde.

SHALL esistere un numero MINIMO di osservazioni sotto il quale una statistica di
costo NON SHALL essere dichiarata: una mediana su due campioni non è una
mediana.

Il confronto SHALL portare con sé un TIMBRO DI COMPARABILITÀ: due misure prese in
condizioni diverse non si sottraggono.

#### Scenario: troppo pochi campioni
- **GIVEN** meno osservazioni del minimo
- **THEN** la statistica NON SHALL essere dichiarata

#### Scenario: una mediana
- **GIVEN** un insieme di valori noti
- **THEN** il risultato SHALL coincidere col valore calcolato a mano

### Requirement: BENCH-03 — Le prove della matrice DEVONO poter diventare rosse

Una matrice di casi limite SHALL essere FALSIFICABILE, e le tre trappole che la
rendono un verde eterno SHALL essere pinzate da un banco proprio:

Un'asserzione che verifica l'ASSENZA di qualcosa dentro un elenco che si accorcia
da solo SHALL essere riconosciuta come tale: quando l'elenco si svuota
l'asserzione passa sempre.

Un filtro di selezione che NON seleziona NESSUN caso SHALL essere un errore, non
un successo con zero esecuzioni.

Un caso che nessuno esegue NON SHALL contare come superato.

#### Scenario: un filtro che non seleziona niente
- **GIVEN** un filtro senza corrispondenze
- **THEN** SHALL essere un errore

#### Scenario: un elenco che si è svuotato
- **GIVEN** un'asserzione di assenza su un elenco vuoto
- **THEN** NON SHALL contare come prova

### Requirement: BENCH-04 — Il confronto a bracci dichiara costo, azioni e fallimenti

Il confronto fra i modi di lavorare SHALL produrre, per ogni coppia, il COSTO
esatto e quello a fascia, le AZIONI PER CICLO, e l'elenco dei FALLIMENTI —
raccolti, non nascosti dietro una media.

L'aggregazione SHALL essere separata dalla valutazione del singolo caso: un
caso che non è stato valutato NON SHALL entrare nell'aggregato come se fosse
riuscito.

La VARIANZA fra i bracci SHALL essere letta e dichiarata: due bracci con la
stessa media e varianze diverse non sono la stessa cosa.

#### Scenario: un caso fallito
- **GIVEN** un caso che non è arrivato a termine
- **THEN** SHALL comparire fra i fallimenti, non nell'aggregato

#### Scenario: due bracci con la stessa media
- **GIVEN** varianze diverse
- **THEN** SHALL essere dichiarate

### Requirement: DOCTOR-01 — Per OGNI controllo, un caso che scatta E uno che NON scatta

Per OGNI controllo del sorvegliante SHALL esistere un caso che fa scattare il
rilievo E un caso che NON lo fa. La forma vale più dei singoli casi: un controllo
provato solo sul caso che scatta è un controllo che non sa dire di no, e un
sorvegliante che non sa dire di no viene ignorato in un pomeriggio.

Il caso che NON scatta SHALL essere costruito, dove è possibile, cambiando UN
SOLO campo rispetto a quello che scatta: così il banco dimostra che il rilievo
dipende DAVVERO da quel fatto e non da un dettaglio della finzione di prova.

#### Scenario: un controllo nuovo
- **GIVEN** un controllo con il solo caso positivo
- **THEN** SHALL essere considerato incompleto

#### Scenario: un campo solo di differenza
- **GIVEN** il caso negativo costruito cambiando un campo
- **THEN** il rilievo NON SHALL scattare

### Requirement: DOCTOR-02 — La sonda sa contare CINQUE e sa contare ZERO

Una sonda di anomalia SHALL essere provata su DUE istanti della stessa realtà:
quello in cui l'anomalia c'è, con il numero esatto, e quello dopo che è stata
risolta, con zero.

Una sonda che non sa tornare a ZERO è un allarme rotto: continuerebbe a suonare
su una cosa già sistemata, e verrebbe spenta. Una che non sa SALIRE al numero
giusto non è una sonda.

#### Scenario: l'anomalia risolta
- **GIVEN** lo stato dopo la correzione
- **THEN** la sonda SHALL restituire zero

#### Scenario: l'anomalia presente
- **GIVEN** lo stato in cui l'anomalia c'era
- **THEN** la sonda SHALL restituire il numero esatto
