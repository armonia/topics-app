## Purpose

Le cose che tengono il server in piedi e non si vedono da nessuna schermata: la
serializzazione, la memoria che torna al sistema, la porta che qualcun altro ha
preso, e il modo di aspettare un processo senza pagarlo a turni.

## Background

TRE GUASTI MISURATI, TUTTI INVISIBILI DALL'INTERFACCIA.

Il 19/08/2026, con la segnalazione «1,8 GB», il server di produzione misurava
**936 MB di impronta, con un picco storico di 2,4 GB** — e un heap dichiarato di
**52 MB**. La memoria non era occupata dal programma: era stata scambiata su
disco e mai restituita.

Il 20/08/2026, sulla macchina di chi lo usa: il server di un ALTRO progetto,
avviato a mano sulla stessa porta, se l'era presa. **Per nove ore.** Rispondeva
200, quindi ogni controllo di raggiungibilità diceva che andava tutto bene.

E un difetto di forma che uccideva il processo: una promessa lasciata nella mappa
in stato di rifiuto senza nessuno che la gestisse. Sotto questo runtime un
rifiuto non gestito TERMINA il processo — quindi una funzione che falliva uccideva
il server.

## Requirements

### Requirement: RUNTIME-01 — Una promessa nella mappa non può MAI restare rifiutata senza gestore

La coda che serializza il lavoro per chiave NON SHALL mai conservare una promessa
in stato di rifiuto priva di gestore. Sotto questo runtime un rifiuto non gestito
TERMINA il processo: una funzione che fallisce uccideva il server.

L'errore SHALL comunque raggiungere CHI HA CHIAMATO — sopprimerlo per proteggere
il processo trasformerebbe un guasto rumoroso in uno silenzioso.

Dopo un fallimento la coda SHALL continuare a serializzare le chiavi successive.

Chiamate concorrenti sulla STESSA chiave SHALL essere strettamente serializzate;
chiavi DIVERSE SHALL poter procedere in parallelo.

La struttura interna SHALL essere liberata quando tutto il lavoro è concluso: una
coda che ricorda per sempre le chiavi già finite è una perdita che cresce con
l'uso.

La prova SHALL essere fatta in un PROCESSO FIGLIO che deve uscire con esito
zero: è l'unico modo di dimostrare che il processo non muore, perché un test che
gira nello stesso processo non può osservare la propria morte.

#### Scenario: una funzione che fallisce
- **GIVEN** un lavoro in coda che solleva
- **THEN** il processo SHALL restare vivo e l'errore SHALL arrivare al chiamante

#### Scenario: dopo il fallimento
- **GIVEN** una coda che ha appena visto fallire un lavoro
- **THEN** SHALL continuare a servire le chiavi successive

### Requirement: RUNTIME-02 — Una richiesta ripetuta si riconosce, e la memoria non cresce all'infinito

Una richiesta che modifica, RIPETUTA con la stessa chiave entro una finestra,
SHALL restituire il valore già prodotto invece di rifare il lavoro.

La finestra SHALL coprire qualunque ripetizione realistica, e il confine SHALL
essere INCLUSO: esattamente alla scadenza la voce vale ancora.

Una voce scaduta SHALL essere rimossa quando la si cerca, e la struttura SHALL
essere ripulita da sé quando cresce oltre una dimensione dichiarata — ma la
pulizia NON SHALL portare via le voci ancora valide.

Ricordare di nuovo la stessa chiave SHALL sovrascrivere il valore E rinnovare la
finestra.

Una chiave sconosciuta SHALL dare NIENTE, mai un valore.

#### Scenario: esattamente alla scadenza
- **GIVEN** una voce la cui finestra scade in questo istante
- **THEN** SHALL valere ancora

#### Scenario: la mappa cresce
- **GIVEN** più voci del limite dichiarato
- **THEN** le scadute SHALL essere rimosse e le valide SHALL restare

### Requirement: RUNTIME-03 — La memoria si restituisce quando la macchina è ferma, e mai alla cieca

La restituzione della memoria al sistema SHALL essere tentata periodicamente, e
SOLO quando l'impronta supera una soglia dichiarata. Sotto soglia NON SHALL essere
pagata nessuna pausa: una pausa gratuita è puro costo.

La soglia SHALL tenere conto di quanto occupa un server appena partito, e il
confine SHALL essere INCLUSO.

L'operazione NON SHALL fermare il sistema mentre una CARTA della board sta
lavorando. SHALL invece poter procedere mentre una chat sta scrivendo: la pausa
misurata è di pochi millisecondi, e vietarlo su ogni stream significherebbe non
farlo MAI su una macchina dove uno stream è quasi sempre aperto.

NON SHALL procedere per un turno che vive solo nel ponte: quello è un turno
adottato, e tagliarlo è esattamente il danno che si vuole evitare.

Un'impronta ILLEGGIBILE SHALL far saltare il giro, non raccogliere alla cieca:
senza misura non si sa se serviva né se è servito.

L'impronta SHALL essere riletta DOPO che il sistema ha ripreso le pagine, o il
registro riporta «zero recuperati» su un recupero che invece c'è stato.

SHALL essere registrato solo un recupero VISIBILE: una riga ogni pochi minuti che
dice «niente» è rumore che seppellisce le righe che contano.

#### Scenario: una carta al lavoro
- **GIVEN** una carta della board in lavorazione
- **THEN** NON SHALL essere fermato il sistema

#### Scenario: impronta illeggibile
- **GIVEN** una misura dell'impronta non disponibile
- **THEN** il giro SHALL essere saltato

### Requirement: RUNTIME-04 — Chi risponde sulla nostra porta si riconosce dalla FORMA, non dal codice

Il sistema SHALL verificare che chi risponde sulla propria porta sia sé stesso, e
il riconoscimento SHALL essere sulla FORMA della risposta, non sul codice di
stato. Un intruso che risponde 200 supera ogni controllo di raggiungibilità: è
esattamente quello che è successo per nove ore.

Un contenuto valido ma di un altro programma NON SHALL passare.

NESSUNO che risponde NON SHALL essere un allarme: è lo stato normale prima
dell'avvio.

Il sistema NON SHALL accusare SÉ STESSO quando il processo trovato è il proprio.

Un intruso che non si riesce a identificare SHALL essere comunque DENUNCIATO: non
sapere chi è non è una ragione per tacere.

Una sonda che FALLISCE NON SHALL diventare un allarme: un errore di rete non è
un'invasione.

SHALL essere interrogata la rotta più economica sull'indirizzo locale, provando
prima il protocollo cifrato e ripiegando sull'altro — o un server che parla solo
in chiaro viene letto come «silenzio».

#### Scenario: un altro programma che risponde 200
- **GIVEN** un server estraneo sulla stessa porta che risponde correttamente
- **THEN** SHALL essere denunciato

#### Scenario: nessuno in ascolto
- **GIVEN** nessuna risposta sulla porta
- **THEN** NON SHALL essere emesso nessun allarme

### Requirement: RUNTIME-05 — Aspettare un processo si paga una volta, non a turni

Un agente SHALL poter ASPETTARE la fine di un processo, o una riga che compare
nella sua uscita, invece di richiedere l'uscita a ripetizione. Ogni richiesta
ripetuta è un turno del modello, e un turno costa contesto.

Il tempo massimo di attesa SHALL avere un TETTO, e il tetto SHALL stare SOTTO
quello del trasporto che lo porta: superarlo significa che a scadere è il canale,
non l'attesa, e il chiamante non riceve niente. Un valore inutilizzabile SHALL
dare il valore predefinito, mai zero, e SHALL essere accettato anche come testo —
è così che arriva da una richiesta.

Il confronto con la riga attesa SHALL ignorare le maiuscole, e SHALL considerare
anche la riga PARZIALE non ancora terminata: l'ultima riga è spesso proprio
quella che porta l'errore. Un'espressione malformata SHALL dare un errore
LEGGIBILE, non un'eccezione grezza.

La condizione di uscita SHALL poter fermare l'attesa su un processo ANCORA VIVO.

**Scadere NON SHALL essere fallire**: SHALL essere un esito valido, con il punto
a cui si era arrivati, così che l'attesa possa riprendere da lì.

Le righe perse dal contenitore circolare SHALL essere SOMMATE lungo tutta
l'attesa: un conteggio che riparte a ogni giro dice il falso.

Un processo GIÀ finito NON SHALL far aspettare nessuno.

Un'attesa aperta SHALL essere visibile sul PROPRIO processo e solo su quello; due
attese sullo stesso processo SHALL contare entrambe; chiudere due volte NON SHALL
portare via l'attesa di qualcun altro.

#### Scenario: la riga arriva senza a-capo
- **GIVEN** l'uscita che termina con una riga parziale che contiene ciò che si aspetta
- **THEN** SHALL contare come corrispondenza

#### Scenario: l'attesa scade
- **GIVEN** un'attesa che raggiunge il proprio tetto
- **THEN** SHALL essere un esito valido con il punto raggiunto, non un errore
